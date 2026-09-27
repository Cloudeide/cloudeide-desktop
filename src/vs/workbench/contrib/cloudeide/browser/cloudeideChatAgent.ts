/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent behind the chat panel.
 *
 * The chat panel is VS Code's own — attachments, `#` references, the tool
 * picker, MCP, Keep and Undo, checkpoints — and none of it does anything
 * without an agent to hand a request to. The one it was built for came in the
 * Copilot extension, which this product does not ship. This is ours: the same
 * loop and the same prompt as the agent that used to have a panel of its own,
 * given everything the chat panel collects.
 *
 * The model runs on the server, on the person's account; every tool runs here.
 * The tools are whatever the chat panel's tool service holds and the person
 * has left switched on — the file tools this product registers, the editor's
 * terminal and browser, and every MCP server they have connected. Each call
 * goes through that service, so it is drawn in the conversation and asked
 * about exactly as VS Code would ask.
 *
 * Two agents, one per kind of turn: Ask reads and answers; Agent (and Edit)
 * changes files and runs things. Registering them apart is what makes the
 * difference a fence rather than a request — an Ask turn is not offered a tool
 * that writes, so there is nothing for the model to decide to respect.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatProgress, IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import {
	IChatAgentData,
	IChatAgentHistoryEntry,
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentService,
} from '../../chat/common/participants/chatAgents.js';
import { ILanguageModelToolsService, toolContentToA11yString } from '../../chat/common/tools/languageModelToolsService.js';
import { ContentBlock, Message, runAgentLoop } from './cloudeideAgentLoop.js';
import { buildAgentSystemPrompt } from './cloudeideAgentPrompt.js';
import { AgentToolResult } from './cloudeideAgentTools.js';
import { attachmentsToBlocks, AttachmentReader, ChatAttachment, clipToolResult, isToolForTheModel, toolSchemasFor } from './cloudeideChatContext.js';
import { READ_TOOL_NAMES } from './cloudeideChatTools.js';
import { CloudeideClient } from './cloudeideClient.js';
import { DEFAULT_MODEL, MODEL_SETTING, VENDOR } from './cloudeideLanguageModel.js';
import { CloudeidePullRequests, describeChange } from './cloudeidePullRequest.js';

const AGENT_ID = 'cloudeide.agent';
const ASK_ID = 'cloudeide.ask';

/** The sign-in command, registered by `cloudeideSignIn.ts`. */
const SIGN_IN_COMMAND = 'cloudeide.signIn';

/** The command that opens Cloud, registered by `cloudeide.contribution.ts`. */
const OPEN_CLOUD_COMMAND = 'cloudeide.openCloud';

/**
 * How many rounds of tool calls one turn may take. More than the old panel's
 * twenty-four: this agent has the terminal and the browser as well as the
 * files, and a task that runs the tests, fixes, and runs them again spends
 * rounds quickly.
 */
const MAX_STEPS = 40;

/** How much of a project's instructions file is read into the prompt. */
const MAX_PROJECT_RULES_CHARS = 16 * 1024;

export interface ChatAgentServices {
	readonly client: CloudeideClient;
	readonly toolsService: ILanguageModelToolsService;
	readonly configurationService: IConfigurationService;
	readonly editorService: IEditorService;
	readonly modelService: IModelService;
	readonly fileService: IFileService;
	readonly contextService: IWorkspaceContextService;
	readonly chatService: IChatService;
	readonly quickInputService: IQuickInputService;
	readonly dialogService: IDialogService;
	readonly commandService: ICommandService;
}

export class CloudeideChatAgent implements IChatAgentImplementation {

	constructor(
		/** Ask: read-only tools, and told so. */
		private readonly readOnly: boolean,
		private readonly s: ChatAgentServices,
	) { }

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const say = (text: string, trusted?: string[]) => progress([{
			kind: 'markdownContent',
			content: new MarkdownString(text, trusted ? { isTrusted: { enabledCommands: trusted } } : undefined),
		}]);

		if (!(await this.s.client.getToken())) {
			say(localize('cloudeide.chat.signIn', "Sign in to CloudeIDE to use chat. [Sign in](command:{0})", SIGN_IN_COMMAND), [SIGN_IN_COMMAND]);
			return {};
		}

		try {
			switch (request.command) {
				case 'pr': return await this.pullRequest(request, history, say);
				case 'deploy':
					await this.s.commandService.executeCommand(OPEN_CLOUD_COMMAND);
					say(localize('cloudeide.chat.deploy', "Cloud is open. Deploy from there."));
					return {};
			}
			return await this.run(request, progress, history, token);
		} catch (err) {
			if (isCancellationError(err) || token.isCancellationRequested) {
				return {};
			}
			const message = err instanceof Error ? err.message : String(err);
			// Said as the answer rather than thrown. A thrown error is drawn
			// as an internal failure, and this is usually something the person
			// can act on: out of credits, not connected, a model refused.
			say(message);
			return { errorDetails: { message } };
		}
	}

	private async run(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const folder = this.s.contextService.getWorkspace().folders[0];
		const openFiles = this.openFiles(folder?.uri);

		let system = buildAgentSystemPrompt({
			workspaceName: folder?.name ?? '(no folder open)',
			openFiles,
			activeFile: openFiles[0],
			projectRules: folder ? await this.readProjectRules(folder.uri) : undefined,
			// Asked every turn, not cached: an administrator who adds a rule
			// to stop something expects it on the next question.
			orgRules: await this.s.client.orgRules(),
			mode: this.readOnly ? 'ask' : 'agent',
			surface: 'chat',
		});

		// A custom mode — VS Code's Plan, or one the project defines in a
		// `.agent.md` — arrives as instructions of its own. They describe
		// this turn, so they go last.
		const mode = request.modeInstructions;
		if (mode?.content.trim()) {
			system += `\n\n## The mode the person chose: ${mode.name}\n\n${mode.content.trim()}`;
		}

		const messages: Message[] = [];
		for (const entry of history) {
			if (entry.request.message) {
				messages.push({ role: 'user', content: entry.request.message });
			}
			const answer = entry.response
				.map(part => (part.kind === 'markdownContent' ? part.content.value : ''))
				.join('')
				.trim();
			// The provider wants turns to alternate. A turn that ended with
			// no text — cancelled, or tools only — still gets a line.
			messages.push({ role: 'assistant', content: answer || '(no reply)' });
		}

		const attached = await attachmentsToBlocks(request.variables.variables as readonly ChatAttachment[], this.reader(folder?.uri));
		const question: ContentBlock[] = [...attached, { type: 'text', text: request.message || '(see the attachment)' }];
		messages.push({ role: 'user', content: question });

		const tools = this.tools(request);

		let stepLimit = false;
		await runAgentLoop({
			messages,
			tools: tools.schemas,
			toolHost: {
				run: (name, input, runToken, id) => this.invokeTool(request, tools.idByName.get(name), name, input, runToken, id),
			},
			model: this.model(request),
			system,
			send: body => this.s.client.anthropicMessages(body),
			token,
			maxSteps: MAX_STEPS,
			onEvent: event => {
				if (event.type === 'text' && !token.isCancellationRequested) {
					progress([{ kind: 'markdownContent', content: new MarkdownString(event.text) }]);
				} else if (event.type === 'done' && event.reason === 'stepLimit') {
					stepLimit = true;
				}
			},
		});

		if (stepLimit) {
			progress([{
				kind: 'warning',
				content: new MarkdownString(localize('cloudeide.chat.stepLimit', "Stopped at the step limit. Say \"continue\" to carry on, or ask for a smaller piece.")),
			}]);
		}
		return {};
	}

	/**
	 * The tools for this turn: what the tool service holds, less what is not
	 * meant for a model, less what the person switched off in the picker.
	 * Ask gets the read-only file tools and nothing else.
	 */
	private tools(request: IChatAgentRequest) {
		const all = [...this.s.toolsService.getTools(undefined)]
			.filter(t => isToolForTheModel(t))
			.filter(t => this.readOnly
				? READ_TOOL_NAMES.includes(t.id)
				: request.userSelectedTools?.[t.id] !== false);
		return toolSchemasFor(all.map(t => ({ id: t.id, modelDescription: t.modelDescription, inputSchema: t.inputSchema })));
	}

	private async invokeTool(
		request: IChatAgentRequest,
		toolId: string | undefined,
		name: string,
		input: Record<string, unknown>,
		token: CancellationToken,
		callId: string | undefined,
	): Promise<AgentToolResult> {
		if (!toolId) {
			return { content: `There is no tool called ${name}.`, isError: true };
		}
		try {
			const result = await this.s.toolsService.invokeTool({
				callId: callId ?? generateUuid(),
				toolId,
				parameters: input,
				context: { sessionResource: request.sessionResource },
				chatRequestId: request.requestId,
				modelId: request.userSelectedModelId,
				userSelectedTools: request.userSelectedTools,
			}, async text => Math.ceil(text.length / 4), token);
			const text = toolContentToA11yString(result.content)
				|| (typeof result.toolResultError === 'string' ? result.toolResultError : '')
				|| '(no output)';
			return { content: clipToolResult(text), isError: !!result.toolResultError };
		} catch (err) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			// Skipped by the person, refused by a hook, or failed. The model
			// can carry on if it is told which; the run cannot if this throws.
			const message = isCancellationError(err)
				? 'The person skipped this tool call.'
				: err instanceof Error ? err.message : String(err);
			return { content: message, isError: true };
		}
	}

	/**
	 * The picked model, if it is one of ours; otherwise the configured one.
	 * Ours are only ever the ones the provider listed, so the id is taken as
	 * it is — the server has the last word on which it accepts.
	 */
	private model(request: IChatAgentRequest): string {
		const picked = request.userSelectedModelId?.startsWith(`${VENDOR}/`)
			? request.userSelectedModelId.slice(VENDOR.length + 1)
			: undefined;
		if (picked) {
			return picked;
		}
		const configured = this.s.configurationService.getValue<string>(MODEL_SETTING);
		return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_MODEL;
	}

	private openFiles(root: URI | undefined): string[] {
		return this.s.editorService.editors
			.map(e => e.resource)
			.filter((uri): uri is URI => !!uri && (!root || uri.scheme === root.scheme))
			.map(uri => (root && relativePath(root, uri)) || basename(uri));
	}

	private reader(root: URI | undefined): AttachmentReader {
		return {
			readText: async uri => {
				const open = this.s.modelService.getModel(uri);
				if (open) {
					return open.getValue();
				}
				try {
					return (await this.s.fileService.readFile(uri)).value.toString();
				} catch {
					return undefined;
				}
			},
			listFolder: async uri => {
				try {
					const stat = await this.s.fileService.resolve(uri);
					return (stat.children ?? []).map(c => c.isDirectory ? `${c.name}/` : c.name);
				} catch {
					return undefined;
				}
			},
			label: uri => (root && relativePath(root, uri)) || uri.path,
		};
	}

	/**
	 * The project's own note about how work here should be done: `AGENTS.md`,
	 * or `.cloudeiderules`. Read each turn, so an edit to it applies to the
	 * next question rather than the next window.
	 */
	private async readProjectRules(root: URI): Promise<{ path: string; text: string } | undefined> {
		for (const name of ['AGENTS.md', '.cloudeiderules']) {
			try {
				const content = await this.s.fileService.readFile(URI.joinPath(root, name));
				const text = content.value.toString().slice(0, MAX_PROJECT_RULES_CHARS);
				if (text.trim()) {
					return { path: name, text };
				}
			} catch {
				// Most projects have neither file.
			}
		}
		return undefined;
	}

	/**
	 * `/pr`: this conversation's work, on GitHub.
	 *
	 * The title and body come from the agent's last answer, and the file list
	 * from what the conversation changed. What is sent is the whole folder,
	 * because a pull request is the state of a branch, not a patch.
	 */
	private async pullRequest(
		request: IChatAgentRequest,
		history: IChatAgentHistoryEntry[],
		say: (text: string, trusted?: string[]) => void,
	): Promise<IChatAgentResult> {
		const folder = this.s.contextService.getWorkspace().folders[0];
		const session = this.s.chatService.getSession(request.sessionResource)?.editingSession;
		const files = (session?.entries.get() ?? [])
			.map(e => (folder && relativePath(folder.uri, e.modifiedURI)) || basename(e.modifiedURI));
		if (!folder || files.length === 0) {
			say(localize('cloudeide.chat.pr.nothing', "Nothing to open a pull request for yet. Ask for a change first."));
			return {};
		}

		const prs = new CloudeidePullRequests(this.s.client, this.s.fileService, this.s.contextService);
		try {
			const connection = await prs.connected();
			if (!connection.ok) {
				say(connection.why ?? localize('cloudeide.chat.pr.noGithub', "GitHub is not connected."));
				return {};
			}
			const repos = await prs.repos();
			if (repos.length === 0) {
				say(localize('cloudeide.chat.pr.noRepos', "That GitHub account has no repositories this can push to."));
				return {};
			}
			const picked = await this.s.quickInputService.pick(
				repos.map(r => ({ label: r.label, description: r.base, base: r.base })),
				{ placeHolder: localize('cloudeide.chat.pr.pickRepo', "Which repository?") });
			if (!picked) {
				return {};
			}

			const lastReply = history.at(-1)?.response
				.map(part => (part.kind === 'markdownContent' ? part.content.value : ''))
				.join('') ?? '';
			const described = describeChange(lastReply, files);
			const { confirmed } = await this.s.dialogService.confirm({
				message: localize('cloudeide.chat.pr.confirm', "Open a pull request on {0}?", picked.label),
				detail: `${described.title}\n\n${localize('cloudeide.chat.pr.where', "A new branch into {0}. Unsaved files are saved first.", picked.base)}\n\n${files.join('\n')}`,
				primaryButton: localize('cloudeide.chat.pr.open', "Open PR"),
			});
			if (!confirmed) {
				return {};
			}

			await this.s.editorService.saveAll();
			const collected = await prs.collect(folder.uri, CancellationToken.None);
			const opened = await prs.open({ repo: picked.label, base: picked.base, title: described.title, message: described.message, files: collected });
			say(localize('cloudeide.chat.pr.opened', "Opened [{0}#{1}]({2}).", picked.label, opened.number, opened.url));
			return {};
		} finally {
			prs.dispose();
		}
	}
}

export class CloudeideChatAgentContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideChatAgent';

	constructor(
		@IChatAgentService agentService: IChatAgentService,
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditorService editorService: IEditorService,
		@IModelService modelService: IModelService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IChatService chatService: IChatService,
		@IQuickInputService quickInputService: IQuickInputService,
		@IDialogService dialogService: IDialogService,
		@ICommandService commandService: ICommandService,
	) {
		super();

		const services: ChatAgentServices = {
			client: new CloudeideClient(secretStorageService, configurationService),
			toolsService, configurationService, editorService, modelService, fileService,
			contextService, chatService, quickInputService, dialogService, commandService,
		};

		const base = {
			// Registered from the workbench rather than contributed by an
			// extension, which is what `isCore` says and why the identifier
			// is not an extension that exists.
			extensionId: new ExtensionIdentifier('cloudeide'),
			extensionVersion: undefined,
			extensionPublisherId: 'cloudeide',
			publisherDisplayName: 'CloudeIDE',
			extensionDisplayName: 'CloudeIDE',
			isDefault: true,
			isCore: true,
			metadata: {},
			locations: [ChatAgentLocation.Chat],
			disambiguation: [],
		};

		const agent: IChatAgentData = {
			...base,
			id: AGENT_ID,
			name: 'agent',
			fullName: localize('cloudeide.chat.agentName', "Agent"),
			description: localize('cloudeide.chat.agentDescription', "Reads, changes files and runs commands."),
			modes: [ChatModeKind.Agent, ChatModeKind.Edit],
			slashCommands: [
				{ name: 'pr', description: localize('cloudeide.chat.prCommand', "Open a pull request for this conversation's changes") },
				{ name: 'deploy', description: localize('cloudeide.chat.deployCommand', "Open Cloud to deploy") },
			],
		};
		const ask: IChatAgentData = {
			...base,
			id: ASK_ID,
			name: 'ask',
			fullName: localize('cloudeide.chat.askName', "Ask"),
			description: localize('cloudeide.chat.askDescription', "Answers questions about the project. Reads only."),
			modes: [ChatModeKind.Ask],
			slashCommands: [],
		};

		this._register(agentService.registerAgent(AGENT_ID, agent));
		this._register(agentService.registerAgentImplementation(AGENT_ID, new CloudeideChatAgent(false, services)));
		this._register(agentService.registerAgent(ASK_ID, ask));
		this._register(agentService.registerAgentImplementation(ASK_ID, new CloudeideChatAgent(true, services)));
	}
}
