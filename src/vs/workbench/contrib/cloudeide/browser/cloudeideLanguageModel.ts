/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import {
	ChatMessageRole,
	IChatMessage,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatResponse,
	ILanguageModelsService,
	IChatResponsePart,
} from '../../chat/common/languageModels.js';
import { ChatMessage, CloudeideClient } from './cloudeideClient.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

export const VENDOR = 'cloudeide';

/** The setting that names the models this product offers, and the default one. */
export const MODEL_SETTING = 'cloudeide.model';
export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * The models, from the setting that declares them.
 *
 * Not a second list. The setting's `enum` is already the answer to "which
 * models", and a copy here would drift until the picker offered a model the
 * server had stopped accepting.
 */
export function offeredModels(): { id: string; detail?: string }[] {
	const schema = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
		.getConfigurationProperties()[MODEL_SETTING];
	const ids = Array.isArray(schema?.enum) ? schema.enum.filter((v): v is string => typeof v === 'string') : [];
	const details = Array.isArray(schema?.enumDescriptions) ? schema.enumDescriptions : [];
	const list = ids.map((id, i) => ({ id, detail: typeof details[i] === 'string' ? details[i] : undefined }));
	return list.length ? list : [{ id: DEFAULT_MODEL }];
}

/** "claude-haiku-4-5" → "Haiku 4.5", "gpt-5.6-sol" → "GPT-5.6 Sol". */
export function modelDisplayName(id: string): string {
	const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(id);
	if (gpt) {
		return `GPT-${gpt[1]}${gpt[2] ? ` ${capitalise(gpt[2])}` : ''}`;
	}
	const parts = id.replace(/^claude-/, '').split('-');
	const words = parts.filter(p => !/^\d+$/.test(p)).map(capitalise);
	const version = parts.filter(p => /^\d+$/.test(p)).join('.');
	return [...words, version].filter(Boolean).join(' ') || id;
}

function capitalise(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Presents the CloudeIDE server as a language model to the rest of the
 * workbench.
 *
 * The panel already talks to `/ai/chat` directly, and for answering a question
 * that is enough. It is not enough for anything that has to *act*: the agent
 * host, the chat view and every tool-using surface in this fork take their
 * model from `ILanguageModelsService` and will not look anywhere else. Putting
 * the server behind that interface is what lets those surfaces run on this
 * account instead of on a key the person has to supply themselves.
 *
 * Each model the product offers is listed, so the chat panel's own model
 * picker is the one a person uses. What is sent through this provider is
 * text only — titles, summaries, anything else in the workbench that wants a
 * quick answer. The agent in the chat panel does not come through here: it
 * calls the server's messages endpoint itself, with tools and pictures, on
 * whichever of these models was picked.
 */
export class CloudeideLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		private readonly client: CloudeideClient,
		private readonly configurationService?: IConfigurationService,
	) {
		super();
		if (configurationService) {
			this._register(configurationService.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(MODEL_SETTING)) {
					this._onDidChange.fire();
				}
			}));
		}
	}

	/**
	 * Ask the workbench to read the list again. Registering a provider does
	 * not make it read the list — only a change does — so without this the
	 * model picker stayed empty and offered nothing but "Auto".
	 */
	refresh(): void {
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInfo(): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		// Advertised whether or not a token is stored. Selection happens long
		// before a request does, and a model that vanishes when the token is
		// missing would take the entry out of the picker rather than explain
		// itself — the request is where "not connected" belongs.
		const configured = this.configurationService?.getValue<string>(MODEL_SETTING) || DEFAULT_MODEL;
		const models = offeredModels();
		const fallback = models.some(m => m.id === configured) ? configured : models[0].id;
		return models.map(m => ({
			identifier: `${VENDOR}/${m.id}`,
			metadata: {
				extension: new ExtensionIdentifier('cloudeide'),
				id: m.id,
				vendor: VENDOR,
				name: modelDisplayName(m.id),
				family: m.id,
				version: '1',
				detail: m.detail,
				// The server decides each model's limits; these are the
				// figures the workbench needs for trimming, not a promise.
				maxInputTokens: 180_000,
				maxOutputTokens: 16_000,
				isDefaultForLocation: { [ChatAgentLocation.Chat]: m.id === fallback },
				isUserSelectable: true,
				// What the chat panel checks before it offers Agent mode and
				// the picture button. The agent behind the panel calls tools
				// and sends pictures itself, through the server's messages
				// endpoint, so these are true of the agent the person talks to.
				capabilities: { vision: true, toolCalling: true, agentMode: true },
			},
		}));
	}

	async sendChatRequest(
		_modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		_options: unknown,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		// The workbench's message shape is richer than the server's: parts can
		// be images, tool calls or thinking. Only text survives the trip, and
		// system messages are hoisted out because `/ai/chat` takes them in a
		// field of their own rather than in the list.
		const system: string[] = [];
		const history: ChatMessage[] = [];
		for (const message of messages) {
			const text = message.content
				.filter(part => part.type === 'text')
				.map(part => (part as { value: string }).value)
				.join('');
			if (!text) {
				continue;
			}
			if (message.role === ChatMessageRole.System) {
				system.push(text);
			} else {
				history.push({
					role: message.role === ChatMessageRole.Assistant ? 'assistant' : 'user',
					content: text,
				});
			}
		}

		// A queue rather than a callback chain: `chat` hands text to a callback
		// as it arrives, and the caller wants an async iterable. This bridges
		// the two without buffering the whole answer first, so the stream stays
		// a stream.
		const chunks: string[] = [];
		let notify: (() => void) | undefined;
		let finished = false;
		let failure: unknown;

		const wake = () => {
			notify?.();
			notify = undefined;
		};

		const result = this.client
			.chat(history, chunk => { chunks.push(chunk); wake(); }, system.join('\n\n') || undefined)
			.then(() => { finished = true; wake(); })
			.catch(err => { failure = err; finished = true; wake(); });

		const stream = (async function* (): AsyncIterable<IChatResponsePart> {
			while (true) {
				while (chunks.length > 0) {
					if (token.isCancellationRequested) {
						return;
					}
					yield { type: 'text', value: chunks.shift()! } satisfies IChatResponsePart;
				}
				if (finished) {
					if (failure) {
						throw failure;
					}
					return;
				}
				await new Promise<void>(resolve => { notify = resolve; });
			}
		})();

		return { stream, result };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage): Promise<number> {
		// An estimate, and named as one. The server does not expose a tokenizer
		// and the workbench only uses this to decide what to trim, so four
		// characters to a token — the usual rough figure — is closer than
		// refusing to answer.
		const text = typeof message === 'string'
			? message
			: message.content.filter(p => p.type === 'text').map(p => (p as { value: string }).value).join('');
		return Math.ceil(text.length / 4);
	}
}

/**
 * Registers the provider once the workbench is up.
 */
export class CloudeideLanguageModelContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideLanguageModel';

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super();

		// The vendor has to exist before a provider can claim it; registering a
		// provider for an unknown vendor throws.
		languageModelsService.deltaLanguageModelChatProviderDescriptors(
			// The schema derives its type from a JSON schema where every
			// optional field is still present, so they are named rather than
			// omitted.
			[{ vendor: VENDOR, displayName: 'CloudeIDE', configuration: undefined, managementCommand: undefined, when: undefined }],
			[],
		);

		const client = new CloudeideClient(secretStorageService, configurationService);
		const provider = this._register(new CloudeideLanguageModelProvider(client, configurationService));

		try {
			this._register(languageModelsService.registerLanguageModelProvider(VENDOR, provider));
			provider.refresh();
		} catch (error) {
			logService.error('[CloudeIDE] could not register the language model provider', error);
		}
	}
}
