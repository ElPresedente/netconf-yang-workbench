import hashlib
import re
from pathlib import Path
from platformdirs import user_cache_path
from ..protocol.rpc import BackendError


def filename(name, revision):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", name) or (revision and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", revision)):
        raise BackendError("schema_download_failed", "Device supplied an invalid module name or revision")
    return name + (f"@{revision}" if revision else "") + ".yang"


class YangRepository:
    def __init__(self, host, port, base: Path | None = None):
        device = hashlib.sha256(f"{host.lower()}:{port}".encode()).hexdigest()[:24]
        self.path = (base or user_cache_path("netconf-client")) / "devices" / device / "yang"
        self.path.mkdir(parents=True, exist_ok=True)

    def write(self, name, revision, source):
        path = self.path / filename(name, revision)
        tmp = path.with_suffix(".yang.tmp")
        tmp.write_text(source, encoding="utf-8")
        tmp.replace(path)
        return path
