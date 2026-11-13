import tempfile
from pathlib import Path
import libyang
from ..protocol.rpc import BackendError
from .repository import filename
from .serializer import serialize_context
from .runtime import create_context
from .api import namespace, revision


class SchemaContext:
    def __init__(self):
        self.context = None
        self.modules = []
        self.tree = {"roots": []}

    def clear(self):
        if self.context is not None:
            self.context.destroy()
        self.context = None
        self.modules, self.tree = [], {"roots": []}

    def compile(self, inventory, repository, session):
        downloaded = {}
        callback_errors = []
        # A fresh directory prevents stale cached revisions affecting compilation.
        # libyang requests missing imports/includes; we never parse YANG ourselves.
        with tempfile.TemporaryDirectory(prefix="netconf-yang-") as staging:
            def obtain(name, revision):
                key = (name, revision)
                if key not in downloaded:
                    filename(name, revision)
                    try:
                        source = session.get_schema(name, revision)
                    except BackendError as exc:
                        raise BackendError("schema_download_failed", f"Failed to retrieve {name}@{revision or 'latest'}", exc.message) from None
                    if not isinstance(source, str) or not source.strip():
                        raise BackendError("schema_download_failed", f"Empty YANG source for {name}")
                    repository.write(name, revision, source)
                    (Path(staging) / filename(name, revision)).write_text(source, encoding="utf-8")
                    downloaded[key] = source
                    session.emit("schema.progress", {"current": len(downloaded), "total": max(len(inventory), len(downloaded)), "module": name})
                return downloaded[key]

            for spec in inventory:
                obtain(spec.name, spec.revision)
            ctx = create_context(staging)

            def module_loader(name, revision, subname, subrevision):
                try:
                    return "yang", obtain(subname or name, subrevision if subname else revision)
                except Exception as exc:
                    callback_errors.append(exc)
                    return None

            ctx.external_module_loader.set_module_data_clb(module_loader)
            try:
                # libyang owns its built-in annotation module and cannot replace
                # it with the revision advertised by an older libyang server.
                builtin_yang = next((m for m in ctx if m.name() == "yang"
                                     and namespace(m) == "urn:ietf:params:xml:ns:yang:1"
                                     and m.implemented()), None)
                for spec in inventory:
                    if spec.implemented and not spec.submodule:
                        if spec.name == "yang" and builtin_yang is not None:
                            if spec.revision and spec.revision != revision(builtin_yang):
                                session.log(f"Using libyang's built-in yang@{revision(builtin_yang)} "
                                            f"annotations; device advertises yang@{spec.revision}", level="warning")
                            continue
                        ctx.load_module(spec.name, spec.revision, enabled_features=spec.features)
                ctx.compile_schema()
                session.require_connected()
                modules, tree = serialize_context(
                    ctx,
                    implemented_names={s.name for s in inventory if s.implemented and not s.submodule},
                    loaded_names={name for name, _revision in downloaded},
                )
            except Exception as exc:
                ctx.destroy()
                if callback_errors and isinstance(callback_errors[0], BackendError):
                    raise callback_errors[0]
                if isinstance(exc, BackendError):
                    raise
                raise BackendError("yang_compile_failed", "Failed to compile the effective YANG schema", str(exc)) from None
            finally:
                # No future introspection is allowed to trigger network retrieval.
                if ctx.cdata is not None:
                    ctx.external_module_loader.set_module_data_clb(None)
            self.clear()
            self.context, self.modules, self.tree = ctx, modules, tree
            return {"modulesDownloaded": len(downloaded), "modulesLoaded": len(modules)}
