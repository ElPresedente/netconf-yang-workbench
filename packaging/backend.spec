from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

root = Path(SPECPATH).parent
models = Path('/usr/local/share/yang/modules/libyang')
if not models.is_dir():
    models = Path('/usr/share/yang/modules/libyang')
if not models.is_dir():
    raise RuntimeError('libyang standard YANG modules are required')

a = Analysis([str(root / 'packaging/backend-entry.py')],
             pathex=[str(root / 'backend')],
             binaries=[], datas=[(str(models), 'yang')] + collect_data_files('ncclient') + copy_metadata('netconf-client-backend', recursive=True),
             hiddenimports=collect_submodules('ncclient') + collect_submodules('netconf_backend'),
             hookspath=[], runtime_hooks=[], excludes=['pytest', 'setuptools'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='netconf-backend',
          debug=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='netconf-backend')
