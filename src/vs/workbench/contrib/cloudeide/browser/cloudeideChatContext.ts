/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the chat panel hands the agent, turned into what the model reads.
 *
 * The chat panel is VS Code's own, and everything a person can put into it —
 * a picture pasted in, a `#file`, a folder dragged across, a selection, a
 * prompt file — arrives as a list of attachments beside the message. The
 * extension that used to turn those into a prompt does not ship here, so this
 * does it: text becomes a tagged block the model can tell apart from the
 * question, and a picture becomes a picture.
 *
 * Nothing here opens a file itself. Reading goes through the `reader` the
 * caller supplies, so the rules can be tested with no disk and no editor.
 */

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { ContentBlock } from './cloudeideAgentLoop.js';
import { AgentToolSchema } from './cloudeideAgentTools.js';

/** How much of one attached file travels. The rest can be read with a tool. */
export const MAX_ATTACHMENT_CHARS = 60_000;

/** The provider refuses more than this many pictures in one request. */
export const MAX_IMAGES = 20;

/** How many entries of an attached folder are named. */
const MAX_FOLDER_ENTRIES = 200;

/** How much of one tool's answer goes back to the model. */
export const MAX_TOOL_RESULT_CHARS = 100_000;

/** The attachment, in the loose shape the chat panel gives it. */
export interface ChatAttachment {
	readonly kind: string;
	readonly name: string;
	readonly value?: unknown;
	readonly modelDescription?: string;
	readonly mimeType?: string;
	readonly enabled?: boolean;
	readonly isSelection?: boolean;
	readonly code?: string;
	readonly language?: string;
	readonly imageData?: unknown;
	readonly imageMimeType?: string;
}

export interface AttachmentReader {
	/** The text of a file, as the editor has it if it is open. Undefined if it cannot be read. */
	readText(uri: URI): Promise<string | undefined>;
	/** The names in a folder, relative to it. Undefined if it cannot be listed. */
	listFolder(uri: URI): Promise<readonly string[] | undefined>;
	/** How to name a file to the model: relative to the project where possible. */
	label(uri: URI): string;
}

interface LocationLike { readonly uri: URI; readonly range: IRange }

function isLocation(value: unknown): value is LocationLike {
	return !!value && typeof value === 'object' && URI.isUri((value as LocationLike).uri) && !!(value as LocationLike).range;
}

/**
 * The attachments as content blocks: one text block holding every text
 * attachment, then one block per picture.
 *
 * One text block rather than one each, so the question the person typed is
 * still the last thing the model reads before it answers.
 */
export async function attachmentsToBlocks(attachments: readonly ChatAttachment[], reader: AttachmentReader): Promise<ContentBlock[]> {
	const texts: string[] = [];
	const images: ContentBlock[] = [];

	const image = (data: unknown, mimeType: string | undefined): boolean => {
		if (!(data instanceof Uint8Array) || images.length >= MAX_IMAGES) {
			return false;
		}
		images.push({
			type: 'image',
			source: { type: 'base64', media_type: mimeType || 'image/png', data: encodeBase64(VSBuffer.wrap(data)) },
		});
		return true;
	};

	for (const a of attachments) {
		switch (a.kind) {
			case 'image':
				image(a.value, a.mimeType);
				break;

			case 'implicit':
				// The file in front of the person, offered as a chip they can
				// switch off. Off means off.
				if (a.enabled === false) {
					break;
				}
			// falls through
			case 'file':
			case 'symbol': {
				const block = await fileBlock(a, reader);
				if (block) {
					texts.push(block);
				}
				break;
			}

			case 'directory': {
				if (URI.isUri(a.value)) {
					const names = await reader.listFolder(a.value);
					if (names) {
						const shown = names.slice(0, MAX_FOLDER_ENTRIES);
						const more = names.length > shown.length ? `\n(${names.length - shown.length} more)` : '';
						texts.push(tag('folder', reader.label(a.value), shown.join('\n') + more));
					}
				}
				break;
			}

			case 'paste':
				if (typeof a.code === 'string' && a.code.trim()) {
					texts.push(tag('pasted', a.language || a.name, a.code));
				}
				break;

			case 'promptFile': {
				// A prompt or instructions file: the project telling the
				// agent how to work. Sent as what it is, not as the question.
				const text = URI.isUri(a.value) ? await reader.readText(a.value) : undefined;
				if (text?.trim()) {
					texts.push(tag('instructions', URI.isUri(a.value) ? reader.label(a.value) : a.name, clip(text)));
				}
				break;
			}

			case 'element':
				if (typeof a.value === 'string' && a.value.trim()) {
					texts.push(tag('element', a.name, clip(a.value)));
				}
				image(a.imageData, a.imageMimeType);
				break;

			case 'tool':
			case 'toolset':
				// `#tool`: the person pointing at a tool. The tool itself is
				// already offered; this says they want it used.
				texts.push(`The person asked for the ${a.name} tool to be used.`);
				break;

			default: {
				const value = typeof a.value === 'string' ? a.value : a.modelDescription;
				if (value?.trim()) {
					texts.push(tag(a.kind, a.name, clip(value)));
				}
				break;
			}
		}
	}

	const blocks: ContentBlock[] = [];
	if (texts.length) {
		blocks.push({ type: 'text', text: `The person attached this to their message.\n\n${texts.join('\n\n')}` });
	}
	blocks.push(...images);
	return blocks;
}

async function fileBlock(a: ChatAttachment, reader: AttachmentReader): Promise<string | undefined> {
	const uri = URI.isUri(a.value) ? a.value : isLocation(a.value) ? a.value.uri : undefined;
	if (!uri) {
		return undefined;
	}
	const text = await reader.readText(uri);
	if (text === undefined) {
		return undefined;
	}
	const label = reader.label(uri);
	if (isLocation(a.value)) {
		const r = a.value.range;
		const lines = text.split(/\r\n|\r|\n/).slice(r.startLineNumber - 1, r.endLineNumber);
		const what = a.kind === 'symbol' ? `${a.name} in ${label}` : label;
		return tag(a.kind === 'symbol' ? 'symbol' : 'selection', `${what}, lines ${r.startLineNumber}-${r.endLineNumber}`, clip(lines.join('\n')));
	}
	return tag('file', label, clip(text));
}

function tag(kind: string, name: string, body: string): string {
	const safe = name.replace(/"/g, '\'');
	return `<attachment kind="${kind}" name="${safe}">\n${body}\n</attachment>`;
}

function clip(text: string, max = MAX_ATTACHMENT_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters; read the rest with a tool)` : text;
}

// ---- tools ------------------------------------------------------------------

/** A tool as the chat panel lists it, reduced to what the model is shown. */
export interface ChatToolInfo {
	readonly id: string;
	readonly modelDescription: string;
	readonly inputSchema?: object;
}

/**
 * Tools that exist for the Copilot extension's own machinery rather than for
 * a model to call — its confirmation prompts, its artifact store, handing a
 * turn to a sub-agent, leaving inline chat. Offered to this agent they would be dead ends.
 */
const NOT_FOR_THE_MODEL = new Set([
	'runSubagent', 'task_complete', 'setArtifacts', 'setArtifactRules', 'vscode_reviewPlan', 'inline_chat_exit',
]);

export function isToolForTheModel(tool: ChatToolInfo): boolean {
	if (!tool.modelDescription.trim() || NOT_FOR_THE_MODEL.has(tool.id)) {
		return false;
	}
	return !/_internal$|confirmation/i.test(tool.id);
}

/**
 * A name the provider accepts: letters, digits, `_` and `-`, at most 64.
 * MCP tools are named by their servers, and a server is free to put a dot or
 * a space in a name the provider would refuse the whole request over.
 */
export function toolNameFor(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
}

/**
 * The tools as the model sees them, and the way back from a name to a tool.
 * Two tools that sanitise to the same name keep the first; the second is not
 * offered rather than answering to a call that meant the other.
 */
export function toolSchemasFor(tools: readonly ChatToolInfo[]): { schemas: AgentToolSchema[]; idByName: Map<string, string> } {
	const schemas: AgentToolSchema[] = [];
	const idByName = new Map<string, string>();
	for (const tool of tools) {
		const name = toolNameFor(tool.id);
		if (idByName.has(name)) {
			continue;
		}
		idByName.set(name, tool.id);
		const schema = tool.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined;
		schemas.push({
			name,
			description: tool.modelDescription,
			input_schema: {
				...(schema ?? {}),
				type: 'object',
				properties: schema?.properties ?? {},
				...(schema?.required?.length ? { required: schema.required } : {}),
			},
		});
	}
	return { schemas, idByName };
}

export function clipToolResult(text: string): string {
	return text.length > MAX_TOOL_RESULT_CHARS
		? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (output cut at ${MAX_TOOL_RESULT_CHARS} characters)`
		: text;
}

// ---- edits ------------------------------------------------------------------

/**
 * The editor position of a character offset in `text`.
 *
 * Lines break at `\n`, `\r\n` or a lone `\r`, as the editor counts them, so
 * a range worked out here lands where the editor's own would.
 */
export function positionAt(text: string, offset: number): { lineNumber: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 10 /* \n */) {
			line++;
			lineStart = i + 1;
		} else if (ch === 13 /* \r */) {
			if (text.charCodeAt(i + 1) === 10 && i + 1 < offset) {
				i++;
			}
			line++;
			lineStart = i + 1;
		}
	}
	return { lineNumber: line, column: offset - lineStart + 1 };
}

/** The range from `start` to `end` offsets of `text`, in editor terms. */
export function rangeOf(text: string, start: number, end: number): IRange {
	const a = positionAt(text, start);
	const b = positionAt(text, end);
	return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
}

/**
 * One exact replacement, found and checked.
 *
 * The same rule the panel's `edit_file` keeps: the text must be there, and
 * there once. Replacing the first of several is how an edit lands somewhere
 * nobody meant.
 */
export function findReplacement(text: string, find: string): { start: number; end: number } | 'missing' | 'ambiguous' {
	const first = text.indexOf(find);
	if (first === -1) {
		return 'missing';
	}
	if (text.indexOf(find, first + find.length) !== -1) {
		return 'ambiguous';
	}
	return { start: first, end: first + find.length };
}
