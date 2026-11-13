import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('AppImage packaging currently requires Linux x86_64 and Docker.');
}
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const root = process.cwd();
const output = path.join(root, 'dist/packaging');
mkdirSync(output, { recursive: true });
run('npm', ['run', 'build']);
run('docker', ['build', '-f', 'packaging/Dockerfile', '-t', 'netconf-appimage-builder:0.1.0', '.']);
run('docker', ['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`,
  '-v', `${output}:/output`, '-v', `${root}/node_modules/electron/dist:/electron:ro`,
  'netconf-appimage-builder:0.1.0']);
run('node', ['node_modules/electron-builder/cli.js', '--linux', 'AppImage', '--x64', '--publish', 'never']);
for (const filename of readdirSync('release').filter(name => name.endsWith('.AppImage'))) {
  const artifact = path.join('release', filename);
  const checksum = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  writeFileSync(`${artifact}.sha256`, `${checksum}  ${filename}\n`);
}
