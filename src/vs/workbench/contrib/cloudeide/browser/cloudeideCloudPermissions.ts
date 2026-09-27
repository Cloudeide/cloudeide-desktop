/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the agent may do in Cloud without asking.
 *
 * Three starting points, because nobody wants to fill in a table before their
 * first deploy: Careful asks before anything that deploys, Balanced lets
 * previews go and asks before production, Autopilot ships on its own within
 * the hourly limit. Any single action can then be set apart from its preset.
 *
 * Some rows do not move. Reading is always allowed — it changes nothing.
 * A variable's value is always typed by a person, whatever the preset,
 * because the whole point is that the model never has it. And deleting a
 * project is not a tool at all.
 *
 * Nothing here touches the workbench, so the rules are tested directly.
 */

export type CloudPreset = 'careful' | 'balanced' | 'autopilot';
export type CloudDecision = 'allow' | 'ask' | 'never';

export type CloudAction =
	| 'deploy.development'
	| 'deploy.preview'
	| 'deploy.production'
	| 'rollback'
	| 'cancel'
	| 'env.set'
	| 'domain.add'
	| 'domain.primary'
	| 'domain.remove';

export const CLOUD_ACTIONS: readonly CloudAction[] = [
	'deploy.development', 'deploy.preview', 'deploy.production', 'rollback', 'cancel',
	'env.set', 'domain.add', 'domain.primary', 'domain.remove',
];

export const CLOUD_PRESETS: readonly CloudPreset[] = ['careful', 'balanced', 'autopilot'];

export const DEFAULT_PRESET: CloudPreset = 'balanced';

const MATRIX: Record<CloudPreset, Record<CloudAction, CloudDecision>> = {
	careful: {
		'deploy.development': 'ask',
		'deploy.preview': 'ask',
		'deploy.production': 'ask',
		'rollback': 'ask',
		'cancel': 'ask',
		'env.set': 'ask',
		'domain.add': 'ask',
		'domain.primary': 'ask',
		'domain.remove': 'never',
	},
	balanced: {
		'deploy.development': 'allow',
		'deploy.preview': 'allow',
		'deploy.production': 'ask',
		'rollback': 'ask',
		'cancel': 'allow',
		'env.set': 'ask',
		'domain.add': 'ask',
		'domain.primary': 'ask',
		'domain.remove': 'ask',
	},
	autopilot: {
		'deploy.development': 'allow',
		'deploy.preview': 'allow',
		'deploy.production': 'allow',
		'rollback': 'allow',
		'cancel': 'allow',
		'env.set': 'ask',
		'domain.add': 'allow',
		'domain.primary': 'allow',
		'domain.remove': 'ask',
	},
};

/** Rows no preset or override can change. */
const FIXED: Partial<Record<CloudAction, CloudDecision>> = {
	// The person types the value; there is nothing to allow on their behalf.
	'env.set': 'ask',
};

export function presetOf(raw: unknown): CloudPreset {
	return typeof raw === 'string' && (CLOUD_PRESETS as readonly string[]).includes(raw) ? raw as CloudPreset : DEFAULT_PRESET;
}

/**
 * The decision for one action: its fixed rule if it has one, else the
 * person's override for it, else the preset's.
 */
export function decide(action: CloudAction, preset: CloudPreset, overrides?: Readonly<Record<string, unknown>>): CloudDecision {
	const fixed = FIXED[action];
	if (fixed) {
		return fixed;
	}
	const override = overrides?.[action];
	if (override === 'allow' || override === 'ask' || override === 'never') {
		return override;
	}
	return MATRIX[preset][action];
}

/** Which action a Cloud tool call is, or undefined for one that only reads. */
export function actionFor(toolName: string, input: Readonly<Record<string, unknown>>): CloudAction | undefined {
	switch (toolName) {
		case 'cloud_deploy': {
			const env = input.environment;
			return env === 'production' ? 'deploy.production' : env === 'preview' ? 'deploy.preview' : 'deploy.development';
		}
		case 'cloud_rollback': return 'rollback';
		case 'cloud_cancel': return 'cancel';
		case 'cloud_env_set': return 'env.set';
		case 'cloud_domain_add': return 'domain.add';
		case 'cloud_domain_primary': return 'domain.primary';
		case 'cloud_domain_remove': return 'domain.remove';
		default: return undefined;
	}
}

const LABELS: Record<CloudAction, string> = {
	'deploy.development': 'deploy to development',
	'deploy.preview': 'deploy to preview',
	'deploy.production': 'deploy to production',
	'rollback': 'roll back',
	'cancel': 'cancel a deployment',
	'env.set': 'set an environment variable (the person types the value)',
	'domain.add': 'add a domain',
	'domain.primary': 'change the primary domain',
	'domain.remove': 'remove a domain',
};

export function actionLabel(action: CloudAction): string {
	return LABELS[action];
}

/** The rules as the model is told them, one line each way. */
export function describeForModel(preset: CloudPreset, overrides?: Readonly<Record<string, unknown>>, maxDeploysPerHour?: number): string {
	const by: Record<CloudDecision, string[]> = { allow: [], ask: [], never: [] };
	for (const action of CLOUD_ACTIONS) {
		by[decide(action, preset, overrides)].push(LABELS[action]);
	}
	const lines = [`The person's Cloud permissions are "${preset}".`];
	if (by.allow.length) {
		lines.push(`You may, without asking: ${by.allow.join(', ')}.`);
	}
	if (by.ask.length) {
		lines.push(`The person is asked first before you: ${by.ask.join(', ')}. The tool asks; do not ask again in the conversation.`);
	}
	if (by.never.length) {
		lines.push(`You may not: ${by.never.join(', ')}. If it is needed, say so and tell the person to do it in Cloud.`);
	}
	if (maxDeploysPerHour) {
		lines.push(`At most ${maxDeploysPerHour} deploys an hour.`);
	}
	return lines.join(' ');
}

// ---- what happened, by whom -----------------------------------------------------

export type CloudActor = 'agent' | 'you';

export interface CloudActivity {
	/** Milliseconds since the epoch. */
	readonly at: number;
	readonly by: CloudActor;
	readonly kind: 'deploy' | 'rollback' | 'cancel' | 'env' | 'domain';
	readonly summary: string;
	readonly deploymentId?: string;
}

/**
 * Recent activity, as the model reads it: newest last, times as the person
 * sees them, and who did it. So "I deployed it from Cloud a minute ago" is
 * something the agent already knows rather than something it has to be told.
 */
export function formatActivity(items: readonly CloudActivity[], now: number, max = 12): string {
	if (!items.length) {
		return '';
	}
	const ago = (at: number) => {
		const m = Math.round((now - at) / 60000);
		return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
	};
	return items.slice(-max).map(a => `- ${ago(a.at)}, ${a.by === 'agent' ? 'you (the agent)' : 'the person'}: ${a.summary}`).join('\n');
}

/** How many deploys the agent started in the last hour. */
export function agentDeploysInLastHour(items: readonly CloudActivity[], now: number): number {
	return items.filter(a => a.by === 'agent' && a.kind === 'deploy' && now - a.at < 3600_000).length;
}
