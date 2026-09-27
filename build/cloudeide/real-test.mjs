// A person's first half hour with CloudeIDE, run by a machine.
//
// Nobody on the team has a laptop to try a release on, so this is the one
// place the downloaded application meets the real server end to end: it
// starts the release, opens a folder, signs in with a real token, asks the
// agent for a real change with the real model, keeps it, deploys a preview on
// the real Cloud and fetches the address it was given. Every step is written
// down as PASS or FAIL with a picture, and the run carries on past a failure
// where it can, so one broken step does not hide the state of the others.
//
// It spends a few credits and one preview deployment per run. It never prints
// the token.

import { _electron as electron } from 'playwright-core';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const APP = process.env.CLOUDEIDE_BIN;
const WORKSPACE = process.env.WORKSPACE_DIR ?? '/tmp/ws';
const TOKEN = process.env.CLOUDEIDE_API_TOKEN;
const OUT = process.env.OUT_DIR ?? 'real-test';

if (!APP || !TOKEN) {
	console.error(!APP ? 'CLOUDEIDE_BIN is not set' : 'CLOUDEIDE_API_TOKEN is not set');
	process.exit(1);
}
await mkdir(OUT, { recursive: true });

const results = [];
let shotNo = 0;
const started = Date.now();
const secs = () => ((Date.now() - started) / 1000).toFixed(0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s).split(TOKEN).join('[token]').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\s+/g, ' ').slice(0, 400);

async function shot(page, name) {
	const file = `${String(++shotNo).padStart(2, '0')}-${name}.png`;
	await page.screenshot({ path: path.join(OUT, file) }).catch(() => { });
	return file;
}

async function step(page, name, fn) {
	const t0 = Date.now();
	try {
		const detail = await fn();
		const picture = await shot(page, name);
		results.push({ step: name, ok: true, detail: clean(detail ?? ''), picture, seconds: (Date.now() - t0) / 1000 });
		console.log(`PASS ${name} (${secs()}s) ${clean(detail ?? '')}`);
		return true;
	} catch (err) {
		const picture = await shot(page, `${name}-FAILED`);
		results.push({ step: name, ok: false, detail: clean(err?.message ?? err), picture, seconds: (Date.now() - t0) / 1000 });
		console.log(`FAIL ${name} (${secs()}s) ${clean(err?.message ?? err)}`);
		return false;
	}
}

const app = await electron.launch({
	executablePath: APP,
	args: [
		WORKSPACE,
		'--no-sandbox',
		'--disable-gpu',
		'--disable-dev-shm-usage',
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		'--disable-telemetry',
		'--disable-updates',
		'--user-data-dir', '/tmp/cloudeide-test-data',
		'--extensions-dir', '/tmp/cloudeide-test-ext',
	],
	timeout: 180_000,
});

const page = await app.firstWindow({ timeout: 180_000 });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(clean(e)));
await app.evaluate(({ BrowserWindow }) => {
	const win = BrowserWindow.getAllWindows()[0];
	win?.setMenuBarVisibility(false);
	win?.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
}).catch(() => { });

async function command(text) {
	await page.keyboard.press('Control+Shift+KeyP');
	await page.waitForSelector('.quick-input-widget input', { timeout: 30_000 });
	await page.keyboard.type(text, { delay: 10 });
	await sleep(800);
	await page.keyboard.press('Enter');
	await sleep(1200);
}

const chatInput = () => page.locator('.interactive-input-part .monaco-editor').first();

/**
 * Asks the agent something and waits for the turn to end. While a turn runs
 * the input has a stop button; the turn is over once it has been gone for a
 * few seconds in a row. Anything that asks to be allowed on the way (a
 * terminal command, a deploy) is allowed and written down.
 */
async function ask(text, limitMs) {
	await chatInput().click({ force: true });
	await page.keyboard.type(text, { delay: 8 });
	await page.keyboard.press('Enter');
	const allowed = [];
	const deadline = Date.now() + limitMs;
	let sawRunning = false;
	let quiet = 0;
	while (Date.now() < deadline) {
		await sleep(2000);
		const allow = page.locator('.interactive-session .monaco-button:visible', { hasText: /^(Allow|Allow Once|Continue|Run)$/ }).first();
		if (await allow.count()) {
			const label = await allow.innerText().catch(() => '?');
			const context = await page.locator('.interactive-session').last().innerText().catch(() => '');
			allowed.push(`${label}: ${clean(context.split('\n').slice(-6).join(' | '))}`);
			await allow.click().catch(() => { });
			continue;
		}
		const running = await page.locator('.interactive-input-part .codicon-stop-circle, .interactive-input-part .codicon-debug-stop').count();
		if (running) { sawRunning = true; quiet = 0; continue; }
		if (sawRunning || Date.now() - (deadline - limitMs) > 15_000) {
			if (++quiet >= 3) { return { allowed }; }
		}
	}
	throw new Error(`the agent had not finished after ${limitMs / 1000}s`);
}

async function lastAnswer() {
	const items = page.locator('.interactive-item-container.interactive-response');
	const n = await items.count();
	return n ? (await items.nth(n - 1).innerText()).trim() : '';
}

let signedIn = false;
let liveUrl = '';

await step(page, 'app-starts', async () => {
	await page.waitForSelector('.monaco-workbench', { timeout: 180_000 });
	await sleep(4000);
	const title = await page.title();
	return `window: ${title}`;
});

await step(page, 'folder-is-open', async () => {
	await page.keyboard.press('Control+Shift+KeyE');
	await sleep(1500);
	const tree = await page.locator('.explorer-folders-view').innerText();
	if (!/menu\.js|src/.test(tree)) { throw new Error(`the explorer does not show the project: ${tree.slice(0, 120)}`); }
	return tree.split('\n').slice(0, 6).join(', ');
});

signedIn = await step(page, 'sign-in', async () => {
	await command('CloudeIDE: Sign In with an API Token');
	await page.keyboard.type(TOKEN, { delay: 3 });
	await page.keyboard.press('Enter');
	const dialog = page.locator('.monaco-dialog-box');
	await dialog.waitFor({ timeout: 60_000 });
	const text = await dialog.innerText();
	await page.locator('.monaco-dialog-box .monaco-button').first().click();
	if (!/Signed in/i.test(text)) { throw new Error(`the server said: ${text}`); }
	// Not the dialog's own words: they name the account, and these results
	// are published on a branch.
	return 'signed in';
});

const chatOpen = await step(page, 'chat-opens', async () => {
	await command('View: Show Chat');
	await chatInput().waitFor({ timeout: 30_000 });
	const picker = await page.locator('.interactive-input-part').innerText().catch(() => '');
	return `input: ${picker.split('\n').filter(Boolean).slice(-3).join(' · ')}`;
});

let edited = false;
if (signedIn && chatOpen) {
	edited = await step(page, 'agent-edits-a-file', async () => {
		const before = await readFile(path.join(WORKSPACE, 'src/menu.js'), 'utf8');
		const { allowed } = await ask('Add a one-line comment at the very top of src/menu.js that says what the file is for. Change nothing else.', 240_000);
		const keep = page.locator('.monaco-button:visible', { hasText: /^Keep$/ }).first();
		await keep.waitFor({ timeout: 20_000 });
		const answer = await lastAnswer();
		return `answer: ${answer.slice(0, 200)}${allowed.length ? ` · allowed: ${allowed.join(' ; ')}` : ''} · file was ${before.length} chars`;
	});

	if (edited) {
		await step(page, 'keep-saves-the-change', async () => {
			await page.locator('.monaco-button:visible', { hasText: /^Keep$/ }).first().click();
			await sleep(2000);
			await page.keyboard.press('Control+KeyS').catch(() => { });
			await sleep(1500);
			const after = await readFile(path.join(WORKSPACE, 'src/menu.js'), 'utf8');
			const first = after.split('\n')[0];
			if (!/^\s*(\/\/|\/\*)/.test(first)) { throw new Error(`the first line on disk is not a comment: ${first}`); }
			return `first line on disk: ${first}`;
		});
	}

	await step(page, 'agent-deploys-a-preview', async () => {
		const { allowed } = await ask('Deploy this project to the preview environment and tell me the address it is live at.', 480_000);
		const answer = await lastAnswer();
		const url = (answer.match(/https:\/\/[^\s)'"`]+/g) ?? []).find(u => !/github\.com/.test(u));
		if (!url) { throw new Error(`no address in the answer: ${answer.slice(0, 300)}`); }
		liveUrl = url.replace(/[.,]$/, '');
		return `${liveUrl}${allowed.length ? ` · allowed: ${allowed.join(' ; ')}` : ''}`;
	});

	if (liveUrl) {
		await step(page, 'preview-address-answers', async () => {
			let status = 0; let body = '';
			for (let i = 0; i < 6 && status !== 200; i++) {
				const res = await fetch(liveUrl, { redirect: 'follow' }).catch(e => ({ status: 0, text: async () => String(e) }));
				status = res.status; body = await res.text();
				if (status !== 200) { await sleep(10_000); }
			}
			if (status !== 200) { throw new Error(`${liveUrl} answered ${status}: ${body.slice(0, 120)}`); }
			if (!/Cafe Nirvana/.test(body)) { throw new Error(`${liveUrl} answered, but not with the project's page: ${body.slice(0, 120)}`); }
			return `${liveUrl} answered 200 with the project's page`;
		});
	}

	await step(page, 'cloud-tab-shows-it', async () => {
		await command('CloudeIDE: Cloud');
		await sleep(5000);
		const text = await page.locator('.cloudeide-cloud-editor, .editor-instance').first().innerText().catch(() => '');
		if (!/Deploy/i.test(text)) { throw new Error(`the Cloud tab did not render: ${text.slice(0, 160)}`); }
		return text.split('\n').filter(Boolean).slice(0, 8).join(' · ');
	});
}

const summary = {
	run: process.env.GITHUB_RUN_ID ?? null,
	passed: results.filter(r => r.ok).length,
	failed: results.filter(r => !r.ok).length,
	seconds: Number(secs()),
	results,
	pageErrors: pageErrors.slice(0, 20),
};
await writeFile(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
await app.close().catch(() => { });
process.exit(summary.failed ? 1 : 0);
