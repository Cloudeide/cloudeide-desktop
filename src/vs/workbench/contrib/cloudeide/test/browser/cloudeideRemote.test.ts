/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	RemoteLink, STALE_MS,
	type ComputerInfo, type InboxMessage, type IRemoteApi, type IRemoteHost, type PairingRequest, type TaskStart,
} from '../../browser/cloudeideRemote.js';

/**
 * A fake server and a fake window, so what each phone message does can be
 * pinned without a network, a chat panel or a person to press Allow.
 */

const NOW = Date.parse('2026-10-10T10:00:00Z');

function setup(options: { start?: TaskStart; allow?: boolean | undefined; answered?: boolean } = {}) {
	const calls: string[] = [];
	const told: { kind: string; body: unknown }[] = [];
	let inbox: InboxMessage[] = [];
	let pending: PairingRequest[] = [];
	let workspace = 'acme-app';

	const api: IRemoteApi = {
		async register(info) { calls.push(`register ${info.workspace}`); },
		async heartbeat() { return { pending }; },
		async decide(id, allow) { calls.push(`decide ${id} ${allow}`); },
		async inbox(_id, after) { calls.push(`inbox after ${after}`); return inbox.filter(m => m.id > after); },
		async send(_id, kind, body) { told.push({ kind, body }); },
	};

	const host: IRemoteHost = {
		info: (): ComputerInfo => ({ publicId: 'mac-1234abcd', name: 'Mac', platform: 'darwin', workspace }),
		signedIn: async () => true,
		askToConnect: async request => { calls.push(`ask ${request.phoneName} ${request.code}`); return 'allow' in options ? options.allow : true; },
		runTask: async text => { calls.push(`run ${text}`); return options.start ?? 'started'; },
		answer: (ref, choice) => { calls.push(`answer ${ref} ${choice}`); return options.answered ?? true; },
		decideChanges: async keep => { calls.push(`changes ${keep}`); return 2; },
		stop: async () => { calls.push('stop'); },
	};

	const link = new RemoteLink(api, host, { now: () => NOW, sleep: async () => { } });
	return {
		link, calls, told,
		setInbox: (messages: InboxMessage[]) => { inbox = messages; },
		setPending: (requests: PairingRequest[]) => { pending = requests; },
		setWorkspace: (name: string) => { workspace = name; },
	};
}

function message(id: number, kind: string, body: unknown, at = NOW): InboxMessage {
	return { id, kind, body, phoneId: 'phone-1234abcd', at: new Date(at).toISOString() };
}

const request: PairingRequest = { id: 7, phoneName: 'Pixel', code: '482913', status: 'pending', expiresAt: new Date(NOW + 300_000).toISOString() };

/** Lets the prompt that `beat` starts without waiting for it run to the end. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

suite('CloudeIDE Remote Control', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a waiting phone is shown once, and the answer goes back', async () => {
		const t = setup();
		t.setPending([request]);
		await t.link.beat();
		await t.link.beat();
		await settle();
		assert.deepStrictEqual(t.calls, ['register acme-app', 'ask Pixel 482913', 'decide 7 true']);
		t.link.dispose();
	});

	test('a prompt closed without an answer decides nothing', async () => {
		const t = setup({ allow: undefined });
		t.setPending([request]);
		await t.link.beat();
		await settle();
		assert.ok(!t.calls.some(c => c.startsWith('decide')));
		t.link.dispose();
	});

	test('opening another folder tells the server again', async () => {
		const t = setup();
		await t.link.beat();
		await t.link.beat();
		t.setWorkspace('shop');
		await t.link.beat();
		assert.deepStrictEqual(t.calls.filter(c => c.startsWith('register')), ['register acme-app', 'register shop']);
		t.link.dispose();
	});

	test('a task runs in the chat, and each message is handled once', async () => {
		const t = setup();
		t.setInbox([message(3, 'task', { text: '  Add an FAQ section  ' })]);
		await t.link.poll();
		await t.link.poll();
		assert.deepStrictEqual(t.calls, ['register acme-app', 'inbox after 0', 'run Add an FAQ section', 'inbox after 3']);
		assert.deepStrictEqual(t.told, [{ kind: 'task.started', body: { text: 'Add an FAQ section' } }]);
		t.link.dispose();
	});

	test('a busy agent or no open folder is said, not queued', async () => {
		const busy = setup({ start: 'busy' });
		await busy.link.handle(message(1, 'task', { text: 'Fix the footer' }));
		assert.strictEqual(busy.told[0].kind, 'busy');
		busy.link.dispose();

		const empty = setup({ start: 'no-folder' });
		await empty.link.handle(message(1, 'task', { text: 'Fix the footer' }));
		assert.strictEqual(empty.told[0].kind, 'error');
		empty.link.dispose();
	});

	test('a task sent while the computer was away is not run', async () => {
		const t = setup();
		await t.link.handle(message(1, 'task', { text: 'Delete the old pages' }, NOW - STALE_MS - 1));
		assert.ok(!t.calls.some(c => c.startsWith('run')));
		assert.strictEqual(t.told[0].kind, 'error');
		t.link.dispose();
	});

	test('answers, Keep and Undo, and Stop reach the window', async () => {
		const t = setup();
		await t.link.handle(message(1, 'answer', { ref: 'call-1', choice: 'Allow' }));
		await t.link.handle(message(2, 'changes', { keep: true }));
		await t.link.handle(message(3, 'stop', {}));
		assert.deepStrictEqual(t.calls, ['answer call-1 Allow', 'changes true', 'stop']);
		assert.deepStrictEqual(t.told, [{ kind: 'changes.settled', body: { outcome: 'kept', count: 2 } }]);
		t.link.dispose();
	});

	test('an answer to a question nobody is asking is said to be late', async () => {
		const t = setup({ answered: false });
		await t.link.handle(message(1, 'answer', { ref: 'call-1', choice: 'Allow' }));
		assert.strictEqual(t.told[0].kind, 'error');
		t.link.dispose();
	});

	test('malformed and unknown messages do nothing', async () => {
		const t = setup();
		await t.link.handle(message(1, 'task', { text: 42 }));
		await t.link.handle(message(2, 'changes', { keep: 'yes' }));
		await t.link.handle(message(3, 'hologram', { text: 'hi' }));
		assert.deepStrictEqual(t.calls, []);
		assert.deepStrictEqual(t.told, []);
		t.link.dispose();
	});
});
