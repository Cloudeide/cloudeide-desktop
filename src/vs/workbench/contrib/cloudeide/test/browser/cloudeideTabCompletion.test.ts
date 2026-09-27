/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { InlineCompletionContext, InlineCompletions, InlineCompletionsProvider } from '../../../../../editor/common/languages.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IStatusbarEntry, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { CloudeideTabContribution, TAB_ENABLED_SETTING } from '../../browser/cloudeideTabCompletion.js';

/**
 * The provider end to end, short of the network: a real text model, the
 * real provider registry, and the server's reply played back through fetch.
 *
 * What the unit tests for cloudeideTab.ts cannot show is whether the pieces
 * meet — that the text either side of the cursor is what gets sent, that the
 * suggestion lands at the cursor, that keeping a function carries the test
 * offer, and that nothing is asked for when it should not be.
 */

const SERVER = 'https://cloudeide.test';
const FILE = 'export function teamCost(plan, seats) {\n}\n';
const REPLY = '<insert>\n  if (seats <= 0) return 0;\n  return plan.monthly * seats;\n}</insert>';

interface Call { url: string; body: { model: string; messages: { content: string }[] } }

suite('CloudeIDE Tab in the editor', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let calls: Call[];
	let realFetch: typeof fetch;
	let reply: string;

	setup(() => {
		calls = [];
		reply = REPLY;
		realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify({
				content: [{ type: 'text', text: reply }],
				usage: { input_tokens: 1200, output_tokens: 20 },
			}), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}) as typeof fetch;
	});

	teardown(() => {
		globalThis.fetch = realFetch;
	});

	function setUp(options: { signedIn?: boolean; settings?: Record<string, unknown> } = {}) {
		const languageFeatures = new LanguageFeaturesService();
		const configuration = new TestConfigurationService({ 'cloudeide.serverUrl': SERVER, ...options.settings });
		const secrets = {
			onDidChangeSecret: Event.None,
			get: async () => options.signedIn === false ? undefined : 'token',
			set: async () => { },
			delete: async () => { },
		} as unknown as ISecretStorageService;
		const entries: IStatusbarEntry[] = [];
		const statusbar = {
			addEntry: (entry: IStatusbarEntry) => {
				entries.push(entry);
				return { update: (e: IStatusbarEntry) => entries.push(e), dispose: () => { } };
			},
		} as unknown as IStatusbarService;
		const storage = store.add(new InMemoryStorageService());
		const files = { readFile: async () => { throw new Error('no such file'); } } as unknown as IFileService;
		const workspace = { getWorkspaceFolder: () => ({ uri: URI.file('/proj') }) } as unknown as IWorkspaceContextService;

		const tab = store.add(new CloudeideTabContribution(languageFeatures, configuration, secrets, statusbar, storage, files, workspace, new NullLogService()));
		const model = store.add(createTextModel(FILE, 'javascript', undefined, URI.file('/proj/src/pricing.js')));
		const provider = languageFeatures.inlineCompletionsProvider.all(model)[0] as InlineCompletionsProvider<InlineCompletions & { items: { rule?: string }[] }>;
		return { tab, model, provider, storage, entries };
	}

	const context = {} as InlineCompletionContext;
	const AFTER_BRACE = new Position(1, 'export function teamCost(plan, seats) {'.length + 1);

	test('a suggestion arrives at the cursor, without the brace already there', async () => {
		const { model, provider } = setUp();
		const result = await provider.provideInlineCompletions(model, AFTER_BRACE, context, CancellationToken.None);
		assert.ok(result, 'no suggestion');
		assert.strictEqual(result.items.length, 1);
		const item = result.items[0];
		assert.strictEqual(item.insertText, '\n  if (seats <= 0) return 0;\n  return plan.monthly * seats;');
		assert.deepStrictEqual(item.range, { startLineNumber: 1, startColumn: AFTER_BRACE.column, endLineNumber: 1, endColumn: AFTER_BRACE.column });
	});

	test('the request carries the file around the cursor and goes to the server', async () => {
		const { model, provider } = setUp();
		await provider.provideInlineCompletions(model, AFTER_BRACE, context, CancellationToken.None);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, `${SERVER}/api/anthropic/v1/messages`);
		assert.strictEqual(calls[0].body.model, 'claude-haiku-4-5');
		const content = calls[0].body.messages[0].content;
		assert.ok(content.includes('File: src/pricing.js'), content);
		assert.ok(content.includes('export function teamCost(plan, seats) {<cursor/>\n}'), content);
	});

	test('keeping a whole function carries the offer of a test', async () => {
		const { model, provider } = setUp();
		const result = await provider.provideInlineCompletions(model, AFTER_BRACE, context, CancellationToken.None);
		assert.deepStrictEqual(result?.items[0].command?.arguments, ['teamCost', 'src/pricing.js']);
		assert.strictEqual(result?.items[0].command?.id, 'cloudeide.tab.offerTest');
	});

	test('counts what it used today', async () => {
		const { model, provider, storage } = setUp();
		await provider.provideInlineCompletions(model, AFTER_BRACE, context, CancellationToken.None);
		const usage = JSON.parse(storage.get('cloudeide.tab.usage', StorageScope.APPLICATION) ?? '{}');
		assert.strictEqual(usage.suggestions, 1);
		assert.strictEqual(usage.tokens, 1220);
	});

	test('asks for nothing when turned off', async () => {
		const { model, provider } = setUp({ settings: { [TAB_ENABLED_SETTING]: false } });
		assert.strictEqual(await provider.provideInlineCompletions(model, AFTER_BRACE, context, CancellationToken.None), undefined);
		assert.strictEqual(calls.length, 0);
	});

	test('asks for nothing when signed out', async () => {
		const { model, provider } = setUp({ signedIn: false });
		assert.strictEqual(await provider.provideInlineCompletions(model, AFTER_BRACE, context, CancellationToken.None), undefined);
		assert.strictEqual(calls.length, 0);
	});

	test('asks for nothing in the middle of a word', async () => {
		const { model, provider } = setUp();
		assert.strictEqual(await provider.provideInlineCompletions(model, new Position(1, 12), context, CancellationToken.None), undefined);
		assert.strictEqual(calls.length, 0);
	});

	test('a reply that is not in the format inserts nothing', async () => {
		const { model, provider } = setUp();
		reply = 'Here is the body of the function you asked for.';
		assert.strictEqual(await provider.provideInlineCompletions(model, AFTER_BRACE, context, CancellationToken.None), undefined);
	});

	test('the status bar says so while a rule-following suggestion shows', () => {
		const { provider, entries } = setUp();
		assert.ok(entries[entries.length - 1].text.includes('Tab'));
		provider.handleItemDidShow?.({ items: [] }, { insertText: 'x', rule: 'Use the shared fetch helper' }, 'x', undefined!);
		assert.ok(entries[entries.length - 1].text.includes('follows team rule'), entries[entries.length - 1].text);
		provider.disposeInlineCompletions({ items: [] }, undefined!);
		assert.ok(!entries[entries.length - 1].text.includes('follows team rule'));
	});
});
