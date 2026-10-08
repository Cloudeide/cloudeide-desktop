/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Remote Control, the window's half: a task from a phone, run in this chat.
 *
 * The task goes into the chat panel as if it had been typed there, so it runs
 * with the same agent, the same tools and the same questions — and whoever is
 * at the computer sees it happen. What the phone gets back is read off that
 * same conversation: each tool as it starts, the reply as it is written, a
 * question when a tool waits for Allow, and the changed files at the end with
 * Keep and Undo.
 *
 * The loops and the meaning of each message are in `cloudeideRemote.ts`.
 * Desktop only (registered from electron-browser): the web build has no
 * folder of its own for a phone to send work to.
 */

import { raceTimeout } from '../../../../base/common/async.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ModifiedFileEntryState } from '../../chat/common/editing/chatEditingService.js';
import { IChatService, IChatToolInvocation, ToolConfirmKind } from '../../chat/common/chatService/chatService.js';
import { IChatResponseModel } from '../../chat/common/model/chatModel.js';
import { CloudeideClient } from './cloudeideClient.js';
import { ComputerInfo, IRemoteHost, PairingRequest, RemoteLink, TaskStart } from './cloudeideRemote.js';

export const REMOTE_CONTROL_SETTING = 'cloudeide.remoteControl.enabled';

/** The id this computer is known by. Random, made once, kept on this machine only. */
const COMPUTER_ID_KEY = 'cloudeide.remoteControl.computerId';

const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

/** How often a running task is looked at for news, on top of the chat's own change events. */
const WATCH_MS = 1_000;

/** The reply is sent while it is being written, but not more often than this. */
const TEXT_EVERY_MS = 3_000;

/** The most of a reply one message carries; the relay refuses anything over 64 KB. */
const MAX_TEXT_CHARS = 16_000;

const ALLOW = 'Allow';
const SKIP = 'Skip';

function plain(value: string | IMarkdownString | undefined): string {
	return (typeof value === 'string' ? value : value?.value ?? '').trim();
}

/** The end of a long reply rather than the start: the conclusion is what a phone screen wants. */
function clip(text: string): string {
	return text.length > MAX_TEXT_CHARS ? `…${text.slice(text.length - MAX_TEXT_CHARS)}` : text;
}

interface RunningTask {
	readonly session: URI;
	readonly response: IChatResponseModel;
	readonly watch: DisposableStore;
}

export class CloudeideRemoteControlContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideRemoteControl';

	private readonly client: CloudeideClient;
	private link: RemoteLink | undefined;
	private task: RunningTask | undefined;
	/** Tool calls waiting for Allow that the phone has been asked about, by call id. */
	private readonly waiting = new Map<string, IChatToolInvocation>();

	constructor(
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IChatService private readonly chatService: IChatService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super();
		this.client = new CloudeideClient(secretStorageService, configurationService);

		this.update();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(REMOTE_CONTROL_SETTING)) {
				this.update();
			}
		}));
		this._register(toDisposable(() => {
			this.link?.dispose();
			this.task?.watch.dispose();
		}));
	}

	/** On when the setting is on, off the moment it is turned off. */
	private update(): void {
		const enabled = this.configurationService.getValue<boolean>(REMOTE_CONTROL_SETTING) !== false;
		if (enabled && !this.link) {
			this.link = new RemoteLink({
				register: info => this.client.remoteRegister(info),
				heartbeat: id => this.client.remoteHeartbeat(id),
				decide: (id, allow) => this.client.remoteDecide(id, allow),
				inbox: (id, after) => this.client.remoteInbox(id, after),
				send: (id, kind, body) => this.client.remoteSend(id, kind, body),
			}, this.host());
			this.link.start();
		} else if (!enabled && this.link) {
			this.link.dispose();
			this.link = undefined;
		}
	}

	private tell(kind: string, body: unknown): void {
		void this.link?.tell(kind, body);
	}

	private computerId(): string {
		let id = this.storageService.get(COMPUTER_ID_KEY, StorageScope.APPLICATION);
		if (!id) {
			id = generateUuid().replace(/-/g, '');
			this.storageService.store(COMPUTER_ID_KEY, id, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		return id;
	}

	private host(): IRemoteHost {
		return {
			info: (): ComputerInfo => ({
				publicId: this.computerId(),
				name: isMacintosh ? 'Mac' : isWindows ? 'Windows PC' : 'Linux PC',
				platform: isMacintosh ? 'darwin' : isWindows ? 'win32' : 'linux',
				workspace: this.contextService.getWorkspace().folders[0]?.name,
			}),
			signedIn: async () => !!(await this.client.getToken()),
			askToConnect: request => this.askToConnect(request),
			runTask: text => this.runTask(text),
			answer: (ref, choice) => this.answer(ref, choice),
			decideChanges: keep => this.decideChanges(keep),
			stop: async () => {
				if (this.task && !this.task.response.isComplete) {
					await this.chatService.cancelCurrentRequestForSession(this.task.session, 'remoteControl');
				}
			},
		};
	}

	/**
	 * The consent, asked where the work will happen.
	 *
	 * A notification rather than a dialog: the person is usually at the
	 * computer when they pair, and a modal box over whatever they were doing
	 * is a lot for a question that can wait five minutes. It closes itself
	 * when the request expires, so a stale Allow cannot be pressed.
	 */
	private askToConnect(request: PairingRequest): Promise<boolean | undefined> {
		return new Promise(resolve => {
			const handle = this.notificationService.prompt(
				Severity.Info,
				localize('cloudeide.remote.ask',
					"Connect \"{0}\" to this computer? Code {1}. Allow it only if your phone shows the same code. It will be able to start tasks in this window.",
					request.phoneName, request.code),
				[
					{ label: localize('cloudeide.remote.allow', "Allow"), run: () => resolve(true) },
					{ label: localize('cloudeide.remote.deny', "Deny"), run: () => resolve(false) },
				],
				{ sticky: true, onCancel: () => resolve(undefined) },
			);
			const left = Date.parse(request.expiresAt) - Date.now();
			if (Number.isFinite(left)) {
				const timer = setTimeout(() => { handle.close(); resolve(undefined); }, Math.max(0, left));
				handle.onDidClose(() => clearTimeout(timer));
			}
		});
	}

	private async runTask(text: string): Promise<TaskStart> {
		if (this.task && !this.task.response.isComplete) {
			return 'busy';
		}
		if (this.contextService.getWorkspace().folders.length === 0) {
			return 'no-folder';
		}

		const store = new DisposableStore();
		try {
			const submitted = new Promise<URI>(resolve => {
				store.add(this.chatService.onDidSubmitRequest(e => resolve(e.chatSessionResource)));
			});
			await this.commandService.executeCommand(CHAT_OPEN_COMMAND, { query: text, mode: 'agent' });
			const session = await raceTimeout(submitted, 10_000);
			if (!session) {
				throw new Error(localize('cloudeide.remote.notTaken', "The chat on the computer did not take the task."));
			}

			// The request is submitted before its response exists; wait for it.
			let response: IChatResponseModel | undefined;
			for (let i = 0; i < 50 && !response; i++) {
				const last = this.chatService.getSession(session)?.lastRequest;
				response = last?.message.text.includes(text) ? last.response : undefined;
				if (!response) {
					await new Promise(resolve => setTimeout(resolve, 100));
				}
			}
			if (!response) {
				throw new Error(localize('cloudeide.remote.noResponse', "The task was sent to the chat, but it did not start."));
			}

			this.watch(session, response);
			return 'started';
		} finally {
			store.dispose();
		}
	}

	/** Follows one run and tells the phone what the chat shows. */
	private watch(session: URI, response: IChatResponseModel): void {
		this.task?.watch.dispose();
		this.waiting.clear();

		const watch = new DisposableStore();
		this.task = { session, response, watch };

		const seen = new Set<string>();
		let sentText = '';
		let sentAt = 0;
		let finished = false;

		const look = () => {
			if (finished) {
				return;
			}
			for (const part of response.response.value) {
				if (part.kind !== 'toolInvocation') {
					continue;
				}
				const state = part.state.get();
				if (state.type === IChatToolInvocation.StateKind.Streaming) {
					continue;
				}
				if (!seen.has(part.toolCallId)) {
					seen.add(part.toolCallId);
					this.tell('step', { text: plain(part.invocationMessage) });
				}
				if (state.type === IChatToolInvocation.StateKind.WaitingForConfirmation && !this.waiting.has(part.toolCallId)) {
					this.waiting.set(part.toolCallId, part);
					this.tell('question', {
						ref: part.toolCallId,
						text: plain(state.confirmationMessages?.title) || plain(part.invocationMessage),
						detail: plain(state.confirmationMessages?.message),
						options: [ALLOW, SKIP],
					});
				}
			}
			for (const [id, invocation] of this.waiting) {
				if (invocation.state.get().type !== IChatToolInvocation.StateKind.WaitingForConfirmation) {
					this.waiting.delete(id);
					this.tell('question.settled', { ref: id });
				}
			}

			const text = response.response.getMarkdown();
			if (text !== sentText && Date.now() - sentAt >= TEXT_EVERY_MS) {
				sentText = text;
				sentAt = Date.now();
				this.tell('text', { text: clip(text) });
			}

			if (response.isComplete) {
				finished = true;
				this.finish(session, response);
				watch.dispose();
			}
		};

		watch.add(response.onDidChange(look));
		const timer = setInterval(look, WATCH_MS);
		watch.add(toDisposable(() => clearInterval(timer)));
		look();
	}

	private finish(session: URI, response: IChatResponseModel): void {
		this.waiting.clear();
		const status = response.isCanceled ? 'cancelled' : response.result?.errorDetails ? 'failed' : 'completed';
		this.tell('done', {
			status,
			text: clip(response.response.getMarkdown()),
			error: response.result?.errorDetails?.message,
			files: this.changedFiles(session),
		});
	}

	private changedFiles(session: URI): { path: string; added: number; removed: number }[] {
		const root = this.contextService.getWorkspace().folders[0]?.uri;
		const entries = this.chatService.getSession(session)?.editingSession?.entries.get() ?? [];
		return entries
			.filter(e => e.state.get() === ModifiedFileEntryState.Modified)
			.map(e => ({
				path: (root && relativePath(root, e.modifiedURI)) || basename(e.modifiedURI),
				added: e.linesAdded?.get() ?? 0,
				removed: e.linesRemoved?.get() ?? 0,
			}));
	}

	/** Allow or Skip for a tool waiting on it — the same as pressing the button in the chat. */
	private answer(ref: string, choice: string): boolean {
		const invocation = this.waiting.get(ref);
		if (!invocation) {
			return false;
		}
		this.waiting.delete(ref);
		return IChatToolInvocation.confirmWith(invocation, choice === ALLOW
			? { type: ToolConfirmKind.UserAction }
			: { type: ToolConfirmKind.Skipped });
	}

	/** Keep or Undo for everything the last phone task changed. */
	private async decideChanges(keep: boolean): Promise<number> {
		if (!this.task) {
			return 0;
		}
		const editing = this.chatService.getSession(this.task.session)?.editingSession;
		if (!editing) {
			return 0;
		}
		const count = editing.entries.get().filter(e => e.state.get() === ModifiedFileEntryState.Modified).length;
		await (keep ? editing.accept() : editing.reject());
		return count;
	}
}
