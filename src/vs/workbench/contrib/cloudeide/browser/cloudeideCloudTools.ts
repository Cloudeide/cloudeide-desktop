/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cloud, for the agent.
 *
 * Everything the Cloud tab can do — deploy, read what is live, read a build's
 * log, roll back, cancel, set variables, put a domain in front — offered to
 * the agent as tools in the chat panel. The server has had every one of these
 * endpoints since the web dashboard needed them; what the agent lacked was a
 * way to reach them, so "ship it" ended at "open Cloud and press Deploy".
 *
 * They go through the chat's tool service like every other tool, so each call
 * is drawn in the conversation, and the ones that change what the public sees
 * — production, rollback, domains — ask first. A secret is never typed into
 * the conversation: the agent names the variable, and the person types the
 * value into a box whose contents go to the server and nowhere else.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import {
	CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl,
	IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress,
} from '../../chat/common/tools/languageModelToolsService.js';
import {
	DEPLOY_IN_PROGRESS, DeployDomain, DeployEnvironment, DeploymentDetail, DeploymentSummary,
	EnvironmentState, EnvVarSummary, SiteAnalytics,
} from './cloudeideClient.js';
import { actionFor, actionLabel } from './cloudeideCloudPermissions.js';
import { ICloudeideCloudService, OVERRIDES_SETTING, PERMISSIONS_SETTING } from './cloudeideCloudService.js';

const ENVIRONMENTS: readonly DeployEnvironment[] = ['development', 'preview', 'production'];

/** How much of a build log goes back to the model. The end is where the error is. */
const LOG_TAIL_LINES = 150;

// ---- the tools --------------------------------------------------------------

interface CloudToolSpec {
	readonly name: string;
	readonly displayName: string;
	readonly description: string;
	readonly properties: Record<string, unknown>;
	readonly required?: readonly string[];
	/** Changes nothing, so Ask may use it. */
	readonly readOnly?: boolean;
	readonly icon: ThemeIcon;
}

const ENV_SCHEMA = { type: 'string', enum: ENVIRONMENTS, description: 'development (a throwaway URL), preview (a shareable URL) or production (the live site).' };

export const CLOUD_TOOLS: readonly CloudToolSpec[] = [
	{
		name: 'cloud_status',
		displayName: localize('cloudeide.cloudTool.status', "Cloud Status"),
		description: 'What is live right now: for each environment (development, preview, production), its address and its latest deployment with status. Start here before deploying or when asked what is live.',
		properties: {},
		readOnly: true,
		icon: Codicon.cloud,
	},
	{
		name: 'cloud_deployments',
		displayName: localize('cloudeide.cloudTool.deployments', "List Deployments"),
		description: 'Recent deployments of this project, newest first: id, environment, status, when, and the error summary of any that failed. Use it to find a deployment to roll back to or to read the log of.',
		properties: { limit: { type: 'number', description: 'How many. Default 10, at most 30.' } },
		readOnly: true,
		icon: Codicon.history,
	},
	{
		name: 'cloud_logs',
		displayName: localize('cloudeide.cloudTool.logs', "Read Build Log"),
		description: 'The build log of one deployment: its status, the phase that failed, the error summary, and the end of the log. Omit the id for the most recent deployment. After a failed deploy, read this, fix the cause in the code, and deploy again.',
		properties: { deploymentId: { type: 'string', description: 'Which deployment. Omit for the most recent.' } },
		readOnly: true,
		icon: Codicon.output,
	},
	{
		name: 'cloud_deploy',
		displayName: localize('cloudeide.cloudTool.deploy', "Deploy"),
		description: 'Build the open folder and publish it to an environment, then wait for it to finish and report the live address, or the error and the end of the log if it failed. Unsaved files are saved first. Deploy to preview and check it before production. Production asks the person first.',
		properties: {
			environment: ENV_SCHEMA,
			message: { type: 'string', description: 'One line saying what this deploy contains, like a commit message.' },
		},
		required: ['environment'],
		icon: Codicon.rocket,
	},
	{
		name: 'cloud_cancel',
		displayName: localize('cloudeide.cloudTool.cancel', "Cancel Deployment"),
		description: 'Stop a deployment that is still building. What is live stays live.',
		properties: { deploymentId: { type: 'string' } },
		required: ['deploymentId'],
		icon: Codicon.debugStop,
	},
	{
		name: 'cloud_rollback',
		displayName: localize('cloudeide.cloudTool.rollback', "Roll Back"),
		description: 'Put an earlier successful deployment back live in its environment. Use cloud_deployments to find it. Asks the person first.',
		properties: { deploymentId: { type: 'string', description: 'The deployment to put back.' } },
		required: ['deploymentId'],
		icon: Codicon.discard,
	},
	{
		name: 'cloud_env_list',
		displayName: localize('cloudeide.cloudTool.envList', "List Environment Variables"),
		description: 'The environment variables the project has: names, which environments each applies to, and whether it is secret. Values are never shown to you.',
		properties: {},
		readOnly: true,
		icon: Codicon.symbolVariable,
	},
	{
		name: 'cloud_env_set',
		displayName: localize('cloudeide.cloudTool.envSet', "Set Environment Variable"),
		description: 'Create or change an environment variable. You give the name and where it applies; the person types the value into a box you cannot read, and it goes straight to the server. Never ask for a secret value in the conversation, and never put one in code — use this. Variables are applied at build time, so deploy again afterwards.',
		properties: {
			key: { type: 'string', description: 'The name, e.g. STRIPE_PUBLIC_KEY. Letters, digits and underscores.' },
			environments: { type: 'array', items: ENV_SCHEMA, description: 'Where it applies.' },
			secret: { type: 'boolean', description: 'Hide it in the dashboard too. Default true.' },
			reason: { type: 'string', description: 'One line the person reads, saying what the value is and where to find it.' },
		},
		required: ['key', 'environments', 'reason'],
		icon: Codicon.key,
	},
	{
		name: 'cloud_domains',
		displayName: localize('cloudeide.cloudTool.domains', "List Domains"),
		description: 'The domains on this project: hostname, environment, whether DNS is verified, and which is primary.',
		properties: {},
		readOnly: true,
		icon: Codicon.globe,
	},
	{
		name: 'cloud_domain_add',
		displayName: localize('cloudeide.cloudTool.domainAdd', "Add Domain"),
		description: 'Put a domain the person owns in front of an environment. Reports the DNS record they must add where they bought the domain. Asks the person first.',
		properties: { hostname: { type: 'string', description: 'e.g. shop.example.com' }, environment: ENV_SCHEMA },
		required: ['hostname', 'environment'],
		icon: Codicon.add,
	},
	{
		name: 'cloud_domain_check',
		displayName: localize('cloudeide.cloudTool.domainCheck', "Check Domain"),
		description: 'Ask now whether a domain\'s DNS record has taken effect. Reports verified, or pending with the record still to add.',
		properties: { hostname: { type: 'string' } },
		required: ['hostname'],
		readOnly: true,
		icon: Codicon.refresh,
	},
	{
		name: 'cloud_domain_primary',
		displayName: localize('cloudeide.cloudTool.domainPrimary', "Make Domain Primary"),
		description: 'Send visitors to this domain by default. It must be verified. Asks the person first.',
		properties: { hostname: { type: 'string' } },
		required: ['hostname'],
		icon: Codicon.star,
	},
	{
		name: 'cloud_domain_remove',
		displayName: localize('cloudeide.cloudTool.domainRemove', "Remove Domain"),
		description: 'Take a domain off the project; the site stops answering on it. Asks the person first.',
		properties: { hostname: { type: 'string' } },
		required: ['hostname'],
		icon: Codicon.trash,
	},
	{
		name: 'cloud_analytics',
		displayName: localize('cloudeide.cloudTool.analytics', "Site Traffic"),
		description: 'Traffic on an environment\'s live site: requests, bandwidth, and the 4xx and 5xx error rates. Use it after a deploy to see whether the release is healthy.',
		properties: { environment: ENV_SCHEMA },
		required: ['environment'],
		readOnly: true,
		icon: Codicon.graph,
	},
];

/** The Cloud tools that change nothing, which Ask may use. */
export const CLOUD_READ_TOOL_NAMES: readonly string[] = CLOUD_TOOLS.filter(t => t.readOnly).map(t => t.name);

// ---- what the model reads -----------------------------------------------------

function when(iso: string | undefined): string {
	return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : 'unknown time';
}

export function formatEnvironments(states: readonly EnvironmentState[]): string {
	if (!states.length) {
		return 'Nothing has been deployed from this project yet.';
	}
	return states.map(s => {
		const d = s.latestDeployment;
		const latest = d
			? `latest ${d.id}: ${d.status}${d.errorSummary ? ` (${d.errorSummary})` : ''}, ${when(d.createdAt)}`
			: 'never deployed';
		return `${s.environment}: ${s.liveUrl ?? 'no live address'} · ${latest}`;
	}).join('\n');
}

export function formatDeployments(list: readonly DeploymentSummary[]): string {
	if (!list.length) {
		return 'No deployments yet.';
	}
	return list.map(d =>
		`${d.id} · ${d.environment} · ${d.status} · ${when(d.createdAt)}${d.liveUrl ? ` · ${d.liveUrl}` : ''}${d.errorSummary ? ` · error: ${d.errorSummary}` : ''}`,
	).join('\n');
}

export function formatDeployment(d: DeploymentDetail, tail = LOG_TAIL_LINES): string {
	const head = [
		`Deployment ${d.id}${d.environment ? ` to ${d.environment}` : ''}: ${d.status}`,
		d.liveUrl ? `Live at ${d.liveUrl}` : undefined,
		d.failedPhase ? `Failed in: ${d.failedPhase}` : undefined,
		d.errorSummary ? `Error: ${d.errorSummary}` : undefined,
		d.durationSeconds !== undefined ? `Took ${d.durationSeconds}s` : undefined,
	].filter(Boolean);
	const lines = d.logs ?? [];
	if (!lines.length) {
		return head.join('\n');
	}
	const shown = lines.slice(-tail);
	const cut = lines.length > shown.length ? `(${lines.length - shown.length} earlier lines not shown)\n` : '';
	const log = shown.map(l => (l.level === 'error' ? `ERROR ${l.text}` : l.level === 'warn' ? `WARN ${l.text}` : l.text)).join('\n');
	return `${head.join('\n')}\n\nLog:\n${cut}${log}`;
}

export function formatEnvVars(vars: readonly EnvVarSummary[]): string {
	if (!vars.length) {
		return 'The project has no environment variables.';
	}
	return vars.map(v => `${v.key} · ${v.environments.join(', ') || 'no environment'}${v.secret ? ' · secret' : ''}`).join('\n');
}

export function formatDomains(domains: readonly DeployDomain[]): string {
	if (!domains.length) {
		return 'No domains yet.';
	}
	return domains.map(d => `${d.hostname} · ${d.environment} · ${d.status}${d.primary ? ' · primary' : ''}`).join('\n');
}

export function formatAnalytics(environment: string, a: SiteAnalytics): string {
	if (!a.hasDeployed) {
		return `${environment} has not been deployed yet, so it has no traffic.`;
	}
	const t = a.totals;
	return `${environment}: ${t.totalRequests} requests, ${(t.bandwidthBytes / 1_000_000).toFixed(1)} MB, 4xx ${t.errorRate4xxPct.toFixed(2)}%, 5xx ${t.errorRate5xxPct.toFixed(2)}%`;
}

/**
 * What the question says, for a call the permissions say must ask.
 *
 * Whether to ask at all is the permissions' decision (Careful, Balanced,
 * Autopilot); this is only the wording. Setting a variable has no separate
 * question: the box the person types the value into is the question.
 */
export function confirmationFor(name: string, input: Record<string, unknown>): { title: string; message: string } | undefined {
	const s = (k: string) => (typeof input[k] === 'string' ? input[k] as string : '');
	switch (name) {
		case 'cloud_deploy':
			return s('environment') === 'production'
				? {
					title: localize('cloudeide.cloudTool.confirmProd', "Deploy to production?"),
					message: s('message')
						? localize('cloudeide.cloudTool.confirmProdMsg', "Builds the open folder and puts it on the live site: {0}", s('message'))
						: localize('cloudeide.cloudTool.confirmProdPlain', "Builds the open folder and puts it on the live site."),
				}
				: {
					title: localize('cloudeide.cloudTool.confirmDeploy', "Deploy to {0}?", s('environment') || 'development'),
					message: s('message')
						? localize('cloudeide.cloudTool.confirmDeployMsg', "Builds the open folder and publishes it: {0}", s('message'))
						: localize('cloudeide.cloudTool.confirmDeployPlain', "Builds the open folder and publishes it."),
				};
		case 'cloud_cancel':
			return {
				title: localize('cloudeide.cloudTool.confirmCancel', "Cancel {0}?", s('deploymentId')),
				message: localize('cloudeide.cloudTool.confirmCancelMsg', "Stops the build. What is live stays live."),
			};
		case 'cloud_rollback':
			return {
				title: localize('cloudeide.cloudTool.confirmRollback', "Roll back to {0}?", s('deploymentId')),
				message: localize('cloudeide.cloudTool.confirmRollbackMsg', "Puts that deployment back live in its environment."),
			};
		case 'cloud_domain_add':
			return {
				title: localize('cloudeide.cloudTool.confirmDomainAdd', "Add {0}?", s('hostname')),
				message: localize('cloudeide.cloudTool.confirmDomainAddMsg', "Points it at {0}. You will need to add a DNS record where you bought the domain.", s('environment')),
			};
		case 'cloud_domain_primary':
			return {
				title: localize('cloudeide.cloudTool.confirmPrimary', "Make {0} the primary domain?", s('hostname')),
				message: localize('cloudeide.cloudTool.confirmPrimaryMsg', "Visitors are sent there by default."),
			};
		case 'cloud_domain_remove':
			return {
				title: localize('cloudeide.cloudTool.confirmRemove', "Remove {0}?", s('hostname')),
				message: localize('cloudeide.cloudTool.confirmRemoveMsg', "The site stops answering on this name. The deployment itself is untouched."),
			};
		default:
			return undefined;
	}
}

function describe(name: string, input: Record<string, unknown>): Pick<IPreparedToolInvocation, 'invocationMessage' | 'pastTenseMessage'> {
	const s = (k: string) => (typeof input[k] === 'string' ? input[k] as string : '');
	switch (name) {
		case 'cloud_status': return { invocationMessage: localize('cloudeide.cloudTool.statusing', "Checking what is live"), pastTenseMessage: localize('cloudeide.cloudTool.statused', "Checked what is live") };
		case 'cloud_deployments': return { invocationMessage: localize('cloudeide.cloudTool.listing', "Reading recent deployments"), pastTenseMessage: localize('cloudeide.cloudTool.listed', "Read recent deployments") };
		case 'cloud_logs': return { invocationMessage: localize('cloudeide.cloudTool.logging', "Reading the build log"), pastTenseMessage: localize('cloudeide.cloudTool.logged', "Read the build log") };
		case 'cloud_deploy': return { invocationMessage: localize('cloudeide.cloudTool.deploying', "Deploying to {0}", s('environment')), pastTenseMessage: localize('cloudeide.cloudTool.deployed', "Deployed to {0}", s('environment')) };
		case 'cloud_cancel': return { invocationMessage: localize('cloudeide.cloudTool.canceling', "Cancelling {0}", s('deploymentId')), pastTenseMessage: localize('cloudeide.cloudTool.canceled', "Cancelled {0}", s('deploymentId')) };
		case 'cloud_rollback': return { invocationMessage: localize('cloudeide.cloudTool.rollingBack', "Rolling back to {0}", s('deploymentId')), pastTenseMessage: localize('cloudeide.cloudTool.rolledBack', "Rolled back to {0}", s('deploymentId')) };
		case 'cloud_env_list': return { invocationMessage: localize('cloudeide.cloudTool.envListing', "Reading environment variables"), pastTenseMessage: localize('cloudeide.cloudTool.envListed', "Read environment variables") };
		case 'cloud_env_set': return { invocationMessage: localize('cloudeide.cloudTool.envSetting', "Asking you for {0}", s('key')), pastTenseMessage: localize('cloudeide.cloudTool.envSetDone', "Set {0}", s('key')) };
		case 'cloud_domains': return { invocationMessage: localize('cloudeide.cloudTool.domainsing', "Reading domains"), pastTenseMessage: localize('cloudeide.cloudTool.domainsed', "Read domains") };
		case 'cloud_domain_add': return { invocationMessage: localize('cloudeide.cloudTool.adding', "Adding {0}", s('hostname')), pastTenseMessage: localize('cloudeide.cloudTool.added', "Added {0}", s('hostname')) };
		case 'cloud_domain_check': return { invocationMessage: localize('cloudeide.cloudTool.checking', "Checking DNS for {0}", s('hostname')), pastTenseMessage: localize('cloudeide.cloudTool.checked', "Checked DNS for {0}", s('hostname')) };
		case 'cloud_domain_primary': return { invocationMessage: localize('cloudeide.cloudTool.primarying', "Making {0} primary", s('hostname')), pastTenseMessage: localize('cloudeide.cloudTool.primaried', "Made {0} primary", s('hostname')) };
		case 'cloud_domain_remove': return { invocationMessage: localize('cloudeide.cloudTool.removing', "Removing {0}", s('hostname')), pastTenseMessage: localize('cloudeide.cloudTool.removed', "Removed {0}", s('hostname')) };
		case 'cloud_analytics': return { invocationMessage: localize('cloudeide.cloudTool.traffic', "Reading traffic on {0}", s('environment')), pastTenseMessage: localize('cloudeide.cloudTool.trafficked', "Read traffic on {0}", s('environment')) };
		default: return {};
	}
}

function environmentOf(raw: unknown): DeployEnvironment {
	if (typeof raw === 'string' && (ENVIRONMENTS as readonly string[]).includes(raw)) {
		return raw as DeployEnvironment;
	}
	throw new Error('`environment` must be development, preview or production.');
}

// ---- the contribution -----------------------------------------------------------

export class CloudeideCloudToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideCloudTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@ICloudeideCloudService private readonly cloud: ICloudeideCloudService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();

		for (const spec of CLOUD_TOOLS) {
			const data: IToolData = {
				id: spec.name,
				toolReferenceName: spec.name,
				displayName: spec.displayName,
				userDescription: spec.displayName,
				modelDescription: spec.description,
				inputSchema: { type: 'object', properties: spec.properties as never, ...(spec.required ? { required: [...spec.required] } : {}) },
				source: ToolDataSource.Internal,
				icon: spec.icon,
				canBeReferencedInPrompt: true,
			};
			const impl: IToolImpl = {
				prepareToolInvocation: async (context: IToolInvocationPreparationContext): Promise<IPreparedToolInvocation> => {
					const input = (context.parameters ?? {}) as Record<string, unknown>;
					const action = actionFor(spec.name, input);
					const confirm = action && this.cloud.decision(action) === 'ask' ? confirmationFor(spec.name, input) : undefined;
					// Once, every time. VS Code would otherwise offer "Allow in
					// this Session", and one yes to a preview-looking question
					// would let every later production deploy through unasked.
					return { ...describe(spec.name, input), ...(confirm ? { confirmationMessages: { ...confirm, allowAutoConfirm: false } } : {}) };
				},
				invoke: (invocation: IToolInvocation, _count: CountTokensCallback, progress: ToolProgress, token: CancellationToken) =>
					this.invoke(spec.name, (invocation.parameters ?? {}) as Record<string, unknown>, progress, token),
			};
			this._register(toolsService.registerTool(data, impl));
		}
	}

	private async invoke(name: string, input: Record<string, unknown>, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			// Refused here as well as left unconfirmed: a person's "never" is
			// not something a model should be able to talk its way past.
			const action = actionFor(name, input);
			if (action && this.cloud.decision(action) === 'never') {
				throw new Error(`The person's Cloud permissions do not let you ${actionLabel(action)}. Say what is needed and ask them to do it in Cloud, or to change ${PERMISSIONS_SETTING} / ${OVERRIDES_SETTING}.`);
			}
			const text = await this.run(name, input, progress, token);
			return { content: [{ kind: 'text', value: text }] };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { content: [{ kind: 'text', value: message }], toolResultError: message };
		}
	}

	private get client() {
		return this.cloud.client;
	}

	private async run(name: string, input: Record<string, unknown>, progress: ToolProgress, token: CancellationToken): Promise<string> {
		const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
		switch (name) {
			case 'cloud_status':
				return formatEnvironments(await this.client.environments());

			case 'cloud_deployments': {
				const limit = Math.min(30, Math.max(1, typeof input.limit === 'number' ? Math.round(input.limit) : 10));
				return formatDeployments(await this.client.listDeployments(limit));
			}

			case 'cloud_logs': {
				const id = str('deploymentId') || (await this.client.listDeployments(1))[0]?.id;
				if (!id) {
					return 'No deployments yet.';
				}
				return formatDeployment(await this.client.deployment(id));
			}

			case 'cloud_deploy':
				return this.deploy(environmentOf(input.environment), str('message'), progress, token);

			case 'cloud_cancel':
				await this.cloud.cancel(str('deploymentId'), 'agent');
				return `Cancelled ${str('deploymentId')}. What was live is still live.`;

			case 'cloud_rollback': {
				const d = await this.cloud.rollback(str('deploymentId'), 'agent');
				return `Rolling back: new deployment ${d.id} puts ${str('deploymentId')} back live. Check it with cloud_logs or cloud_status.`;
			}

			case 'cloud_env_list':
				return formatEnvVars(await this.client.listEnvVars());

			case 'cloud_env_set':
				return this.setVariable(input);

			case 'cloud_domains':
				return formatDomains(await this.client.listDomains());

			case 'cloud_domain_add': {
				const hostname = str('hostname').toLowerCase();
				const added = await this.cloud.addDomain(hostname, environmentOf(input.environment), 'agent');
				const check = await this.client.verifyDomain(added.id).catch(() => undefined);
				const record = check?.validationRecord;
				return record
					? `Added ${hostname} (pending). The person must add this DNS record where they bought the domain, then it can be checked with cloud_domain_check:\n${record.type} ${record.name} ${record.value}`
					: `Added ${hostname}: ${check?.status ?? added.status}.`;
			}

			case 'cloud_domain_check': {
				const domain = await this.domain(str('hostname'));
				const check = await this.client.verifyDomain(domain.id);
				const record = check.validationRecord;
				return check.status === 'verified'
					? `${domain.hostname} is verified.`
					: `${domain.hostname} is ${check.status}.${record ? ` The record still to add: ${record.type} ${record.name} ${record.value}` : ''}`;
			}

			case 'cloud_domain_primary': {
				const domain = await this.domain(str('hostname'));
				await this.cloud.setPrimaryDomain(domain, 'agent');
				return `${domain.hostname} is now the primary domain for ${domain.environment}.`;
			}

			case 'cloud_domain_remove': {
				const domain = await this.domain(str('hostname'));
				await this.cloud.removeDomain(domain, 'agent');
				return `Removed ${domain.hostname}.`;
			}

			case 'cloud_analytics': {
				const environment = environmentOf(input.environment);
				return formatAnalytics(environment, await this.client.analytics(environment));
			}

			default:
				throw new Error(`There is no Cloud tool called ${name}.`);
		}
	}

	private async domain(hostname: string): Promise<DeployDomain> {
		const wanted = hostname.trim().toLowerCase();
		const found = (await this.client.listDomains()).find(d => d.hostname.toLowerCase() === wanted);
		if (!found) {
			throw new Error(`${hostname} is not on this project. cloud_domains lists the ones that are.`);
		}
		return found;
	}

	/**
	 * Build, publish, and wait.
	 *
	 * Waiting is the point. A tool that answered "started" would leave the
	 * model to guess when to look again; one that answers with the outcome —
	 * the address, or the error and the end of the log — is one the model can
	 * act on in its next step, which is how a failed build gets fixed without
	 * anybody asking twice.
	 */
	private async deploy(environment: DeployEnvironment, message: string, progress: ToolProgress, token: CancellationToken): Promise<string> {
		const outcome = await this.cloud.deploy(environment, {
			by: 'agent',
			message,
			token,
			// Worded as the call's own line, because the chat keeps the last
			// progress message on screen: "reading the folder" was left
			// standing where "Deployed to preview" belonged.
			onStep: status => progress.report({
				message: status === 'collecting'
					? localize('cloudeide.cloudTool.deployingTo', "Deploying to {0}", environment)
					: localize('cloudeide.cloudTool.deployingStatus', "Deploying to {0} ({1})", environment, status),
			}),
		});
		const last = outcome.final;
		if (DEPLOY_IN_PROGRESS.includes(last.status)) {
			return `Deployment ${outcome.deploymentId} to ${environment} is still ${last.status} after 10 minutes. Check it later with cloud_logs.`;
		}
		if (last.status === 'success') {
			return `Deployed ${outcome.files} ${outcome.files === 1 ? 'file' : 'files'} to ${environment} as ${outcome.deploymentId}.${last.liveUrl ? ` Live at ${last.liveUrl}` : ''}`;
		}
		return `${formatDeployment(last, 60)}\n\nThe deploy did not succeed. Read the error above, fix its cause in the project, and deploy again.`;
	}

	/**
	 * The person types the value; the model gets the name back and nothing else.
	 */
	private async setVariable(input: Record<string, unknown>): Promise<string> {
		const key = typeof input.key === 'string' ? input.key.trim() : '';
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error('The name may contain only letters, digits and underscores, and may not start with a digit.');
		}
		const environments = (Array.isArray(input.environments) ? input.environments : []).map(environmentOf);
		if (!environments.length) {
			throw new Error('Say which environments it applies to.');
		}
		const reason = typeof input.reason === 'string' ? input.reason.trim() : '';

		const value = await this.quickInputService.input({
			password: true,
			ignoreFocusLost: true,
			title: localize('cloudeide.cloudTool.envTitle', "Value for {0} ({1})", key, environments.join(', ')),
			prompt: reason
				? localize('cloudeide.cloudTool.envPromptReason', "{0} It goes to the server encrypted. The agent does not see it.", reason)
				: localize('cloudeide.cloudTool.envPrompt', "It goes to the server encrypted. The agent does not see it."),
		});
		if (value === undefined || value === '') {
			return `The person did not set ${key}. Do not ask for the value in the conversation; say what it is for and continue without it.`;
		}

		await this.cloud.setEnvVar(key, value, environments, input.secret !== false, 'agent');
		return `${key} is set for ${environments.join(', ')}. Its value was typed by the person and is not shown to you. It takes effect on the next deploy.`;
	}
}
