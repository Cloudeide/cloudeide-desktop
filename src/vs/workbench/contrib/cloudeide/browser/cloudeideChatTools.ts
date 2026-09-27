/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent's file tools, registered where the chat panel looks for tools.
 *
 * The chat panel runs every tool through one service: that service draws the
 * call in the conversation, asks before anything that needs asking, and
 * lists the tool in the picker where a person can switch it off. Registering
 * these there, rather than calling them privately, is what makes a
 * `read_file` look and behave like every other tool on screen — and what
 * puts the agent's MCP tools, terminal and browser in the same list as its
 * own.
 *
 * Reading is the panel's code as it was. Writing is not: in the chat panel a
 * change goes into the editor straight away, marked, with Keep and Undo on
 * it and a checkpoint to return to — VS Code's own review, rather than the
 * staged diff the old panel drew for itself.
 */

import { autorun } from '../../../../base/common/observable.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { TextEdit } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IChatEditingSession } from '../../chat/common/editing/chatEditingService.js';
import { ChatModel } from '../../chat/common/model/chatModel.js';
import {
	CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl,
	IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress,
} from '../../chat/common/tools/languageModelToolsService.js';
import { AGENT_TOOLS, AgentToolSchema, CloudeideAgentTools } from './cloudeideAgentTools.js';
import { findReplacement, rangeOf } from './cloudeideChatContext.js';

/** The tools that only read. Ask mode gets these and nothing else. */
export const READ_TOOL_NAMES: readonly string[] = ['list_files', 'read_file', 'search_files', 'find_symbol', 'find_references', 'get_diagnostics'];

/** The tools that change files. */
export const WRITE_TOOL_NAMES: readonly string[] = ['edit_file', 'write_file'];

/**
 * What the model is told these do, where it differs from the panel.
 *
 * The panel staged edits for an Apply button; here they land in the editor
 * with Keep and Undo. A description that still said "staged" would have the
 * model tell the person to press a button that is not there.
 */
const CHAT_DESCRIPTIONS: Record<string, string> = {
	edit_file:
		'Replace an exact piece of text in a file. `find` must appear in the file exactly once — ' +
		'include enough surrounding lines to make it unique. The change goes into the editor at once, ' +
		'marked, and the person keeps or undoes it.',
	write_file:
		'Write a whole file, creating it if it does not exist. Use edit_file for a change to an ' +
		'existing file; this replaces everything in it. The change goes into the editor at once, ' +
		'marked, and the person keeps or undoes it.',
	get_diagnostics:
		'Read the errors and warnings the editor itself is reporting — type errors, lint, ' +
		'anything a language server found. Use this to see what is already broken before you ' +
		'change something, and after a change to see whether you fixed it or broke something else.',
};

const ICONS: Record<string, ThemeIcon> = {
	list_files: Codicon.listTree,
	read_file: Codicon.file,
	search_files: Codicon.search,
	find_symbol: Codicon.symbolMethod,
	find_references: Codicon.references,
	get_diagnostics: Codicon.warning,
	edit_file: Codicon.edit,
	write_file: Codicon.newFile,
};

/** A long wait for the editor to take an edit, and still not forever. */
const EDIT_SETTLE_MS = 15_000;

export class CloudeideChatToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideChatTools';

	private readonly tools: CloudeideAgentTools;

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IMarkerService markerService: IMarkerService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@IChatService private readonly chatService: IChatService,
	) {
		super();

		// No command runner and nobody to ask: in the chat panel the terminal
		// tool and the question tool are VS Code's own, and better at both.
		this.tools = new CloudeideAgentTools(
			fileService, contextService, searchService, instantiationService.createInstance(QueryBuilder),
			markerService, languageFeaturesService, textModelService, undefined, undefined,
		);

		for (const schema of AGENT_TOOLS) {
			if (!READ_TOOL_NAMES.includes(schema.name) && !WRITE_TOOL_NAMES.includes(schema.name)) {
				continue;
			}
			const data = toolData(schema);
			this._register(toolsService.registerTool(data, this.implementation(schema.name)));
			if (READ_TOOL_NAMES.includes(schema.name)) {
				this._register(toolsService.readToolSet.addTool(data));
			}
		}
	}

	private implementation(name: string): IToolImpl {
		return {
			prepareToolInvocation: async (context: IToolInvocationPreparationContext): Promise<IPreparedToolInvocation> => describe(name, context.parameters ?? {}),
			invoke: (invocation: IToolInvocation, _count: CountTokensCallback, _progress: ToolProgress, token: CancellationToken) => this.invoke(name, invocation, token),
		};
	}

	private async invoke(name: string, invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const input = (invocation.parameters ?? {}) as Record<string, unknown>;
		try {
			switch (name) {
				case 'read_file': return await this.readFile(input, token);
				case 'edit_file': return await this.editFile(input, invocation, token);
				case 'write_file': return await this.writeFile(input, invocation, token);
				default: {
					const result = await this.tools.run(name, input, token);
					return text(result.content, result.isError);
				}
			}
		} catch (err) {
			return text(err instanceof Error ? err.message : String(err), true);
		}
	}

	/** The one folder the agent may touch, and a path inside it. */
	private resolve(raw: unknown): { uri: URI; relative: string } {
		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			throw new Error('No folder is open. Open the project you want to work on first.');
		}
		if (typeof raw !== 'string' || !raw.trim()) {
			throw new Error('A path is required.');
		}
		const root = folders[0].uri;
		const relative = raw.replace(/^[./\\]+/, '').replace(/\\/g, '/');
		const uri = URI.joinPath(root, relative);
		const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
		if (uri.scheme !== root.scheme || !uri.path.startsWith(rootPath)) {
			throw new Error(`${raw} is outside the open project.`);
		}
		return { uri, relative };
	}

	/**
	 * The file as the editor has it.
	 *
	 * An edit the agent made a moment ago is in the editor and, until it is
	 * kept, not necessarily on disk. Reading the disk would hand the model the
	 * file from before its own change.
	 */
	private async currentText(uri: URI): Promise<string | undefined> {
		const open = this.modelService.getModel(uri);
		if (open) {
			return open.getValue();
		}
		if (!(await this.fileService.exists(uri))) {
			return undefined;
		}
		return (await this.fileService.readFile(uri)).value.toString();
	}

	private async readFile(input: Record<string, unknown>, token: CancellationToken): Promise<IToolResult> {
		const { uri } = this.resolve(input.path);
		if (this.modelService.getModel(uri)) {
			return text((await this.currentText(uri)) ?? '');
		}
		const result = await this.tools.run('read_file', input, token);
		return text(result.content, result.isError);
	}

	private async editFile(input: Record<string, unknown>, invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const { uri, relative } = this.resolve(input.path);
		const find = typeof input.find === 'string' ? input.find : '';
		const replace = typeof input.replace === 'string' ? input.replace : '';
		if (!find) {
			return text('`find` is required, and must be text that appears in the file.', true);
		}
		const before = await this.currentText(uri);
		if (before === undefined) {
			return text(`There is no file at ${relative}. Use write_file to create it.`, true);
		}
		const found = findReplacement(before, find);
		if (found === 'missing') {
			return text(`That text is not in ${relative}. Read the file and use text from it exactly.`, true);
		}
		if (found === 'ambiguous') {
			return text(`That text appears more than once in ${relative}. Include enough surrounding lines to make it unique.`, true);
		}
		await this.applyInChat(invocation, uri, [{ range: rangeOf(before, found.start, found.end), text: replace }], token);
		return text(`Edited ${relative}. The change is in the editor; the person keeps or undoes it.`);
	}

	private async writeFile(input: Record<string, unknown>, invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const { uri, relative } = this.resolve(input.path);
		const content = typeof input.content === 'string' ? input.content : undefined;
		if (content === undefined) {
			return text('`content` is required.', true);
		}
		const before = await this.currentText(uri);
		const range = before === undefined ? rangeOf('', 0, 0) : rangeOf(before, 0, before.length);
		await this.applyInChat(invocation, uri, [{ range, text: content }], token);
		return text(before === undefined
			? `Created ${relative}. It is in the editor; the person keeps or undoes it.`
			: `Replaced ${relative}. The change is in the editor; the person keeps or undoes it.`);
	}

	/**
	 * Hand the edit to the conversation's editing session.
	 *
	 * The edits, bracketed by an empty one to start and an empty one marked
	 * done. The editing session is watching the response for exactly that,
	 * and it is what applies the change, marks it in the editor and records
	 * the checkpoint.
	 *
	 * VS Code's own edit tool also writes a code block naming the file. That
	 * is left out: it is markdown, so the agent's next sentence joined it and
	 * was folded away with the tool steps — the answer never showed. The tool
	 * line ("Edited hello.js") and the Keep/Undo bar already name the file.
	 */
	private async applyInChat(invocation: IToolInvocation, uri: URI, edits: TextEdit[], token: CancellationToken): Promise<void> {
		const sessionResource = invocation.context?.sessionResource;
		const model = sessionResource ? this.chatService.getSession(sessionResource) as ChatModel | undefined : undefined;
		const request = model?.getRequests().find(r => r.id === invocation.chatRequestId) ?? model?.getRequests().at(-1);
		const session = model?.editingSession;
		if (!model || !request || !session) {
			throw new Error('Files can only be changed from the Agent mode of the chat panel.');
		}

		model.acceptResponseProgress(request, { kind: 'textEdit', edits: [], uri });
		model.acceptResponseProgress(request, { kind: 'textEdit', edits, uri });
		model.acceptResponseProgress(request, { kind: 'textEdit', edits: [], uri, done: true });

		await settled(session, uri, token);
	}
}

/**
 * Resolves once the editing session has finished applying to `uri`.
 *
 * It starts applying only once it has read the response, so "not being
 * modified" at the start means "not yet", not "done". A time limit, because
 * a tool that waits forever on the editor holds the whole turn with it.
 */
function settled(session: IChatEditingSession, uri: URI, token: CancellationToken): Promise<void> {
	return new Promise<void>(resolve => {
		let seen = false;
		let done = false;
		// Every way out comes through here, and only the first one counts.
		// The watcher is declared below and only reached through callbacks
		// that cannot run before it exists.
		const finish = () => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			cancel.dispose();
			watcher.dispose();
			resolve();
		};
		const timer = setTimeout(finish, EDIT_SETTLE_MS);
		const cancel = token.onCancellationRequested(finish);
		const watcher: IDisposable = autorun(reader => {
			const entry = session.entries.read(reader).find(e => isEqual(e.modifiedURI, uri));
			if (!entry) {
				return;
			}
			if (entry.isCurrentlyBeingModifiedBy.read(reader)) {
				seen = true;
			} else if (seen) {
				queueMicrotask(finish);
			}
		});
	});
}

function toolData(schema: AgentToolSchema): IToolData {
	return {
		id: schema.name,
		toolReferenceName: schema.name,
		displayName: displayName(schema.name),
		userDescription: displayName(schema.name),
		modelDescription: CHAT_DESCRIPTIONS[schema.name] ?? schema.description,
		inputSchema: schema.input_schema as IToolData['inputSchema'],
		source: ToolDataSource.Internal,
		icon: ICONS[schema.name],
		canBeReferencedInPrompt: true,
		runsInWorkspace: true,
	};
}

function displayName(name: string): string {
	switch (name) {
		case 'list_files': return localize('cloudeide.chatTool.list', "List Files");
		case 'read_file': return localize('cloudeide.chatTool.read', "Read File");
		case 'search_files': return localize('cloudeide.chatTool.search', "Search Files");
		case 'find_symbol': return localize('cloudeide.chatTool.symbol', "Find Symbol");
		case 'find_references': return localize('cloudeide.chatTool.references', "Find References");
		case 'get_diagnostics': return localize('cloudeide.chatTool.diagnostics', "Get Problems");
		case 'edit_file': return localize('cloudeide.chatTool.edit', "Edit File");
		case 'write_file': return localize('cloudeide.chatTool.write', "Write File");
		default: return name;
	}
}

/** The line the conversation shows while a tool runs, and after. */
function describe(name: string, input: Record<string, unknown>): IPreparedToolInvocation {
	const path = typeof input.path === 'string' ? input.path : '';
	const query = typeof input.query === 'string' ? input.query : '';
	const symbol = typeof input.name === 'string' ? input.name : '';
	switch (name) {
		case 'list_files': return {
			invocationMessage: localize('cloudeide.chatTool.listing', "Looking through the project"),
			pastTenseMessage: localize('cloudeide.chatTool.listed', "Looked through the project"),
		};
		case 'read_file': return {
			invocationMessage: localize('cloudeide.chatTool.reading', "Reading {0}", path),
			pastTenseMessage: localize('cloudeide.chatTool.readPast', "Read {0}", path),
		};
		case 'search_files': return {
			invocationMessage: localize('cloudeide.chatTool.searching', "Searching for {0}", query),
			pastTenseMessage: localize('cloudeide.chatTool.searched', "Searched for {0}", query),
		};
		case 'find_symbol': return {
			invocationMessage: localize('cloudeide.chatTool.finding', "Finding where {0} is declared", symbol),
			pastTenseMessage: localize('cloudeide.chatTool.found', "Found where {0} is declared", symbol),
		};
		case 'find_references': return {
			invocationMessage: localize('cloudeide.chatTool.refsFinding', "Finding what uses {0}", symbol),
			pastTenseMessage: localize('cloudeide.chatTool.refsFound', "Found what uses {0}", symbol),
		};
		case 'get_diagnostics': return {
			invocationMessage: localize('cloudeide.chatTool.checking', "Checking for problems"),
			pastTenseMessage: localize('cloudeide.chatTool.checked', "Checked for problems"),
		};
		case 'edit_file': return {
			invocationMessage: localize('cloudeide.chatTool.editing', "Editing {0}", path),
			pastTenseMessage: localize('cloudeide.chatTool.edited', "Edited {0}", path),
		};
		case 'write_file': return {
			invocationMessage: localize('cloudeide.chatTool.writing', "Writing {0}", path),
			pastTenseMessage: localize('cloudeide.chatTool.wrote', "Wrote {0}", path),
		};
		default: return {};
	}
}

function text(value: string, isError?: boolean): IToolResult {
	return { content: [{ kind: 'text', value }], ...(isError ? { toolResultError: value } : {}) };
}
