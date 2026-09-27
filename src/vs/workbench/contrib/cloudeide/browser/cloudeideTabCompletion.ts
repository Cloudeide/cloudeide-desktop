/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CloudeIDE Tab, in the editor.
 *
 * An inline completions provider, which is the editor's own machinery for
 * grey text: it decides when to ask, draws the suggestion, and handles Tab,
 * Esc and Ctrl+→. This file only answers "what comes next here", and keeps
 * the status bar entry that says whether Tab is on.
 *
 * Two things are ours rather than the editor's. The status bar says when a
 * showing suggestion followed one of the organisation's rules — there, not
 * as a label on the grey text, because the editor's per-suggestion label is
 * drawn as a warning and a rule being followed is not one. And keeping a
 * whole function with Tab offers to have the agent write its test.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { InlineCompletion, InlineCompletionContext, InlineCompletions, InlineCompletionsProvider } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { CloudeideClient } from './cloudeideClient.js';
import {
	addUsage, ASK_AGENT_COMMAND, buildTabRequest, dayKey, describeUsage, parseTabReply, readUsage,
	TAB_PREFIX_CHARS, TAB_SUFFIX_CHARS, TabRule, TabUsage, testOfferFor, testRequestFor,
} from './cloudeideTab.js';

export const TAB_ENABLED_SETTING = 'cloudeide.tab.enabled';
export const TAB_DISABLED_LANGUAGES_SETTING = 'cloudeide.tab.disabledLanguages';

const TAB_MENU_COMMAND = 'cloudeide.tab.menu';
const TAB_OFFER_TEST_COMMAND = 'cloudeide.tab.offerTest';
const USAGE_STORAGE_KEY = 'cloudeide.tab.usage';

/** How long typing has to pause before a suggestion is asked for. */
const PAUSE_MS = 300;

/** A suggestion that has not arrived by now would arrive after the next keystroke anyway. */
const REQUEST_TIMEOUT_MS = 8000;

/** Team rules change when an admin edits them, not per keystroke. */
const TEAM_RULES_TTL_MS = 5 * 60_000;

/** AGENTS.md is edited by people; re-read it often, but not on every pause. */
const PROJECT_RULES_TTL_MS = 30_000;
const MAX_PROJECT_RULES_CHARS = 2000;

/** Only documents a person is writing: not output, search results or diff views. */
const SCHEMES = new Set(['file', 'untitled', 'vscode-remote']);

interface TabItem extends InlineCompletion {
	readonly rule?: string;
}

interface TabCompletions extends InlineCompletions<TabItem> {
	readonly items: readonly TabItem[];
}

export class CloudeideTabContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideTab';

	private readonly client: CloudeideClient;
	private readonly status: IStatusbarEntryAccessor;
	private teamRules: { at: number; value: readonly TabRule[] } | undefined;
	private readonly projectRules = new Map<string, { at: number; value: string | undefined }>();
	private showingRule: string | undefined;

	constructor(
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IStatusbarService statusbarService: IStatusbarService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.client = new CloudeideClient(secretStorageService, configurationService);
		this.status = this._register(statusbarService.addEntry(this.statusEntry(), 'status.cloudeide.tab', StatusbarAlignment.RIGHT, 100));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('cloudeide.tab')) {
				this.status.update(this.statusEntry());
			}
		}));
		this._register(languageFeatures.inlineCompletionsProvider.register({ pattern: '**' }, this.provider()));
	}

	// ---- the provider ------------------------------------------------------

	private provider(): InlineCompletionsProvider<TabCompletions> {
		return {
			provideInlineCompletions: (model, position, context, token) => this.suggest(model, position, context, token),
			handleItemDidShow: (_completions, item) => this.setShowingRule(item.rule),
			handleEndOfLifetime: () => this.setShowingRule(undefined),
			disposeInlineCompletions: () => this.setShowingRule(undefined),
		};
	}

	private async suggest(model: ITextModel, position: Position, _context: InlineCompletionContext, token: CancellationToken): Promise<TabCompletions | undefined> {
		const languageId = model.getLanguageId();
		if (!this.enabledFor(languageId) || !SCHEMES.has(model.uri.scheme)) {
			return undefined;
		}

		// Inside a word is the language's own completion list's job, and a
		// guess from the middle of an identifier is rarely the right one.
		const line = model.getLineContent(position.lineNumber);
		const lineBefore = line.slice(0, position.column - 1);
		if (/\w/.test(line.charAt(position.column - 1))) {
			return undefined;
		}

		if (!await pause(PAUSE_MS, token)) {
			return undefined;
		}
		if (!await this.client.getToken()) {
			return undefined; // not signed in: nothing to bill, so nothing to ask
		}

		const firstLine = Math.max(1, position.lineNumber - 80);
		const lastLine = Math.min(model.getLineCount(), position.lineNumber + 30);
		const prefix = model.getValueInRange(new Range(firstLine, 1, position.lineNumber, position.column)).slice(-TAB_PREFIX_CHARS);
		const suffix = model.getValueInRange(new Range(position.lineNumber, position.column, lastLine, model.getLineMaxColumn(lastLine))).slice(0, TAB_SUFFIX_CHARS);

		const ctx = {
			path: this.displayPath(model),
			languageId,
			prefix,
			suffix,
			rules: await this.readTeamRules(),
			projectRules: await this.readProjectRules(model),
		};
		if (token.isCancellationRequested) {
			return undefined;
		}

		let reply: string;
		try {
			const response = await this.client.anthropicMessages(buildTabRequest(ctx), REQUEST_TIMEOUT_MS);
			const body = await response.json() as {
				content?: { type: string; text?: string }[];
				usage?: { input_tokens?: number; output_tokens?: number };
			};
			this.recordUsage((body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0));
			reply = (body.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('');
		} catch (err) {
			// Quietly. A failed suggestion is a suggestion that did not appear;
			// a notification per pause would make the editor unusable offline.
			this.logService.debug('[CloudeIDE Tab]', err instanceof Error ? err.message : String(err));
			return undefined;
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		const suggestion = parseTabReply(reply, ctx);
		if (!suggestion) {
			return undefined;
		}
		const testFor = testOfferFor(lineBefore, suggestion.text, languageId, suffix);
		return {
			items: [{
				insertText: suggestion.text,
				range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
				rule: suggestion.rule,
				command: testFor ? { id: TAB_OFFER_TEST_COMMAND, title: '', arguments: [testFor, ctx.path] } : undefined,
			}],
		};
	}

	// ---- what the request carries -----------------------------------------------

	private displayPath(model: ITextModel): string {
		const folder = this.contextService.getWorkspaceFolder(model.uri);
		if (folder && model.uri.path.startsWith(folder.uri.path)) {
			return model.uri.path.slice(folder.uri.path.length).replace(/^\/+/, '') || model.uri.path;
		}
		return model.uri.path.split('/').pop() || 'untitled';
	}

	private async readTeamRules(): Promise<readonly TabRule[]> {
		if (this.teamRules && Date.now() - this.teamRules.at < TEAM_RULES_TTL_MS) {
			return this.teamRules.value;
		}
		// orgRules() answers [] rather than throwing — no organisation, not
		// signed in and a server that is down all mean the same thing here.
		const value = await this.client.orgRules();
		this.teamRules = { at: Date.now(), value };
		return value;
	}

	private async readProjectRules(model: ITextModel): Promise<string | undefined> {
		const folder = this.contextService.getWorkspaceFolder(model.uri);
		if (!folder) {
			return undefined;
		}
		const key = folder.uri.toString();
		const cached = this.projectRules.get(key);
		if (cached && Date.now() - cached.at < PROJECT_RULES_TTL_MS) {
			return cached.value;
		}
		let value: string | undefined;
		const base = folder.uri.path.replace(/\/+$/, '');
		for (const name of ['AGENTS.md', '.cloudeiderules']) {
			try {
				const content = await this.fileService.readFile(folder.uri.with({ path: `${base}/${name}` }));
				const text = content.value.toString().slice(0, MAX_PROJECT_RULES_CHARS);
				if (text.trim()) {
					value = text;
					break;
				}
			} catch {
				// Most projects have neither file.
			}
		}
		this.projectRules.set(key, { at: Date.now(), value });
		return value;
	}

	// ---- on or off, and what it used ---------------------------------------------

	private enabledFor(languageId: string): boolean {
		if (this.configurationService.getValue<boolean>(TAB_ENABLED_SETTING) === false) {
			return false;
		}
		const off = this.configurationService.getValue<string[]>(TAB_DISABLED_LANGUAGES_SETTING);
		return !(Array.isArray(off) && off.includes(languageId));
	}

	private recordUsage(tokens: number): void {
		const today = dayKey(new Date());
		const next = addUsage(readUsage(this.storageService.get(USAGE_STORAGE_KEY, StorageScope.APPLICATION)), today, tokens);
		this.storageService.store(USAGE_STORAGE_KEY, JSON.stringify(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private setShowingRule(rule: string | undefined): void {
		if (rule === this.showingRule) {
			return;
		}
		this.showingRule = rule;
		this.status.update(this.statusEntry());
	}

	private statusEntry(): IStatusbarEntry {
		const on = this.configurationService.getValue<boolean>(TAB_ENABLED_SETTING) !== false;
		const rule = on ? this.showingRule : undefined;
		return {
			name: localize('cloudeide.tab.statusName', "CloudeIDE Tab"),
			text: !on
				? localize('cloudeide.tab.statusOff', "Tab off")
				: rule
					? `$(check) ${localize('cloudeide.tab.statusRule', "Tab · follows team rule")}`
					: `$(check) ${localize('cloudeide.tab.statusOn', "Tab")}`,
			ariaLabel: rule
				? localize('cloudeide.tab.ariaRule', "CloudeIDE Tab is on. The suggestion follows the team rule: {0}", rule)
				: on ? localize('cloudeide.tab.ariaOn', "CloudeIDE Tab is on") : localize('cloudeide.tab.ariaOff', "CloudeIDE Tab is off"),
			tooltip: rule
				? localize('cloudeide.tab.tooltipRule', "This suggestion follows the team rule \"{0}\".", rule)
				: localize('cloudeide.tab.tooltip', "CloudeIDE Tab: suggestions as you type. Click to turn it off or see today's use."),
			command: TAB_MENU_COMMAND,
		};
	}
}

function pause(ms: number, token: CancellationToken): Promise<boolean> {
	return new Promise(resolve => {
		if (token.isCancellationRequested) {
			resolve(false);
			return;
		}
		const listener = token.onCancellationRequested(() => {
			clearTimeout(timer);
			listener.dispose();
			resolve(false);
		});
		const timer = setTimeout(() => {
			listener.dispose();
			resolve(true);
		}, ms);
	});
}

// ---- commands -------------------------------------------------------------------

interface MenuItem extends IQuickPickItem {
	readonly run?: () => Promise<void>;
}

/** The status bar entry's menu: on, off, off for this language, and today's use. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TAB_MENU_COMMAND,
			title: localize2('cloudeide.tab.menu', "CloudeIDE: Tab Settings"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		const quickInput = accessor.get(IQuickInputService);
		const storage = accessor.get(IStorageService);
		const language = accessor.get(IEditorService).activeTextEditorLanguageId;

		const on = configuration.getValue<boolean>(TAB_ENABLED_SETTING) !== false;
		const offLanguages = configuration.getValue<string[]>(TAB_DISABLED_LANGUAGES_SETTING) ?? [];
		const languageOff = !!language && offLanguages.includes(language);
		const usage: TabUsage | undefined = readUsage(storage.get(USAGE_STORAGE_KEY, StorageScope.APPLICATION));

		const setOn = (value: boolean) => configuration.updateValue(TAB_ENABLED_SETTING, value, ConfigurationTarget.USER);
		const setLanguage = (off: boolean) => configuration.updateValue(
			TAB_DISABLED_LANGUAGES_SETTING,
			off ? [...new Set([...offLanguages, language!])] : offLanguages.filter(l => l !== language),
			ConfigurationTarget.USER);

		const items: (MenuItem | IQuickPickSeparator)[] = [
			{ label: localize('cloudeide.tab.on', "On"), description: on ? '✓' : undefined, run: () => setOn(true) },
			{ label: localize('cloudeide.tab.off', "Off"), description: on ? undefined : '✓', run: () => setOn(false) },
		];
		if (language) {
			items.push(languageOff
				? { label: localize('cloudeide.tab.onFor', "Turn back on for {0}", language), run: () => setLanguage(false) }
				: { label: localize('cloudeide.tab.offFor', "Off for {0}", language), run: () => setLanguage(true) });
		}
		items.push(
			{ type: 'separator', label: localize('cloudeide.tab.today', "Today") },
			{ label: describeUsage(usage, dayKey(new Date())), description: localize('cloudeide.tab.billed', "billed as credits, at the Claude Haiku 4.5 rate") },
		);

		const picked = await quickInput.pick(items, { placeHolder: localize('cloudeide.tab.placeholder', "CloudeIDE Tab") }) as MenuItem | undefined;
		await picked?.run?.();
	}
});

/**
 * After Tab kept a whole function: offer the agent a test for it.
 *
 * A notification rather than something drawn into the file. It can be
 * ignored without a keystroke, and it goes away on its own — an offer made
 * after nearly every function has to cost nothing to turn down.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({ id: TAB_OFFER_TEST_COMMAND, title: localize2('cloudeide.tab.offerTest', "CloudeIDE: Offer a Test for the Function Tab Wrote"), f1: false });
	}

	async run(accessor: ServicesAccessor, name?: unknown, path?: unknown): Promise<void> {
		if (typeof name !== 'string' || typeof path !== 'string') {
			return;
		}
		const commands = accessor.get(ICommandService);
		accessor.get(INotificationService).prompt(
			Severity.Info,
			localize('cloudeide.tab.testOffer', "Write a test for {0}()?", name),
			[{
				label: localize('cloudeide.tab.writeTest', "Write the test"),
				run: () => commands.executeCommand(ASK_AGENT_COMMAND, testRequestFor(name, path)),
			}],
		);
	}
});
