"""Export the frozen backend and Electron's complete ELF dependency closure."""
import json
import re
import shutil
import subprocess
from pathlib import Path

output = Path('/output')
for directory in ['backend', 'linux-libs', 'third-party-notices']:
    if (output / directory).exists():
        shutil.rmtree(output / directory)
shutil.copytree('/bundle/netconf-backend', output / 'backend', dirs_exist_ok=True)
libs = output / 'linux-libs'
libs.mkdir(exist_ok=True)
# glibc and its loader must be supplied together by the host OS.
host = {'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1',
        'libresolv.so.2', 'libutil.so.1', 'ld-linux-x86-64.so.2'}
manifest = {}
for binary in [Path('/electron/electron'), Path('/electron/libffmpeg.so'),
               Path('/usr/lib/x86_64-linux-gnu/libsecret-1.so.0'),
               Path('/usr/lib/x86_64-linux-gnu/libnotify.so.4'),
               *Path('/usr/lib/x86_64-linux-gnu').glob('libnss_*.so'),
               *Path('/usr/lib/x86_64-linux-gnu').glob('libfreebl*.so'),
               *Path('/usr/lib/x86_64-linux-gnu').glob('libsoftokn*.so')]:
    result = subprocess.run(['ldd', str(binary)], check=True, text=True, capture_output=True)
    if 'not found' in result.stdout:
        raise RuntimeError(result.stdout)
    for name, source in re.findall(r'^\s*(\S+) => (/\S+)', result.stdout, re.M):
        if name in host or source.startswith('/electron/'):
            continue
        shutil.copy2(source, libs / name)
        manifest[name] = source
    if str(binary).startswith('/usr/'):
        shutil.copy2(binary, libs / binary.name)
        manifest[binary.name] = str(binary)
(output / 'native-libraries.json').write_text(json.dumps(manifest, indent=2) + '\n')
# Include notices for the bundled Ubuntu libraries and upstream libyang.
for notice in Path('/usr/share/doc').glob('*/copyright'):
    if notice.is_file():
        target = output / 'third-party-notices' / notice.parent.name
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(notice, target / 'copyright')
shutil.copy2('/tmp/libyang/LICENSE', output / 'third-party-notices/libyang-LICENSE')
print(f'Exported backend and {len(manifest)} desktop libraries')
