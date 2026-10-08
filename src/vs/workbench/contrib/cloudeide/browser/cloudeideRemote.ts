/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Remote Control: a phone sending work to the agent in this window.
 *
 * The agent does not move. It runs here, on this computer's files, exactly as
 * if the task had been typed into the chat; the phone only sends the task and
 * reads back what the chat would show. The server in between is a relay
 * (`/api/remote/*`, docs/MOBILE.md in the server repository): it knows which
 * computers an account has and which phones each has agreed to, and carries
 * small messages between them.
 *
 * This file is the part with no workbench in it — the loops, the pairing
 * prompt, which message means what — so it can be tested with a fake server
 * and a fake window. `cloudeideRemoteControl.ts` is the window: the chat, the
 * notification, the Keep and Undo.
 *
 * The rule that matters lives on the server, not here: a phone signed in to
 * the same account still cannot send anything until somebody at this
 * computer has seen its code and pressed Allow.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';

/** How often the computer says it is still here. The server calls it offline after a minute. */
export const HEARTBEAT_MS = 20_000;

/**
 * A task older than this is not run.
 *
 * Messages wait on the server for a day. A task sent while the laptop was
 * shut, run hours later when it opens, is a surprise nobody asked for — so it
 * is answered, not run, and the phone can send it again.
 */
export const STALE_MS = 2 * 60_000;

/** The longest task text taken from a phone. The chat box has no limit; a relay should. */
export const MAX_TASK_CHARS = 8_000;

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export interface ComputerInfo {
	readonly publicId: string;
	readonly name: string;
	readonly platform: 'darwin' | 'win32' | 'linux';
	readonly workspace?: string;
}

/** A phone waiting for an answer, as the server's heartbeat reports it. */
export interface PairingRequest {
	readonly id: number;
	readonly phoneName: string;
	readonly code: string;
	readonly status: string;
	readonly expiresAt: string;
}

/** One message from a phone. */
export interface InboxMessage {
	readonly id: number;
	readonly kind: string;
	readonly body: unknown;
	readonly phoneId: string | null;
	readonly at: string;
}

/** The server, as this file needs it. `CloudeideClient` provides it; tests fake it. */
export interface IRemoteApi {
	register(info: ComputerInfo): Promise<void>;
	heartbeat(publicId: string): Promise<{ pending: readonly PairingRequest[] }>;
	decide(pairingId: number, allow: boolean): Promise<void>;
	/** Waits on the server for up to 25 s when there is nothing yet. */
	inbox(publicId: string, after: number): Promise<readonly InboxMessage[]>;
	send(publicId: string, kind: string, body: unknown): Promise<void>;
}

export type TaskStart = 'started' | 'busy' | 'no-folder';

/** The window, as this file needs it. */
export interface IRemoteHost {
	info(): ComputerInfo;
	signedIn(): Promise<boolean>;
	/** Shows the code and asks. Undefined when the box was closed without an answer. */
	askToConnect(request: PairingRequest): Promise<boolean | undefined>;
	runTask(text: string): Promise<TaskStart>;
	/** Answers a question the run is waiting on. False when nothing is waiting under that ref. */
	answer(ref: string, choice: string): boolean;
	/** Keep or Undo the run's changes. Returns how many files that settled. */
	decideChanges(keep: boolean): Promise<number>;
	stop(): Promise<void>;
}

export interface RemoteClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

const realClock: RemoteClock = {
	now: () => Date.now(),
	sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

function statusOf(err: unknown): number | undefined {
	const status = (err as { status?: unknown } | undefined)?.status;
	return typeof status === 'number' ? status : undefined;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function field<T>(body: unknown, name: string, type: 'string' | 'boolean'): T | undefined {
	const value = (body as Record<string, unknown> | null | undefined)?.[name];
	return typeof value === type ? value as T : undefined;
}

export class RemoteLink extends Disposable {

	private started = false;
	private stopped = false;
	/** The last inbox message handled, so a message is acted on once. */
	private after = 0;
	/** Pairing requests already put in front of somebody, so a heartbeat does not ask twice. */
	private readonly asked = new Set<number>();
	/** What the server was last told about this computer; a change (another folder) is told again. */
	private registered: string | undefined;

	constructor(
		private readonly api: IRemoteApi,
		private readonly host: IRemoteHost,
		private readonly clock: RemoteClock = realClock,
	) {
		super();
	}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		void this.loop(() => this.beat(), HEARTBEAT_MS);
		void this.loop(() => this.poll(), 0);
	}

	override dispose(): void {
		this.stopped = true;
		super.dispose();
	}

	/**
	 * Runs `step` until disposed, waiting `every` between runs and longer
	 * after a failure — a server that is down is asked less and less often,
	 * not once a second by every open window.
	 */
	private async loop(step: () => Promise<void>, every: number): Promise<void> {
		let retry = RETRY_MIN_MS;
		while (!this.stopped) {
			try {
				if (!(await this.host.signedIn())) {
					this.registered = undefined;
					await this.clock.sleep(RETRY_MAX_MS);
					continue;
				}
				await step();
				retry = RETRY_MIN_MS;
				if (every > 0) {
					await this.clock.sleep(every);
				}
			} catch (err) {
				if (statusOf(err) === 404) {
					// The server forgot this computer (or never knew it).
					this.registered = undefined;
				}
				await this.clock.sleep(retry);
				retry = Math.min(retry * 2, RETRY_MAX_MS);
			}
		}
	}

	private async ensureRegistered(): Promise<ComputerInfo> {
		const info = this.host.info();
		const key = JSON.stringify(info);
		if (this.registered !== key) {
			await this.api.register(info);
			this.registered = key;
		}
		return info;
	}

	/** One heartbeat, and a prompt for each phone newly waiting. Public for the tests. */
	async beat(): Promise<void> {
		const info = await this.ensureRegistered();
		const { pending } = await this.api.heartbeat(info.publicId);
		for (const request of pending) {
			if (this.asked.has(request.id)) {
				continue;
			}
			this.asked.add(request.id);
			void this.prompt(request);
		}
	}

	private async prompt(request: PairingRequest): Promise<void> {
		const allow = await this.host.askToConnect(request);
		if (allow === undefined || this.stopped) {
			// Closed without an answer: the request expires on its own.
			return;
		}
		try {
			await this.api.decide(request.id, allow);
		} catch {
			// Expired or answered elsewhere. The phone already shows which.
		}
	}

	/** One read of the inbox, waiting on the server for news. Public for the tests. */
	async poll(): Promise<void> {
		const info = await this.ensureRegistered();
		const messages = await this.api.inbox(info.publicId, this.after);
		for (const message of messages) {
			this.after = Math.max(this.after, message.id);
			await this.handle(message);
		}
	}

	/** Tells every allowed phone. Best effort: a lost step is not worth stopping the run for. */
	async tell(kind: string, body: unknown): Promise<void> {
		try {
			await this.api.send(this.host.info().publicId, kind, body);
		} catch {
			// The next message carries on; the final `done` says how it ended.
		}
	}

	/** What one message from a phone means. Public for the tests. */
	async handle(message: InboxMessage): Promise<void> {
		const sentAt = Date.parse(message.at);
		const stale = Number.isFinite(sentAt) && this.clock.now() - sentAt > STALE_MS;

		try {
			switch (message.kind) {
				case 'task': {
					const text = field<string>(message.body, 'text', 'string')?.trim().slice(0, MAX_TASK_CHARS);
					if (!text) {
						return;
					}
					if (stale) {
						await this.tell('error', { message: 'This task was sent while the computer was away, so it was not run. Send it again.' });
						return;
					}
					const started = await this.host.runTask(text);
					switch (started) {
						case 'started':
							await this.tell('task.started', { text });
							return;
						case 'busy':
							await this.tell('busy', { message: 'The agent is already working on a task on this computer. Wait for it to finish, or stop it.' });
							return;
						case 'no-folder':
							await this.tell('error', { message: 'No folder is open in CloudeIDE on this computer. Open the project there first.' });
							return;
					}
				}

				case 'answer': {
					const ref = field<string>(message.body, 'ref', 'string');
					const choice = field<string>(message.body, 'choice', 'string');
					if (!ref || !choice || stale) {
						return;
					}
					if (!this.host.answer(ref, choice)) {
						await this.tell('error', { message: 'That question was already answered.' });
					}
					return;
				}

				case 'changes': {
					const keep = field<boolean>(message.body, 'keep', 'boolean');
					if (keep === undefined || stale) {
						return;
					}
					const count = await this.host.decideChanges(keep);
					await this.tell('changes.settled', { outcome: keep ? 'kept' : 'undone', count });
					return;
				}

				case 'stop':
					if (!stale) {
						await this.host.stop();
					}
					return;

				case 'ping':
					await this.tell('pong', { workspace: this.host.info().workspace ?? null });
					return;
			}
			// Anything else is from a newer phone app. Ignored rather than refused.
		} catch (err) {
			await this.tell('error', { message: messageOf(err) });
		}
	}
}
