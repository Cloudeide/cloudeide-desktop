/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where a person chooses what the agent may do in Cloud: the settings, and a
 * picker reached from the Cloud tab's "Agent: …" button and the palette.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { CLOUD_ACTIONS, CLOUD_PRESETS, CloudPreset, DEFAULT_PRESET } from './cloudeideCloudPermissions.js';
import { DEFAULT_MAX_DEPLOYS_PER_HOUR, ICloudeideCloudService, MAX_DEPLOYS_SETTING, OVERRIDES_SETTING, PERMISSIONS_SETTING } from './cloudeideCloudService.js';

export const CLOUDEIDE_CLOUD_PERMISSIONS_COMMAND = 'cloudeide.cloudPermissions';

export function presetLabel(preset: CloudPreset): string {
	switch (preset) {
		case 'careful': return localize('cloudeide.preset.careful', "Careful");
		case 'autopilot': return localize('cloudeide.preset.autopilot', "Autopilot");
		default: return localize('cloudeide.preset.balanced', "Balanced");
	}
}

function presetDetail(preset: CloudPreset): string {
	switch (preset) {
		case 'careful': return localize('cloudeide.preset.carefulDetail', "Asks before anything that deploys. Never removes a domain.");
		case 'autopilot': return localize('cloudeide.preset.autopilotDetail', "Ships on its own, production included, within the hourly limit. Still asks before removing a domain.");
		default: return localize('cloudeide.preset.balancedDetail', "Deploys previews on its own. Asks before production, rollbacks and domain changes.");
	}
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'cloudeide',
	properties: {
		[PERMISSIONS_SETTING]: {
			type: 'string',
			enum: [...CLOUD_PRESETS],
			enumDescriptions: CLOUD_PRESETS.map(presetDetail),
			default: DEFAULT_PRESET,
			description: localize('cloudeide.cloudPermissions', "What the agent may do in Cloud without asking. A variable's value is always typed by you, whatever this is set to."),
		},
		[OVERRIDES_SETTING]: {
			type: 'object',
			default: {},
			properties: Object.fromEntries(CLOUD_ACTIONS.map(action => [action, { type: 'string', enum: ['allow', 'ask', 'never'] }])),
			additionalProperties: false,
			description: localize('cloudeide.cloudOverrides', "Set single actions apart from the preset, for example {\"deploy.production\": \"ask\"}."),
		},
		[MAX_DEPLOYS_SETTING]: {
			type: 'number',
			default: DEFAULT_MAX_DEPLOYS_PER_HOUR,
			minimum: 1,
			description: localize('cloudeide.maxDeploysPerHour', "The most deploys the agent may start in an hour. Stops a fix-and-retry loop from running away."),
		},
	},
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLOUDEIDE_CLOUD_PERMISSIONS_COMMAND,
			title: localize2('cloudeide.cloudPermissionsCommand', "CloudeIDE: What the Agent May Do in Cloud"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const cloud = accessor.get(ICloudeideCloudService);
		const quickInput = accessor.get(IQuickInputService);
		const current = cloud.preset();
		const items: (IQuickPickItem & { preset: CloudPreset })[] = CLOUD_PRESETS.map(preset => ({
			preset,
			label: presetLabel(preset),
			description: preset === current ? localize('cloudeide.preset.current', "current") : undefined,
			detail: presetDetail(preset),
		}));
		const picked = await quickInput.pick(items, {
			placeHolder: localize('cloudeide.preset.placeholder', "What may the agent do in Cloud without asking?"),
			activeItem: items.find(i => i.preset === current),
		});
		if (picked && picked.preset !== current) {
			await cloud.setPreset(picked.preset);
		}
	}
});
