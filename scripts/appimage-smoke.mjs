import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const artifact = process.argv[2] || path.join('release', (await readdir('release')).find(f => f.endsWith('.AppImage')) || 'missing.AppImage');
const workspace = await mkdtemp(path.join(tmpdir(), 'netconf-appimage-'));
let app;
let backendPid;
try {
  execFileSync(path.resolve(artifact), ['--appimage-extract'], { cwd: workspace, stdio: 'ignore' });
  const appDir = path.join(workspace, 'squashfs-root');
  const env = { ...process.env, PYTHONPATH: '', PYTHONHOME: '', PATH: '/usr/bin:/bin' };
  for (const key of ['NETCONF_PYTHON', 'NETCONF_BACKEND_PATH', 'NETCONF_LIBYANG_MODULES', 'LD_LIBRARY_PATH']) delete env[key];
  const selfTest = JSON.parse(execFileSync(path.join(appDir, 'resources/backend/netconf-backend'), ['--self-test'], { env, encoding: 'utf8' }));
  assert.equal(selfTest.ok, true);
  console.log('Bundled backend self-test:', selfTest);
  app = await electron.launch({ executablePath: path.join(appDir, 'AppRun'),
    args: [`--user-data-dir=${path.join(workspace, 'profile')}`, '--no-sandbox'],
    cwd: workspace, env, timeout: 30000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('Backend ready', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const state = await page.evaluate(() => window.netconf.getConnectionState());
  assert.equal(state.result.state, 'disconnected');
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), true);
  const pid = app.process().pid;
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/);
  for (const child of children) {
    try {
      if ((await readFile(`/proc/${child}/cmdline`, 'utf8')).includes('resources/backend/netconf-backend')) backendPid = Number(child);
    } catch { /* transient Electron utility process */ }
  }
  assert.ok(backendPid, 'Packaged Electron must own the bundled backend');
  const maps = await readFile(`/proc/${backendPid}/maps`, 'utf8');
  assert.match(maps, /resources\/backend\/_internal\/libyang\.so/);
  const desktopMaps = await readFile(`/proc/${pid}/maps`, 'utf8');
  assert.match(desktopMaps, /resources\/linux-libs\/libgtk-3\.so/);
  await page.screenshot({ path: 'release/appimage-smoke.png' });
  assert.deepEqual(errors, []);
  await app.close();
  app = undefined;
  assert.throws(() => process.kill(backendPid, 0), { code: 'ESRCH' });
  console.log('AppImage passed: extracted artifact, bundled Python/libyang/GTK, UI readiness, IPC, clean shutdown.');
} finally {
  if (app) await app.close();
  await rm(workspace, { recursive: true, force: true });
}
