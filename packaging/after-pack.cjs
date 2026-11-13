const { rename, writeFile, chmod } = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ appOutDir, electronPlatformName }) => {
  if (electronPlatformName !== 'linux') return;
  const executable = path.join(appOutDir, 'netconf-client');
  await rename(executable, `${executable}.bin`);
  await writeFile(executable, `#!/bin/sh
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LD_LIBRARY_PATH="$APP_DIR/resources/linux-libs:$APP_DIR\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$APP_DIR/netconf-client.bin" "$@"
`);
  await chmod(executable, 0o755);
};
