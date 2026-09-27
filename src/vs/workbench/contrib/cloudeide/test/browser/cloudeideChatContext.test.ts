/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildAgentSystemPrompt } from '../../browser/cloudeideAgentPrompt.js';
import {
	attachmentsToBlocks, AttachmentReader, findReplacement, isToolForTheModel, MAX_IMAGES,
	positionAt, rangeOf, toolNameFor, toolSchemasFor,
} from '../../browser/cloudeideChatContext.js';
import { modelDisplayName } from '../../browser/cloudeideLanguageModel.js';

/**
 * What the chat panel collects, as the model will read it.
 *
 * The chat panel is VS Code's; the part that is ours is the translation —
 * and a translation that drops a picture, reads a chip the person switched
 * off, or puts a range one line out is wrong in a way nobody sees until an
 * answer is about the wrong code.
 */

const ROOT = URI.file('/proj');
const FILES: Record<string, string> = {
	'/proj/src/a.js': 'one\ntwo\nthree\nfour\n',
	'/proj/.github/copilot-instructions.md': 'Use tabs.',
};

const reader: AttachmentReader = {
	readText: async uri => FILES[uri.path],
	listFolder: async uri => uri.path === '/proj/src' ? ['a.js', 'lib/'] : undefined,
	label: uri => uri.path.startsWith('/proj/') ? uri.path.slice('/proj/'.length) : uri.path,
};

suite('CloudeIDE chat context', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a picture becomes a picture, after the text', async () => {
		const blocks = await attachmentsToBlocks([
			{ kind: 'image', name: 'shot.png', value: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
			{ kind: 'file', name: 'a.js', value: URI.joinPath(ROOT, 'src/a.js') },
		], reader);
		assert.strictEqual(blocks.length, 2);
		assert.strictEqual(blocks[0].type, 'text');
		assert.deepStrictEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } });
	});

	test('no more pictures than the provider takes', async () => {
		const many = Array.from({ length: MAX_IMAGES + 3 }, (_, i) => ({ kind: 'image', name: `${i}.png`, value: new Uint8Array([i]) }));
		const blocks = await attachmentsToBlocks(many, reader);
		assert.strictEqual(blocks.filter(b => b.type === 'image').length, MAX_IMAGES);
	});

	test('a #file travels whole, named relative to the project', async () => {
		const [block] = await attachmentsToBlocks([{ kind: 'file', name: 'a.js', value: URI.joinPath(ROOT, 'src/a.js') }], reader);
		assert.ok(block.type === 'text' && block.text.includes('<attachment kind="file" name="src/a.js">\none\ntwo\nthree\nfour\n'), JSON.stringify(block));
	});

	test('a selection travels as its lines only', async () => {
		const [block] = await attachmentsToBlocks([{
			kind: 'file', name: 'a.js',
			value: { uri: URI.joinPath(ROOT, 'src/a.js'), range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 6 } },
		}], reader);
		assert.ok(block.type === 'text');
		assert.ok(block.text.includes('lines 2-3">\ntwo\nthree\n</attachment>'), block.text);
	});

	test('the current-file chip, switched off, sends nothing', async () => {
		const blocks = await attachmentsToBlocks([{ kind: 'implicit', name: 'a.js', value: URI.joinPath(ROOT, 'src/a.js'), enabled: false }], reader);
		assert.deepStrictEqual(blocks, []);
	});

	test('a folder is named, not read', async () => {
		const [block] = await attachmentsToBlocks([{ kind: 'directory', name: 'src', value: URI.joinPath(ROOT, 'src') }], reader);
		assert.ok(block.type === 'text' && block.text.includes('<attachment kind="folder" name="src">\na.js\nlib/\n'), JSON.stringify(block));
	});

	test('pasted code and instruction files keep what they are', async () => {
		const [block] = await attachmentsToBlocks([
			{ kind: 'paste', name: 'Pasted', code: 'let x = 1;', language: 'javascript' },
			{ kind: 'promptFile', name: 'copilot-instructions', value: URI.joinPath(ROOT, '.github/copilot-instructions.md') },
		], reader);
		assert.ok(block.type === 'text');
		assert.ok(block.text.includes('<attachment kind="pasted" name="javascript">\nlet x = 1;'), block.text);
		assert.ok(block.text.includes('<attachment kind="instructions" name=".github/copilot-instructions.md">\nUse tabs.'), block.text);
	});

	test('a file that cannot be read is left out rather than sent empty', async () => {
		const blocks = await attachmentsToBlocks([{ kind: 'file', name: 'gone.js', value: URI.joinPath(ROOT, 'gone.js') }], reader);
		assert.deepStrictEqual(blocks, []);
	});

	test('tool names the provider would refuse are made safe, and a clash keeps the first', () => {
		assert.strictEqual(toolNameFor('mcp_github.create issue'), 'mcp_github_create_issue');
		assert.strictEqual(toolNameFor('x'.repeat(90)).length, 64);
		const { schemas, idByName } = toolSchemasFor([
			{ id: 'a.b', modelDescription: 'first' },
			{ id: 'a_b', modelDescription: 'second' },
		]);
		assert.deepStrictEqual(schemas.map(s => s.description), ['first']);
		assert.strictEqual(idByName.get('a_b'), 'a.b');
		assert.deepStrictEqual(schemas[0].input_schema, { type: 'object', properties: {} });
	});

	test('Copilot\'s own plumbing is not offered to the model', () => {
		assert.ok(isToolForTheModel({ id: 'run_in_terminal', modelDescription: 'Run a command' }));
		assert.ok(isToolForTheModel({ id: 'mcp_github_search', modelDescription: 'Search' }));
		assert.ok(!isToolForTheModel({ id: 'vscode_editFile_internal', modelDescription: 'x' }));
		assert.ok(!isToolForTheModel({ id: 'vscode_get_confirmation', modelDescription: 'x' }));
		assert.ok(!isToolForTheModel({ id: 'runSubagent', modelDescription: 'x' }));
		assert.ok(!isToolForTheModel({ id: 'inline_chat_exit', modelDescription: 'x' }));
		assert.ok(!isToolForTheModel({ id: 'no_description', modelDescription: '' }));
	});

	test('positions count lines the way the editor does', () => {
		assert.deepStrictEqual(positionAt('ab\ncd', 4), { lineNumber: 2, column: 2 });
		assert.deepStrictEqual(positionAt('ab\r\ncd', 5), { lineNumber: 2, column: 2 });
		assert.deepStrictEqual(positionAt('ab\rcd', 4), { lineNumber: 2, column: 2 });
		assert.deepStrictEqual(rangeOf('', 0, 0), { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 });
		const text = 'function f() {\r\n\treturn 1;\r\n}\r\n';
		const found = findReplacement(text, '\treturn 1;');
		assert.ok(typeof found === 'object');
		assert.deepStrictEqual(rangeOf(text, found.start, found.end), { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 11 });
	});

	test('a replacement must be there, and there once', () => {
		assert.strictEqual(findReplacement('a b a', 'a'), 'ambiguous');
		assert.strictEqual(findReplacement('a b', 'c'), 'missing');
		assert.deepStrictEqual(findReplacement('a b', 'b'), { start: 2, end: 3 });
	});

	test('in the chat panel the prompt names VS Code\'s tools and its review, not the old panel\'s', () => {
		const chat = buildAgentSystemPrompt({ workspaceName: 'p', openFiles: [], surface: 'chat' });
		assert.ok(chat.includes('run_in_terminal'));
		assert.ok(chat.includes('vscode_askQuestions'));
		assert.ok(chat.includes('keeps or undoes'));
		assert.ok(!chat.includes('Apply button'));
		assert.ok(!chat.includes('run_command'));

		const panel = buildAgentSystemPrompt({ workspaceName: 'p', openFiles: [] });
		assert.ok(panel.includes('run_command'));
		assert.ok(panel.includes('Apply button'));
	});

	test('in the chat panel the agent keeps a visible plan and shows what it built', () => {
		const chat = buildAgentSystemPrompt({ workspaceName: 'p', openFiles: [], surface: 'chat' });
		assert.ok(chat.includes('manage_todo_list'));
		assert.ok(chat.includes('open_browser_page'));
		assert.ok(!chat.includes('Do not announce a plan'));

		// The old panel has neither tool, so it is told about neither.
		const panel = buildAgentSystemPrompt({ workspaceName: 'p', openFiles: [] });
		assert.ok(!panel.includes('manage_todo_list'));
		assert.ok(!panel.includes('open_browser_page'));
	});

	test('models are named the way people say them', () => {
		assert.strictEqual(modelDisplayName('claude-sonnet-5'), 'Sonnet 5');
		assert.strictEqual(modelDisplayName('claude-haiku-4-5'), 'Haiku 4.5');
		assert.strictEqual(modelDisplayName('gpt-5.6-sol'), 'GPT-5.6 Sol');
	});
});
