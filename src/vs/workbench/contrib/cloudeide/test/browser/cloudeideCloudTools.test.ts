/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolResult } from '../../../chat/common/tools/languageModelToolsService.js';
import {
	CLOUD_READ_TOOL_NAMES, CLOUD_TOOLS, CloudeideCloudToolsContribution, confirmationFor, formatDeployment,
	formatEnvironments, onDidChangeCloud,
} from '../../browser/cloudeideCloudTools.js';

/**
 * The agent's hands on Cloud.
 *
 * Three things must hold whatever else changes: a failed deploy hands the
 * model the error and the end of the log, so it can fix it; anything that
 * changes what the public sees waits for a person; and a secret's value is
 * typed by the person and never appears in anything the model reads.
 */

const SERVER = 'https://cloudeide.test';

interface Call { method: string; path: string; body: Record<string, unknown> | undefined }

suite('CloudeIDE Cloud tools', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let calls: Call[];
	let realFetch: typeof fetch;
	let routes: Record<string, unknown>;

	setup(() => {
		calls = [];
		routes = {};
		realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
			const u = new URL(String(url));
			const path = u.pathname.replace(/^\/api/, '');
			const method = init.method ?? 'GET';
			calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
			const key = `${method} ${path}`;
			const answer = Object.prototype.hasOwnProperty.call(routes, key) ? routes[key] : {};
			return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}) as typeof fetch;
	});

	teardown(() => {
		globalThis.fetch = realFetch;
	});

	function setUp(options: { typed?: string } = {}) {
		const impls = new Map<string, IToolImpl>();
		const datas = new Map<string, IToolData>();
		const toolsService = {
			registerTool: (data: IToolData, impl: IToolImpl) => {
				datas.set(data.id, data);
				impls.set(data.id, impl);
				return { dispose: () => { impls.delete(data.id); } };
			},
		} as unknown as ILanguageModelToolsService;
		const secrets = { onDidChangeSecret: Event.None, get: async () => 'token', set: async () => { }, delete: async () => { } } as unknown as ISecretStorageService;
		const root = URI.file('/proj');
		const fileService = {
			resolve: async () => ({ children: [{ name: 'index.html', isDirectory: false, resource: URI.joinPath(root, 'index.html') }] }),
			readFile: async () => ({ value: VSBuffer.fromString('<h1>Hi</h1>') }),
		} as unknown as IFileService;
		const contextService = { getWorkspace: () => ({ folders: [{ uri: root, name: 'proj' }] }) } as unknown as IWorkspaceContextService;
		const editorService = { saveAll: async () => true } as unknown as IEditorService;
		const prompts: unknown[] = [];
		const quickInput = { input: async (o: unknown) => { prompts.push(o); return options.typed; } } as unknown as IQuickInputService;

		store.add(new CloudeideCloudToolsContribution(toolsService, secrets, new TestConfigurationService({ 'cloudeide.serverUrl': SERVER }), fileService, contextService, editorService, quickInput));

		const run = async (name: string, parameters: Record<string, unknown>): Promise<{ text: string; result: IToolResult }> => {
			const result = await impls.get(name)!.invoke({ callId: 'c', toolId: name, parameters, context: undefined }, async () => 0, { report: () => { } }, CancellationToken.None);
			const text = result.content.map(p => p.kind === 'text' ? p.value : '').join('');
			return { text, result };
		};
		return { impls, datas, run, prompts };
	}

	test('every tool is registered, with a description the model can act on', () => {
		const { datas } = setUp();
		assert.deepStrictEqual([...datas.keys()], CLOUD_TOOLS.map(t => t.name));
		for (const data of datas.values()) {
			assert.ok(data.modelDescription.length > 40, data.id);
		}
		assert.ok(CLOUD_READ_TOOL_NAMES.includes('cloud_logs'));
		assert.ok(!CLOUD_READ_TOOL_NAMES.includes('cloud_deploy'));
		assert.ok(!CLOUD_READ_TOOL_NAMES.includes('cloud_env_set'));
	});

	test('a deploy is started detached, by the agent, and a failure comes back with its log', async () => {
		routes['POST /deploy/run'] = { deploymentId: 'dpl_1', status: 'queued' };
		routes['GET /deploy/deployments/dpl_1'] = {
			id: 'dpl_1', environment: 'preview', status: 'failed', failedPhase: 'build',
			errorSummary: 'STRIPE_PUBLIC_KEY is not defined',
			logs: [{ text: 'vite building', level: 'info' }, { text: 'STRIPE_PUBLIC_KEY is not defined', level: 'error' }],
		};
		const { run } = setUp();
		let changed = 0;
		const listener = onDidChangeCloud(() => changed++);
		try {
			const { text } = await run('cloud_deploy', { environment: 'preview', message: 'Yearly billing' });
			const start = calls.find(c => c.path === '/deploy/run')!;
			assert.strictEqual(start.body?.detach, true);
			assert.strictEqual(start.body?.trigger, 'agent');
			assert.strictEqual(start.body?.environment, 'preview');
			assert.strictEqual(start.body?.commitMessage, 'Yearly billing');
			assert.deepStrictEqual(start.body?.files, [{ path: 'index.html', content: '<h1>Hi</h1>' }]);
			assert.ok(text.includes('Failed in: build'), text);
			assert.ok(text.includes('ERROR STRIPE_PUBLIC_KEY is not defined'), text);
			assert.ok(text.includes('fix its cause'), text);
			assert.ok(changed >= 1, 'the Cloud views are told');
		} finally {
			listener.dispose();
		}
	});

	test('a successful deploy answers with the live address', async () => {
		routes['POST /deploy/run'] = { deploymentId: 'dpl_2', status: 'queued' };
		routes['GET /deploy/deployments/dpl_2'] = { id: 'dpl_2', status: 'success', liveUrl: 'https://acme-app-preview.cloudeide.app' };
		const { run } = setUp();
		const { text } = await run('cloud_deploy', { environment: 'preview' });
		assert.strictEqual(text, 'Deployed 1 file to preview as dpl_2. Live at https://acme-app-preview.cloudeide.app');
	});

	test('what changes the public site asks first; previews and reading do not', () => {
		assert.ok(confirmationFor('cloud_deploy', { environment: 'production' }));
		assert.strictEqual(confirmationFor('cloud_deploy', { environment: 'preview' }), undefined);
		assert.ok(confirmationFor('cloud_rollback', { deploymentId: 'dpl_1' }));
		assert.ok(confirmationFor('cloud_domain_add', { hostname: 'shop.acme.com', environment: 'production' }));
		assert.ok(confirmationFor('cloud_domain_remove', { hostname: 'shop.acme.com' }));
		assert.ok(confirmationFor('cloud_domain_primary', { hostname: 'shop.acme.com' }));
		assert.strictEqual(confirmationFor('cloud_status', {}), undefined);
		assert.strictEqual(confirmationFor('cloud_logs', {}), undefined);
	});

	test('the confirmation is attached when the call is prepared', async () => {
		const { impls } = setUp();
		const prepared = await impls.get('cloud_deploy')!.prepareToolInvocation!({ parameters: { environment: 'production' }, toolCallId: 'c', chatSessionResource: undefined }, CancellationToken.None);
		assert.strictEqual(prepared?.confirmationMessages?.title, 'Deploy to production?');
	});

	test('a secret is typed by the person, sent to the server, and never returned to the model', async () => {
		routes['GET /deploy/env-vars'] = { envVars: [] };
		const { run, prompts } = setUp({ typed: 'pk_live_SECRET123' });
		const { text } = await run('cloud_env_set', { key: 'STRIPE_PUBLIC_KEY', environments: ['preview', 'production'], reason: 'Your Stripe publishable key, from the Stripe dashboard.' });
		const post = calls.find(c => c.method === 'POST' && c.path === '/deploy/env-vars')!;
		assert.strictEqual(post.body?.value, 'pk_live_SECRET123');
		assert.strictEqual(post.body?.secret, true);
		assert.deepStrictEqual(post.body?.environments, ['preview', 'production']);
		assert.ok(!text.includes('SECRET123'), text);
		assert.strictEqual((prompts[0] as { password: boolean }).password, true);
	});

	test('an existing variable is updated per environment', async () => {
		routes['GET /deploy/env-vars'] = { envVars: [{ id: '7', key: 'API_URL', secret: false, environments: ['preview'] }] };
		const { run } = setUp({ typed: 'https://api.acme.com' });
		await run('cloud_env_set', { key: 'API_URL', environments: ['preview', 'production'], reason: 'x' });
		const puts = calls.filter(c => c.method === 'PUT');
		assert.deepStrictEqual(puts.map(p => [p.path, p.body?.environment]), [['/deploy/env-vars/7', 'preview'], ['/deploy/env-vars/7', 'production']]);
	});

	test('if the person does not type a value, nothing is sent and the model is told not to ask for it', async () => {
		const { run } = setUp({ typed: undefined });
		const { text } = await run('cloud_env_set', { key: 'STRIPE_KEY', environments: ['production'], reason: 'x' });
		assert.ok(!calls.some(c => c.path === '/deploy/env-vars' && c.method === 'POST'));
		assert.ok(text.includes('Do not ask for the value'), text);
	});

	test('adding a domain reports the DNS record to add', async () => {
		routes['POST /deploy/domains'] = { id: 'd1', hostname: 'shop.acme.com', environment: 'production', status: 'pending' };
		routes['GET /deploy/domains/d1/verify'] = { status: 'pending', validationRecord: { type: 'CNAME', name: 'shop', value: 'acme-app.cloudeide.app' } };
		const { run } = setUp();
		const { text } = await run('cloud_domain_add', { hostname: 'Shop.Acme.com', environment: 'production' });
		assert.ok(text.includes('CNAME shop acme-app.cloudeide.app'), text);
		assert.strictEqual(calls.find(c => c.path === '/deploy/domains')?.body?.hostname, 'shop.acme.com');
	});

	test('a domain that is not on the project is said so, not guessed at', async () => {
		routes['GET /deploy/domains'] = { domains: [] };
		const { run } = setUp();
		const { result } = await run('cloud_domain_remove', { hostname: 'nope.acme.com' });
		assert.ok(result.toolResultError);
	});

	test('what is live reads as one line per environment', () => {
		assert.strictEqual(formatEnvironments([
			{ environment: 'production', liveUrl: 'https://acme.com', latestDeployment: { id: 'dpl_9', status: 'success', createdAt: '2026-09-27T10:00:00.000Z' } },
			{ environment: 'preview', liveUrl: null, latestDeployment: null },
		]), 'production: https://acme.com · latest dpl_9: success, 2026-09-27 10:00:00Z\npreview: no live address · never deployed');
	});

	test('a long log is cut from the top, where the error is not', () => {
		const logs = Array.from({ length: 300 }, (_, i) => ({ text: `line ${i}` }));
		const text = formatDeployment({ id: 'd', status: 'failed', logs }, 50);
		assert.ok(text.includes('(250 earlier lines not shown)'));
		assert.ok(text.endsWith('line 299'));
		assert.ok(!text.includes('line 249\n'));
	});
});
