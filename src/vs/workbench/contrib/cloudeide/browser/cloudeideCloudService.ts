/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One Cloud, shared by everything in the window that changes it.
 *
 * The Cloud tab, the Cloud pane and the agent in the chat each used to hold
 * their own client and act on their own. So when the person deployed from the
 * Cloud tab, the agent had no idea; when the agent deployed, the tab showed
 * the old list until somebody pressed Refresh. Two views of one project that
 * did not know about each other.
 *
 * Every change now goes through here. Each one is recorded with who made it —
 * the agent or the person — and announced, so the views redraw and the agent
 * reads what happened on its next turn. The record is kept per workspace, so
 * it survives a reload.
 *
 * The agent's permissions live here too, because the question "may the agent
 * do this?" belongs with the thing that does it.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CloudeideClient, DEPLOY_IN_PROGRESS, DeployDomain, DeployEnvironment, DeploymentDetail } from './cloudeideClient.js';
import {
	agentDeploysInLastHour, CloudAction, CloudActivity, CloudActor, CloudDecision, CloudPreset, decide,
	describeForModel, presetOf,
} from './cloudeideCloudPermissions.js';
import { collectWorkspaceFiles } from './cloudeideWorkspace.js';

export const PERMISSIONS_SETTING = 'cloudeide.agent.cloudPermissions';
export const OVERRIDES_SETTING = 'cloudeide.agent.cloudOverrides';
export const MAX_DEPLOYS_SETTING = 'cloudeide.agent.maxDeploysPerHour';
export const DEFAULT_MAX_DEPLOYS_PER_HOUR = 10;

const ACTIVITY_KEY = 'cloudeide.cloud.activity';
const MAX_ACTIVITY = 50;

const DEPLOY_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 3000;

export interface DeployOutcome {
	readonly deploymentId: string;
	readonly files: number;
	/** The deployment as last seen: settled, or still building if the wait ran out. */
	readonly final: DeploymentDetail;
}

export const ICloudeideCloudService = createDecorator<ICloudeideCloudService>('cloudeideCloudService');

export interface ICloudeideCloudService {
	readonly _serviceBrand: undefined;

	/** For reading. Anything that changes Cloud goes through the methods below. */
	readonly client: CloudeideClient;

	/** Something in Cloud changed, and here is what (undefined for a change with nothing to record). */
	readonly onDidChange: Event<CloudActivity | undefined>;

	activity(): readonly CloudActivity[];

	deploy(environment: DeployEnvironment, options: { by: CloudActor; message?: string; onStep?: (status: string) => void; token?: CancellationToken }): Promise<DeployOutcome>;
	rollback(deploymentId: string, by: CloudActor): Promise<DeploymentDetail>;
	cancel(deploymentId: string, by: CloudActor): Promise<void>;
	setEnvVar(key: string, value: string, environments: readonly DeployEnvironment[], secret: boolean, by: CloudActor): Promise<void>;
	addDomain(hostname: string, environment: DeployEnvironment, by: CloudActor): Promise<DeployDomain>;
	setPrimaryDomain(domain: DeployDomain, by: CloudActor): Promise<void>;
	removeDomain(domain: DeployDomain, by: CloudActor): Promise<void>;

	preset(): CloudPreset;
	setPreset(preset: CloudPreset): Promise<void>;
	decision(action: CloudAction): CloudDecision;
	/** Why the agent may not deploy right now, or undefined if it may. */
	deployBudgetExceeded(): string | undefined;
	/** The permissions and the recent activity, written for the model. */
	describeForModel(): string;
}

export class CloudeideCloudService extends Disposable implements ICloudeideCloudService {

	declare readonly _serviceBrand: undefined;

	readonly client: CloudeideClient;

	private readonly _onDidChange = this._register(new Emitter<CloudActivity | undefined>());
	readonly onDidChange = this._onDidChange.event;

	private items: CloudActivity[];

	constructor(
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.client = new CloudeideClient(secretStorageService, configurationService);
		this.items = this.load();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PERMISSIONS_SETTING) || e.affectsConfiguration(OVERRIDES_SETTING)) {
				this._onDidChange.fire(undefined);
			}
		}));
	}

	activity(): readonly CloudActivity[] {
		return this.items;
	}

	private load(): CloudActivity[] {
		try {
			const raw = JSON.parse(this.storageService.get(ACTIVITY_KEY, StorageScope.WORKSPACE, '[]'));
			return Array.isArray(raw) ? raw.filter(a => a && typeof a.at === 'number' && typeof a.summary === 'string') : [];
		} catch {
			return [];
		}
	}

	private record(item: Omit<CloudActivity, 'at'>): CloudActivity {
		const full: CloudActivity = { ...item, at: Date.now() };
		this.items = [...this.items, full].slice(-MAX_ACTIVITY);
		this.storageService.store(ACTIVITY_KEY, JSON.stringify(this.items), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChange.fire(full);
		return full;
	}

	async deploy(environment: DeployEnvironment, options: { by: CloudActor; message?: string; onStep?: (status: string) => void; token?: CancellationToken }): Promise<DeployOutcome> {
		if (options.by === 'agent') {
			const over = this.deployBudgetExceeded();
			if (over) {
				throw new Error(over);
			}
		}

		// What the editor shows is what goes out.
		await this.editorService.saveAll().catch(() => undefined);

		options.onStep?.('reading the folder');
		const files = await collectWorkspaceFiles(this.fileService, this.contextService);
		if (!files.length) {
			throw new Error('Nothing to deploy: no folder is open, or it has no files.');
		}

		const started = await this.client.startDeploy(files, {
			environment,
			commitMessage: options.message || undefined,
			trigger: options.by === 'agent' ? 'agent' : 'manual',
		});
		this.record({ by: options.by, kind: 'deploy', deploymentId: started.deploymentId, summary: `started deployment ${started.deploymentId} to ${environment}${options.message ? ` ("${options.message}")` : ''}` });

		const deadline = Date.now() + DEPLOY_WAIT_MS;
		let final: DeploymentDetail = { id: started.deploymentId, status: started.status };
		while (Date.now() < deadline && !options.token?.isCancellationRequested) {
			final = await this.client.deployment(started.deploymentId);
			if (!DEPLOY_IN_PROGRESS.includes(final.status)) {
				break;
			}
			options.onStep?.(final.status);
			await new Promise(resolve => setTimeout(resolve, POLL_MS));
		}

		if (!DEPLOY_IN_PROGRESS.includes(final.status)) {
			const how = final.status === 'success'
				? `succeeded${final.liveUrl ? `, live at ${final.liveUrl}` : ''}`
				: `${final.status}${final.errorSummary ? `: ${final.errorSummary}` : ''}`;
			this.record({ by: options.by, kind: 'deploy', deploymentId: started.deploymentId, summary: `deployment ${started.deploymentId} to ${environment} ${how}` });
		}
		return { deploymentId: started.deploymentId, files: files.length, final };
	}

	async rollback(deploymentId: string, by: CloudActor): Promise<DeploymentDetail> {
		const d = await this.client.rollback(deploymentId);
		this.record({ by, kind: 'rollback', deploymentId: d.id, summary: `rolled back to ${deploymentId} (new deployment ${d.id})` });
		return d;
	}

	async cancel(deploymentId: string, by: CloudActor): Promise<void> {
		await this.client.cancelDeployment(deploymentId);
		this.record({ by, kind: 'cancel', deploymentId, summary: `cancelled deployment ${deploymentId}` });
	}

	async setEnvVar(key: string, value: string, environments: readonly DeployEnvironment[], secret: boolean, by: CloudActor): Promise<void> {
		const existing = (await this.client.listEnvVars()).find(v => v.key === key);
		if (existing) {
			for (const environment of environments) {
				await this.client.setEnvVarValue(existing.id, environment, value);
			}
		} else {
			await this.client.addEnvVar(key, value, secret, environments);
		}
		// The name and where it applies. Never the value: this record is read
		// back to the model.
		this.record({ by, kind: 'env', summary: `${existing ? 'changed' : 'added'} environment variable ${key} for ${environments.join(', ')}` });
	}

	async addDomain(hostname: string, environment: DeployEnvironment, by: CloudActor): Promise<DeployDomain> {
		const domain = await this.client.addDomain(hostname, environment);
		this.record({ by, kind: 'domain', summary: `added domain ${domain.hostname} to ${environment}` });
		return domain;
	}

	async setPrimaryDomain(domain: DeployDomain, by: CloudActor): Promise<void> {
		await this.client.setPrimaryDomain(domain.id);
		this.record({ by, kind: 'domain', summary: `made ${domain.hostname} the primary domain for ${domain.environment}` });
	}

	async removeDomain(domain: DeployDomain, by: CloudActor): Promise<void> {
		await this.client.removeDomain(domain.id);
		this.record({ by, kind: 'domain', summary: `removed domain ${domain.hostname}` });
	}

	preset(): CloudPreset {
		return presetOf(this.configurationService.getValue(PERMISSIONS_SETTING));
	}

	async setPreset(preset: CloudPreset): Promise<void> {
		await this.configurationService.updateValue(PERMISSIONS_SETTING, preset);
	}

	private overrides(): Record<string, unknown> | undefined {
		const raw = this.configurationService.getValue(OVERRIDES_SETTING);
		return raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
	}

	private maxDeploysPerHour(): number {
		const raw = this.configurationService.getValue(MAX_DEPLOYS_SETTING);
		return typeof raw === 'number' && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_DEPLOYS_PER_HOUR;
	}

	decision(action: CloudAction): CloudDecision {
		return decide(action, this.preset(), this.overrides());
	}

	deployBudgetExceeded(): string | undefined {
		const max = this.maxDeploysPerHour();
		const used = agentDeploysInLastHour(this.items.filter(a => a.summary.startsWith('started')), Date.now());
		return used >= max
			? `You have started ${used} deploys in the last hour, which is the limit (${max}). Stop, say what you tried and what is still failing, and let the person decide.`
			: undefined;
	}

	describeForModel(): string {
		return describeForModel(this.preset(), this.overrides(), this.maxDeploysPerHour());
	}
}
