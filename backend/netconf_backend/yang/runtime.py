"""libyang runtime setup, including packaged standard-module search paths."""
import os
from pathlib import Path
import libyang
from ..protocol.rpc import BackendError


def create_context(search_path=None):
    paths = [str(search_path)] if search_path else []
    # Some distributions compile libyang with a different installation prefix
    # from where they package its mandatory standard modules.
    configured = os.environ.get("NETCONF_LIBYANG_MODULES")
    candidates = [configured] if configured else ["/usr/share/yang/modules/libyang", "/usr/local/share/yang/modules/libyang"]
    paths.extend(p for p in candidates if p and Path(p).is_dir())
    try:
        return libyang.Context(os.pathsep.join(paths) or None, explicit_compile=True, disable_searchdir_cwd=True)
    except libyang.LibyangError as exc:
        raise BackendError("yang_compile_failed", "Cannot initialize system libyang. Install its standard YANG modules or set NETCONF_LIBYANG_MODULES.", str(exc)) from None
