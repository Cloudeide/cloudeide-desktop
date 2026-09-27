/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	actionFor, agentDeploysInLastHour, CloudActivity, decide, describeForModel, formatActivity, presetOf,
} from '../../browser/cloudeideCloudPermissions.js';

/**
 * The table that decides what the agent may do in Cloud on its own.
 *
 * Worth holding down row by row: a preset that quietly let production
 * through, or a "never" an override could lift from a fixed row, is the
 * kind of change nobody notices until it has shipped something.
 */
suite('CloudeIDE Cloud permissions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Balanced: previews on its own, production and rollback ask', () => {
		assert.strictEqual(decide('deploy.preview', 'balanced'), 'allow');
		assert.strictEqual(decide('deploy.development', 'balanced'), 'allow');
		assert.strictEqual(decide('deploy.production', 'balanced'), 'ask');
		assert.strictEqual(decide('rollback', 'balanced'), 'ask');
		assert.strictEqual(decide('domain.add', 'balanced'), 'ask');
	});

	test('Careful asks before any deploy and never removes a domain', () => {
		for (const env of ['deploy.development', 'deploy.preview', 'deploy.production'] as const) {
			assert.strictEqual(decide(env, 'careful'), 'ask', env);
		}
		assert.strictEqual(decide('domain.remove', 'careful'), 'never');
	});

	test('Autopilot ships production, but removing a domain still asks', () => {
		assert.strictEqual(decide('deploy.production', 'autopilot'), 'allow');
		assert.strictEqual(decide('rollback', 'autopilot'), 'allow');
		assert.strictEqual(decide('domain.remove', 'autopilot'), 'ask');
	});

	test('a variable is always typed by a person, whatever the preset or override', () => {
		for (const preset of ['careful', 'balanced', 'autopilot'] as const) {
			assert.strictEqual(decide('env.set', preset), 'ask');
		}
		assert.strictEqual(decide('env.set', 'autopilot', { 'env.set': 'allow' }), 'ask');
	});

	test('an override sets one action apart; nonsense in it is ignored', () => {
		assert.strictEqual(decide('deploy.production', 'autopilot', { 'deploy.production': 'ask' }), 'ask');
		assert.strictEqual(decide('deploy.preview', 'balanced', { 'deploy.preview': 'never' }), 'never');
		assert.strictEqual(decide('deploy.preview', 'balanced', { 'deploy.preview': 'sometimes' }), 'allow');
	});

	test('an unknown preset falls back to Balanced', () => {
		assert.strictEqual(presetOf('yolo'), 'balanced');
		assert.strictEqual(presetOf(undefined), 'balanced');
		assert.strictEqual(presetOf('careful'), 'careful');
	});

	test('tool calls map to actions; reading maps to none', () => {
		assert.strictEqual(actionFor('cloud_deploy', { environment: 'production' }), 'deploy.production');
		assert.strictEqual(actionFor('cloud_deploy', { environment: 'preview' }), 'deploy.preview');
		assert.strictEqual(actionFor('cloud_deploy', {}), 'deploy.development');
		assert.strictEqual(actionFor('cloud_domain_remove', {}), 'domain.remove');
		assert.strictEqual(actionFor('cloud_logs', {}), undefined);
		assert.strictEqual(actionFor('cloud_status', {}), undefined);
	});

	test('the model is told every rule, in three groups', () => {
		const text = describeForModel('balanced', undefined, 10);
		assert.ok(text.startsWith('The person\'s Cloud permissions are "balanced".'));
		assert.ok(text.includes('You may, without asking: deploy to development, deploy to preview, cancel a deployment.'), text);
		assert.ok(text.includes('asked first before you: deploy to production'), text);
		assert.ok(text.includes('At most 10 deploys an hour.'));
		assert.ok(describeForModel('careful').includes('You may not: remove a domain.'));
	});

	test('recent activity reads as who did what, and when', () => {
		const now = 10 * 3600_000;
		const items: CloudActivity[] = [
			{ at: now - 30 * 60_000, by: 'you', kind: 'deploy', summary: 'started deployment dpl_1 to production' },
			{ at: now - 20_000, by: 'agent', kind: 'domain', summary: 'added domain shop.acme.com to production' },
		];
		assert.strictEqual(formatActivity(items, now),
			'- 30 min ago, the person: started deployment dpl_1 to production\n- just now, you (the agent): added domain shop.acme.com to production');
		assert.strictEqual(formatActivity([], now), '');
	});

	test('only the agent\'s own deploys in the last hour count against its limit', () => {
		const now = 10 * 3600_000;
		const items: CloudActivity[] = [
			{ at: now - 10 * 60_000, by: 'agent', kind: 'deploy', summary: 'started' },
			{ at: now - 70 * 60_000, by: 'agent', kind: 'deploy', summary: 'started' },
			{ at: now - 5 * 60_000, by: 'you', kind: 'deploy', summary: 'started' },
		];
		assert.strictEqual(agentDeploysInLastHour(items, now), 1);
	});
});
