/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	addUsage, buildTabRequest, dayKey, describeUsage, functionNameAt, parseTabReply, readUsage,
	TAB_MAX_LINES, TAB_MODEL, testOfferFor, testRequestFor,
} from '../../browser/cloudeideTab.js';

/**
 * Tab puts text into somebody's file without being asked, dozens of times an
 * hour. So what is worth holding down is mostly what it must not do: type an
 * explanation, repeat the brace that is already there, claim a rule nobody
 * wrote, or put a secret in the code.
 */
const RULES = [{ title: 'Use the shared fetch helper', body: 'API calls go through lib/http.js.', required: false }];

suite('CloudeIDE Tab', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('asks the fast model, with the cursor marked in the file', () => {
		const req = buildTabRequest({ path: 'src/pricing.js', languageId: 'javascript', prefix: 'function f(a) {', suffix: '\n}', rules: [] });
		assert.strictEqual(req.model, TAB_MODEL);
		assert.strictEqual(req.temperature, 0);
		assert.ok(req.messages[0].content.includes('function f(a) {<cursor/>\n}'));
		assert.ok(req.messages[0].content.includes('src/pricing.js (javascript)'));
	});

	test('tells the model never to write secrets into code', () => {
		const req = buildTabRequest({ path: 'a.js', languageId: 'javascript', prefix: '', suffix: '', rules: [] });
		assert.ok(/secrets/i.test(req.system));
	});

	test('carries team rules and the project\'s own notes', () => {
		const req = buildTabRequest({ path: 'a.js', languageId: 'javascript', prefix: '', suffix: '', rules: RULES, projectRules: 'Tabs, not spaces.' });
		assert.ok(req.system.includes('Use the shared fetch helper'));
		assert.ok(req.system.includes('Tabs, not spaces.'));
	});

	test('with no rules, says nothing about rules', () => {
		const req = buildTabRequest({ path: 'a.js', languageId: 'javascript', prefix: '', suffix: '', rules: [] });
		assert.ok(!req.system.includes('<rule>'));
	});

	test('takes only what is inside <insert>', () => {
		const s = parseTabReply('Sure! <insert>\n  return a * 2;</insert> Hope that helps.', { suffix: '', rules: [] });
		assert.deepStrictEqual(s, { text: '\n  return a * 2;' });
	});

	test('a reply without the tag inserts nothing', () => {
		assert.strictEqual(parseTabReply('return a * 2;', { suffix: '', rules: [] }), undefined);
	});

	test('an empty insert is no suggestion', () => {
		assert.strictEqual(parseTabReply('<insert>  \n </insert>', { suffix: '', rules: [] }), undefined);
	});

	test('does not repeat the closing brace that is already after the cursor', () => {
		const s = parseTabReply('<insert>\n  return a;\n}</insert>', { suffix: '\n}\n\nexport const b = 1;', rules: [] });
		assert.strictEqual(s?.text, '\n  return a;');
	});

	test('a code fence around the insert is removed', () => {
		const s = parseTabReply('<insert>```js\nreturn 1;\n```</insert>', { suffix: '', rules: [] });
		assert.strictEqual(s?.text, 'return 1;');
	});

	test('is cut to the line limit', () => {
		const long = Array.from({ length: TAB_MAX_LINES + 5 }, (_, i) => `x${i};`).join('\n');
		const s = parseTabReply(`<insert>${long}</insert>`, { suffix: '', rules: [] });
		assert.strictEqual(s?.text.split('\n').length, TAB_MAX_LINES);
	});

	test('names a rule only when the organisation has one by that title', () => {
		const real = parseTabReply('<insert>return http.get(\'/api\');</insert><rule>use the shared fetch helper</rule>', { suffix: '', rules: RULES });
		assert.strictEqual(real?.rule, 'Use the shared fetch helper');
		const invented = parseTabReply('<insert>x;</insert><rule>Always use tabs</rule>', { suffix: '', rules: RULES });
		assert.strictEqual(invented?.rule, undefined);
	});

	test('recognises a function being declared, in the common languages', () => {
		assert.strictEqual(functionNameAt('export function teamCost(plan, seats) {'), 'teamCost');
		assert.strictEqual(functionNameAt('const total = (items) => {'), 'total');
		assert.strictEqual(functionNameAt('export const load = async () => {'), 'load');
		assert.strictEqual(functionNameAt('def yearly(plan):'), 'yearly');
		assert.strictEqual(functionNameAt('func Total(items []int) int {'), 'Total');
		assert.strictEqual(functionNameAt('  async fetchPlans(id: string): Promise<Plan[]> {'), 'fetchPlans');
	});

	test('does not mistake control flow for a function', () => {
		assert.strictEqual(functionNameAt('  if (seats > 10) {'), undefined);
		assert.strictEqual(functionNameAt('  for (const p of plans) {'), undefined);
		assert.strictEqual(functionNameAt('const x = 5;'), undefined);
	});

	test('offers a test only for a whole function body', () => {
		const line = 'export function teamCost(plan, seats) {';
		assert.strictEqual(testOfferFor(line, '\n  if (seats <= 0) return 0;\n  return plan.monthly * seats;\n}', 'javascript'), 'teamCost');
		assert.strictEqual(testOfferFor(line, ' return 1;', 'javascript'), undefined, 'one line');
		assert.strictEqual(testOfferFor(line, '\n  const a = 1;\n  return a;', 'javascript'), undefined, 'no closing brace yet');
		assert.strictEqual(testOfferFor('def yearly(plan):', '\n    total = plan * 12\n    return total', 'python'), 'yearly');
	});

	test('counts the closing brace the editor already put after the cursor', () => {
		// Typing `{` adds `}`; the suggestion leaves it alone, and the
		// function is still finished.
		const line = 'export function teamCost(plan, seats) {';
		assert.strictEqual(testOfferFor(line, '\n  if (seats <= 0) return 0;\n  return plan.monthly * seats;', 'javascript', '\n}\n'), 'teamCost');
		assert.strictEqual(testOfferFor(line, '\n  const a = 1;\n  return a;', 'javascript', '\n  more();\n}'), undefined);
	});

	test('the test request names the function and the file', () => {
		const text = testRequestFor('teamCost', 'src/pricing.js');
		assert.ok(text.includes('`teamCost`') && text.includes('src/pricing.js'));
	});

	test('counts today\'s suggestions and starts again the next day', () => {
		let u = addUsage(undefined, '2026-09-27', 1800);
		u = addUsage(u, '2026-09-27', 2200);
		assert.deepStrictEqual(u, { day: '2026-09-27', suggestions: 2, tokens: 4000 });
		assert.deepStrictEqual(addUsage(u, '2026-09-28', 100), { day: '2026-09-28', suggestions: 1, tokens: 100 });
		assert.strictEqual(describeUsage(u, '2026-09-27'), '2 suggestions · 4k tokens');
		assert.strictEqual(describeUsage(u, '2026-09-28'), '0 suggestions · 0 tokens');
	});

	test('stored usage that is damaged reads as none', () => {
		assert.strictEqual(readUsage('not json'), undefined);
		assert.strictEqual(readUsage('{"day":1}'), undefined);
		assert.deepStrictEqual(readUsage('{"day":"2026-09-27","suggestions":3,"tokens":9}'), { day: '2026-09-27', suggestions: 3, tokens: 9 });
		assert.strictEqual(dayKey(new Date(2026, 8, 7)), '2026-09-07');
	});
});
