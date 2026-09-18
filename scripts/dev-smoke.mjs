import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchRenderer } from './dev.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'netconf-dev-'));
const css = 'frontend/src/style.css';
const marker = '\n:root { --netconf-dev-smoke: rebuilt; }\n';
let app;
let watcher;
let launchCount = 0;
let rebuildCount = 0;
let resolveStarted;
let rejectStarted;
const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
const timeout = setTimeout(() => rejectStarted(new Error('Dev startup timed out')), 30000);
try {
  watcher = await watchRenderer({
    async launch() {
      launchCount++;
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: { ...process.env, NETCONF_DEV: '1' } });
      const page = await app.firstWindow();
      await page.getByText('Backend ready', { exact: true }).waitFor();
      resolveStarted(page);
    },
    async rebuilt() {
      rebuildCount++;
      // Exercise the same main-process IPC handler used by npm run dev.
      await app.evaluate(() => process.emit('message', { type: 'renderer-built' }));
    },
    report(error) { rejectStarted(error); },
  });
  const page = await started;
  clearTimeout(timeout);
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('requestfailed', request => failures.push(request.url()));
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), true);
  await writeFile(css, (await readFile(css, 'utf8')) + marker);
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--netconf-dev-smoke').trim() === 'rebuilt');
  await page.getByText('Backend ready', { exact: true }).waitFor();
  assert.equal(await page.getByText('DISCONNECTED', { exact: true }).isVisible(), true);
  assert.equal(launchCount, 1);
  assert.ok(rebuildCount >= 1);
  assert.deepEqual(failures, []);
  await page.screenshot({ path: 'dist/dev-smoke.png' });
  console.log('Dev smoke passed: completed-build startup and source-change reload render successfully; one Electron launch, no failed assets.');
} finally {
  clearTimeout(timeout);
  await watcher?.close();
  await writeFile(css, (await readFile(css, 'utf8')).replace(marker, ''));
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
