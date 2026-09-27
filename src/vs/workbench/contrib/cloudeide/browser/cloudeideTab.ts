/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CloudeIDE Tab: the parts that decide what is asked and what is kept.
 *
 * Grey text after a pause, Tab to keep it — the habit every developer
 * already has, and not something to be different about. What this product
 * adds sits around it: the suggestion follows the organisation's rules and
 * the project's own `AGENTS.md`, says so when a rule decided it, and a whole
 * function kept with Tab can be handed to the agent for a test.
 *
 * Nothing here touches the editor or the network, so all of it is tested
 * directly. `cloudeideTabCompletion.ts` is the part that does.
 */

/** Fast and cheap: a suggestion is asked for on nearly every pause. */
export const TAB_MODEL = 'claude-haiku-4-5';

/** Long enough for a short function body; a suggestion is not a feature. */
export const TAB_MAX_TOKENS = 256;

/** How much of the file travels with each request, either side of the cursor. */
export const TAB_PREFIX_CHARS = 4000;
export const TAB_SUFFIX_CHARS = 1500;

/** More than this and it is no longer a suggestion; it is the agent's job. */
export const TAB_MAX_LINES = 12;

const MAX_RULES_CHARS = 2000;

export interface TabRule {
	readonly title: string;
	readonly body: string;
	readonly required?: boolean;
}

export interface TabContext {
	/** Workspace-relative where possible; it is shown to the model, not opened. */
	readonly path: string;
	readonly languageId: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly rules: readonly TabRule[];
	/** The project's `AGENTS.md` or `.cloudeiderules`, if it has one. */
	readonly projectRules?: string;
}

export interface TabRequest {
	readonly model: string;
	readonly max_tokens: number;
	readonly temperature: number;
	readonly system: string;
	readonly messages: readonly { role: 'user'; content: string }[];
}

export interface TabSuggestion {
	readonly text: string;
	/** Title of the team rule the model says decided this, when it is a real one. */
	readonly rule?: string;
}

/**
 * The request for one suggestion.
 *
 * The reply format is two tags rather than JSON: a model asked for JSON
 * around a code fragment has to escape every quote and newline in it, and
 * the first one it gets wrong is a suggestion that never appears.
 */
export function buildTabRequest(ctx: TabContext): TabRequest {
	const system = [
		'You are the inline code completion inside the CloudeIDE editor.',
		'You are shown one file with a <cursor/> marker where the person is typing.',
		'Reply with only the text to insert at the cursor, inside <insert></insert>.',
		'Do not repeat code that is already before or after the cursor.',
		`Finish the current statement or block and stop at a natural end, at most ${TAB_MAX_LINES} lines.`,
		'Match the file\'s indentation, quotes and naming.',
		'If nothing useful should be inserted, reply <insert></insert>.',
		'Never write passwords, API keys, tokens or other secrets into code; read them from the environment instead.',
		...rulesSection(ctx),
	].join('\n');

	const content = [
		`File: ${ctx.path} (${ctx.languageId})`,
		'',
		'<file>',
		`${ctx.prefix}<cursor/>${ctx.suffix}`,
		'</file>',
	].join('\n');

	return {
		model: TAB_MODEL,
		max_tokens: TAB_MAX_TOKENS,
		temperature: 0,
		system,
		messages: [{ role: 'user', content }],
	};
}

function rulesSection(ctx: TabContext): string[] {
	const out: string[] = [];
	if (ctx.rules.length) {
		out.push(
			'',
			'Team rules from this person\'s organization. Follow them in what you insert.',
			'If one of them decided what you wrote, add <rule>that rule\'s title</rule> after </insert>.',
		);
		let used = 0;
		for (const rule of ctx.rules) {
			const line = `- ${rule.title}${rule.required ? ' (required)' : ''}: ${rule.body}`;
			if (used + line.length > MAX_RULES_CHARS) {
				break;
			}
			out.push(line);
			used += line.length;
		}
	}
	const project = ctx.projectRules?.trim();
	if (project) {
		out.push('', 'This project\'s own notes on how code here is written:', project.slice(0, MAX_RULES_CHARS));
	}
	return out;
}

/**
 * What to insert, from the model's reply — or nothing.
 *
 * Strict about the tag: a reply without `<insert>` is a model that did not
 * follow the format, and guessing which part of it was meant as code is how
 * an explanation ends up typed into somebody's file.
 */
export function parseTabReply(reply: string, ctx: Pick<TabContext, 'suffix' | 'rules'>): TabSuggestion | undefined {
	const match = /<insert>([\s\S]*?)<\/insert>/.exec(reply);
	if (!match) {
		return undefined;
	}
	let text = stripFence(match[1]);
	text = trimSuffixOverlap(text, ctx.suffix);
	text = text.replace(/(?:[ \t]*\n)+[ \t]*$/, '');

	const lines = text.split('\n');
	if (lines.length > TAB_MAX_LINES) {
		text = lines.slice(0, TAB_MAX_LINES).join('\n');
	}
	if (!text.trim()) {
		return undefined;
	}

	// Only a rule that exists. A model that names one it made up would put a
	// claim about the organisation's policy on screen that nobody wrote.
	const named = /<rule>([\s\S]*?)<\/rule>/.exec(reply)?.[1].trim().toLowerCase();
	const rule = named ? ctx.rules.find(r => r.title.trim().toLowerCase() === named)?.title : undefined;
	return rule ? { text, rule } : { text };
}

function stripFence(text: string): string {
	const fenced = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
	return fenced ? fenced[1] : text;
}

/**
 * Drop the end of a suggestion that the file already has after the cursor.
 *
 * The common case is a closing brace: the person typed `{`, the editor put
 * `}` after the cursor, and the model — told not to — writes the `}` again.
 * Only overlaps with something other than whitespace in them count; matching
 * a lone newline would eat line breaks that are meant to be there.
 */
function trimSuffixOverlap(text: string, suffix: string): string {
	const max = Math.min(text.length, suffix.length);
	for (let k = max; k > 0; k--) {
		const head = suffix.slice(0, k);
		if (head.trim() && text.endsWith(head)) {
			return text.slice(0, -k);
		}
	}
	return text;
}

const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'else']);

/**
 * The function being written on this line, if the line starts one.
 *
 * Deliberately a few plain patterns rather than a parser: this only decides
 * whether to offer a test, and offering one for a line that was not quite a
 * declaration costs a dismissed notification.
 */
export function functionNameAt(lineBeforeCursor: string): string | undefined {
	const patterns = [
		/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
		/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
		/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
		/^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
	];
	for (const re of patterns) {
		const name = re.exec(lineBeforeCursor)?.[1];
		if (name && !NOT_FUNCTIONS.has(name)) {
			return name;
		}
	}
	return undefined;
}

/**
 * Whether keeping this suggestion finished a function worth testing, and
 * which one.
 *
 * A body, not a one-line tweak: at least two lines inserted, and for brace
 * languages the function closed — either by a brace in the suggestion, or by
 * the one already waiting after the cursor. That second case is the usual
 * one: typing `{` makes the editor add `}`, and the suggestion rightly does
 * not type it again.
 */
export function testOfferFor(lineBeforeCursor: string, inserted: string, languageId: string, suffix = ''): string | undefined {
	const name = functionNameAt(lineBeforeCursor);
	if (!name) {
		return undefined;
	}
	const lines = inserted.split('\n').filter(l => l.trim());
	if (lines.length < 2) {
		return undefined;
	}
	const braces = languageId !== 'python';
	if (braces && !/^\s*\}/m.test(inserted) && !/^\s*\}/.test(suffix)) {
		return undefined;
	}
	return name;
}

/**
 * The command that hands a request to the agent panel, as if typed there.
 * A command rather than an import, so Tab does not depend on the panel.
 */
export const ASK_AGENT_COMMAND = 'cloudeide.askAgent';

/** What the agent is asked when the person takes the offer. */
export function testRequestFor(name: string, path: string): string {
	return `Write tests for the function \`${name}\` in ${path}. Put them where this project keeps its tests, in the style of the tests already there, then run them and fix anything that fails.`;
}

// ---- today's usage ---------------------------------------------------------

export interface TabUsage {
	readonly day: string;
	readonly suggestions: number;
	readonly tokens: number;
}

/** The local calendar day, which is what "today" means to the person reading it. */
export function dayKey(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Add one suggestion to today's count, starting again on a new day. */
export function addUsage(previous: TabUsage | undefined, day: string, tokens: number): TabUsage {
	const base = previous && previous.day === day ? previous : { day, suggestions: 0, tokens: 0 };
	return { day, suggestions: base.suggestions + 1, tokens: base.tokens + Math.max(0, Math.round(tokens)) };
}

/** Parse what storage gave back, or nothing if it is not usage. */
export function readUsage(raw: string | undefined): TabUsage | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const value = JSON.parse(raw) as Partial<TabUsage>;
		if (typeof value.day === 'string' && typeof value.suggestions === 'number' && typeof value.tokens === 'number') {
			return { day: value.day, suggestions: value.suggestions, tokens: value.tokens };
		}
	} catch {
		// Not ours, or damaged. Start the day's count again.
	}
	return undefined;
}

/** "42 suggestions · 81k tokens", for the Tab menu. */
export function describeUsage(usage: TabUsage | undefined, today: string): string {
	const u = usage && usage.day === today ? usage : { suggestions: 0, tokens: 0 };
	const tokens = u.tokens >= 1000 ? `${Math.round(u.tokens / 1000)}k` : String(u.tokens);
	return `${u.suggestions} suggestion${u.suggestions === 1 ? '' : 's'} · ${tokens} tokens`;
}
