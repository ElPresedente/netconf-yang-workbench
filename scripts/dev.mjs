// File-based development: Electron sees only completed Vite builds.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);

export async function watchRenderer({ launch, rebuilt, report = console.error }) {
  const { build } = await import('vite');
  const watcher = await build({ build: { watch: {} } });
  let launched = false;
  let buildFailed = false;
  let queue = Promise.resolve();
  watcher.on('event', event => {
    if (event.code === 'START') buildFailed = false;
    if (event.code === 'ERROR') { buildFailed = true; report(event.error); }
    if (event.code === 'BUNDLE_END') void event.result.close();
    if (event.code !== 'END' || buildFailed) return;
    // END follows output writes, unlike filesystem changes during emptyOutDir.
    queue = queue.then(async () => {
      if (!launched) {
        await launch();
        launched = true;
      } else await rebuilt();
    }).catch(report);
  });
  return watcher;
}

async function main() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const initial = spawn(npm, ['run', 'build'], { stdio: 'inherit' });
  const code = await new Promise(resolve => initial.once('exit', resolve));
  if (code !== 0) { process.exitCode = code || 1; return; }
  let desktop;
  let watcher;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await watcher?.close();
    desktop?.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  watcher = await watchRenderer({
    launch() {
      if (stopping) return;
      desktop = spawn(require('electron'), ['.'], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, NETCONF_DEV: '1' },
      });
      desktop.on('error', error => { console.error(error); void stop(); });
      desktop.on('exit', () => { void stop(); });
    },
    rebuilt() {
      if (!stopping && desktop?.connected) {
        desktop.send({ type: 'renderer-built' }, error => { if (error && !stopping) console.error(error); });
      }
    },
  });
  if (stopping) await watcher.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
