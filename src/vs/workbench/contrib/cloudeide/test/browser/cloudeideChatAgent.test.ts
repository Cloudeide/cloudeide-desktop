/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IChatProgress } from '../../../chat/common/chatService/chatService.js';
import { IChatAgentRequest } from '../../../chat/common/participants/chatAgents.js';
import { IToolData, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { ChatAgentServices, CloudeideChatAgent } from '../../browser/cloudeideChatAgent.js';

/**
 * The chat panel's agent, with the server and the tool service played back.
 *
 * What matters is what reaches the model and what reaches the tools: that an
 * Ask turn is never offered a tool that writes, that a tool the person
 * switched off is not offered at all, that a picture arrives as a picture,
 * and that each call goes through VS Code's tool service — which is what
 * draws it and asks about it — with the conversation it belongs to.
 */

function frame(payload: object): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}
function saying(text: string): string {
	return frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
		+ frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
		+ frame({ type: 'content_block_stop', index: 0 })
		+ frame({ type: 'message_stop' });
}
function calling(id: string, name: string, input: object): string {
	return frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } })
		+ frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
		+ frame({ type: 'content_block_stop', index: 0 })
		+ frame({ type: 'message_stop' });
}

const tool = (id: string): IToolData => ({ id, displayName: id, modelDescription: `The ${id} tool.`, source: ToolDataSource.Internal, inputSchema: { type: 'object', properties: {} } });
const TOOLS = [tool('read_file'), tool('search_files'), tool('edit_file'), tool('run_in_terminal'), tool('mcp_db_query'), tool('vscode_get_confirmation')];

interface Setup {
	readonly bodies: { model: string; tools: { name: string }[]; system: string; messages: { role: string; content: unknown }[] }[];
	readonly invoked: IToolInvocation[];
	readonly progress: IChatProgress[];
	readonly agent: CloudeideChatAgent;
}

function setUp(readOnly: boolean, turns: string[], options: { signedIn?: boolean; cloud?: unknown } = {}): Setup {
	const bodies: Setup['bodies'] = [];
	const invoked: IToolInvocation[] = [];
	const progress: IChatProgress[] = [];
	const services = {
		client: {
			getToken: async () => options.signedIn === false ? undefined : 'token',
			orgRules: async () => [{ title: 'No secrets', body: 'Never commit keys.', required: true }],
			anthropicMessages: async (body: Setup['bodies'][number]) => {
				bodies.push(JSON.parse(JSON.stringify(body)));
				return new Response(turns.shift() ?? saying('(out of script)'));
			},
		},
		toolsService: {
			getTools: () => TOOLS,
			invokeTool: async (invocation: IToolInvocation): Promise<IToolResult> => {
				invoked.push(invocation);
				return { content: [{ kind: 'text', value: `result of ${invocation.toolId}` }] };
			},
		},
		configurationService: new TestConfigurationService({ 'cloudeide.model': 'claude-sonnet-5' }),
		editorService: { editors: [] },
		modelService: { getModel: () => null },
		fileService: { readFile: async () => { throw new Error('none'); }, resolve: async () => ({ children: [] }) },
		contextService: { getWorkspace: () => ({ folders: [{ uri: URI.file('/proj'), name: 'proj' }] }) },
		cloud: options.cloud,
	} as unknown as ChatAgentServices;
	return { bodies, invoked, progress, agent: new CloudeideChatAgent(readOnly, services) };
}

function request(overrides: Partial<IChatAgentRequest> = {}): IChatAgentRequest {
	return {
		sessionResource: URI.parse('vscode-chat-session://local/1'),
		requestId: 'req-1',
		agentId: 'cloudeide.agent',
		message: 'Fix the bug',
		variables: { variables: [] },
		location: 1,
		...overrides,
	} as IChatAgentRequest;
}

const said = (progress: IChatProgress[]) => progress.map(p => p.kind === 'markdownContent' ? p.content.value : '').join('');

suite('CloudeIDE chat agent', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Agent is offered every tool the person left on, and none of Copilot\'s plumbing', async () => {
		const s = setUp(false, [saying('Done.')]);
		await s.agent.invoke(request({ userSelectedTools: { mcp_db_query: false } }), p => s.progress.push(...p), [], CancellationToken.None);
		assert.deepStrictEqual(s.bodies[0].tools.map(t => t.name), ['read_file', 'search_files', 'edit_file', 'run_in_terminal']);
	});

	test('Ask is offered only tools that read', async () => {
		const s = setUp(true, [saying('It returns the total.')]);
		await s.agent.invoke(request(), p => s.progress.push(...p), [], CancellationToken.None);
		assert.deepStrictEqual(s.bodies[0].tools.map(t => t.name), ['read_file', 'search_files']);
		assert.ok(s.bodies[0].system.includes('This turn is a question'));
	});

	test('a tool call goes through the tool service, with the conversation it belongs to', async () => {
		const s = setUp(false, [calling('toolu_9', 'run_in_terminal', { command: 'npm test' }), saying('Tests pass.')]);
		await s.agent.invoke(request(), p => s.progress.push(...p), [], CancellationToken.None);
		assert.strictEqual(s.invoked.length, 1);
		assert.strictEqual(s.invoked[0].toolId, 'run_in_terminal');
		assert.strictEqual(s.invoked[0].callId, 'toolu_9');
		assert.strictEqual(s.invoked[0].chatRequestId, 'req-1');
		assert.strictEqual(s.invoked[0].context?.sessionResource.toString(), 'vscode-chat-session://local/1');
		assert.deepStrictEqual(s.invoked[0].parameters, { command: 'npm test' });
		const result = JSON.stringify(s.bodies[1].messages.at(-1));
		assert.ok(result.includes('result of run_in_terminal'), result);
		assert.strictEqual(said(s.progress), 'Tests pass.');
	});

	test('a picture the person attached reaches the model', async () => {
		const s = setUp(false, [saying('That button is misaligned.')]);
		await s.agent.invoke(request({
			variables: { variables: [{ id: 'img', kind: 'image', name: 'shot.png', value: new Uint8Array([9, 9]), mimeType: 'image/png' }] },
		} as Partial<IChatAgentRequest>), p => s.progress.push(...p), [], CancellationToken.None);
		const last = s.bodies[0].messages.at(-1)!.content as { type: string }[];
		assert.deepStrictEqual(last.map(b => b.type), ['image', 'text']);
	});

	test('runs on the model picked in the chat panel, and falls back to the setting', async () => {
		const picked = setUp(false, [saying('ok')]);
		await picked.agent.invoke(request({ userSelectedModelId: 'cloudeide/claude-opus-5-5' }), () => { }, [], CancellationToken.None);
		assert.strictEqual(picked.bodies[0].model, 'claude-opus-5-5');

		const other = setUp(false, [saying('ok')]);
		await other.agent.invoke(request({ userSelectedModelId: 'someone-else/model' }), () => { }, [], CancellationToken.None);
		assert.strictEqual(other.bodies[0].model, 'claude-sonnet-5');
	});

	test('the organisation\'s rules and the chosen mode\'s instructions are in the prompt', async () => {
		const s = setUp(false, [saying('Plan:')]);
		await s.agent.invoke(request({ modeInstructions: { name: 'Plan', content: 'Only plan, do not edit.', toolReferences: [] } }), () => { }, [], CancellationToken.None);
		assert.ok(s.bodies[0].system.includes('No secrets'));
		assert.ok(s.bodies[0].system.includes('## The mode the person chose: Plan\n\nOnly plan, do not edit.'));
	});

	test('what the person did in Cloud is known on the next turn, with the permissions', async () => {
		const cloud = {
			activity: () => [{ at: Date.now() - 2 * 60_000, by: 'you', kind: 'deploy', summary: 'deployment dpl_9 to production failed: build error' }],
			describeForModel: () => 'The person\'s Cloud permissions are "careful".',
		};
		const s = setUp(false, [saying('I see the failed production deploy.')], { cloud });
		await s.agent.invoke(request(), () => { }, [], CancellationToken.None);
		const system = s.bodies[0].system;
		assert.ok(system.includes('## Cloud right now'), system);
		assert.ok(system.includes('permissions are "careful"'));
		assert.ok(system.includes('- 2 min ago, the person: deployment dpl_9 to production failed: build error'), system);
	});

	test('earlier turns come along, alternating', async () => {
		const s = setUp(false, [saying('ok')]);
		const history = [{
			request: request({ message: 'What is this?' }),
			response: [{ kind: 'markdownContent', content: { value: 'A menu.' } }],
			result: {},
		}] as never;
		await s.agent.invoke(request(), () => { }, history, CancellationToken.None);
		assert.deepStrictEqual(s.bodies[0].messages.slice(0, 2), [
			{ role: 'user', content: 'What is this?' },
			{ role: 'assistant', content: 'A menu.' },
		]);
	});

	test('signed out, it says how to sign in and asks the server nothing', async () => {
		const s = setUp(false, [], { signedIn: false });
		await s.agent.invoke(request(), p => s.progress.push(...p), [], CancellationToken.None);
		assert.strictEqual(s.bodies.length, 0);
		assert.ok(said(s.progress).includes('command:cloudeide.signIn'));
	});

	test('a server error is said as the answer, not thrown', async () => {
		const s = setUp(false, []);
		(s.agent as unknown as { s: { client: { anthropicMessages: () => Promise<Response> } } }).s.client.anthropicMessages = async () => { throw new Error('Out of credits.'); };
		const result = await s.agent.invoke(request(), p => s.progress.push(...p), [], CancellationToken.None);
		assert.strictEqual(said(s.progress), 'Out of credits.');
		assert.strictEqual(result.errorDetails?.message, 'Out of credits.');
	});
});
