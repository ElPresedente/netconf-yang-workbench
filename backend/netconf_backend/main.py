"""Serialized command loop; ncclient reader callbacks emit events concurrently."""
import json
import logging
import sys
import threading
from .protocol.rpc import BackendError, encode, parse_request, response


class Backend:
    def __init__(self, emit, session=None, schema=None):
        from .netconf.session import NetconfSession
        from .yang.context import SchemaContext
        self.session = session or NetconfSession(emit)
        self.schema = schema or SchemaContext()

    def dispatch(self, method, params):
        if method == "connect":
            # A new device must never inherit the previous device's schema.
            if self.session.info()["state"] == "disconnected":
                self.schema.clear()
            return self.session.connect(params)
        if method in ("disconnect", "shutdown"):
            return self.session.disconnect()
        if method == "connection.getState":
            return self.session.info()
        if method == "schema.fetch":
            from .netconf.schema_fetcher import discover
            from .yang.repository import YangRepository
            self.session.require_connected()
            inventory = discover(self.session)
            repository = YangRepository(*self.session.endpoint)
            self.session.log(f"Discovered {len(inventory)} YANG sources; downloading and compiling")
            result = self.schema.compile(inventory, repository, self.session)
            self.session.log(f"Loaded {result['modulesLoaded']} compiled modules")
            return result
        if method in ('yangRpc.preview', 'yangRpc.execute'):
            from .yang_rpc import build_rpc, parse_rpc_reply, VALIDATION
            from .requests import display_xml
            payload = build_rpc(self.schema, params)
            preview = display_xml(payload)
            if method == 'yangRpc.preview':
                return {'xml': preview, 'validationNotice': VALIDATION}
            result = self.session.execute_yang_rpc(payload)
            result['validationNotice'] = VALIDATION
            if not result['errors']:
                try:
                    result['rpcOutput'] = parse_rpc_reply(self.schema.context, payload, result['rawXml'])
                except Exception as exc:
                    result['parseWarning'] = 'RPC succeeded. Local YANG output parsing failed; inspect the raw XML response.'
                    self.session.log(f'RPC output parsing failed ({type(exc).__name__}): {str(exc)[:2000]}', level='warning')
            return result
        if method in ("candidate.commit", "candidate.discard"):
            if params:
                raise BackendError("invalid_request", "This command does not accept parameters")
            return self.session.execute_candidate(method.split('.')[1])
        if method in ("edit.preview", "edit.execute"):
            from .edits import build_edit
            from .requests import display_xml
            payload, config = build_edit(self.schema, params, self.session.info()["capabilities"])
            preview = display_xml(payload)
            if method == "edit.preview":
                return {"xml": preview}
            return self.session.execute_edit(params, config, preview)
        if method in ("request.preview", "request.execute"):
            from .requests import build_request, display_xml
            payload, subtree = build_request(self.schema, params, self.session.info()["capabilities"])
            preview = display_xml(payload)
            if method == "request.preview":
                return {"xml": preview}
            result = self.session.execute_request(params["operation"], params.get("datastore"), subtree, preview, with_defaults=params.get("withDefaults"))
            if not result["errors"]:
                from .yang.data import parse_reply
                try:
                    result["dataNodes"] = parse_reply(self.schema.context, result["rawXml"])
                except Exception as exc:
                    result["parseWarning"] = "Request succeeded. YANG data-tree parsing failed; inspect the raw XML response."
                    self.session.log(f"Response data parsing failed ({type(exc).__name__}): {str(exc)[:2000]}", level="warning")
            return result
        if method == "schema.getModules":
            return self.schema.modules
        if method == "schema.getTree":
            return self.schema.tree
        raise BackendError("invalid_request", "Unknown command")


def serve(input_stream, output_stream, factory=Backend):
    lock = threading.Lock()

    def write(message):
        with lock:
            output_stream.write(encode(message))
            output_stream.flush()

    def emit(event, data):
        write({"event": event, "data": data})

    backend = factory(emit)
    emit("backend.ready", {})
    try:
        for line in input_stream:
            request_id = None
            try:
                # Recover a valid id even when command validation fails.
                try:
                    raw = json.loads(line)
                    if isinstance(raw, dict) and type(raw.get("id")) is int:
                        request_id = raw["id"]
                except (ValueError, RecursionError):
                    pass
                req = parse_request(line)
                result = backend.dispatch(req["method"], req["params"])
                write(response(request_id, result=result))
                if req["method"] == "shutdown":
                    break
            except BackendError as exc:
                write(response(request_id, error=exc))
            except Exception as exc:
                # Do not dump request locals or credential-bearing exception text.
                logging.error("Backend command failed: %s", type(exc).__name__)
                write(response(request_id, error=BackendError("backend_error", f"Backend operation failed ({type(exc).__name__})")))
    finally:
        backend.session.disconnect()
        backend.schema.clear()


def main():
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    # Avoid third-party wire/debug logging ever accidentally recording secrets.
    logging.getLogger("ncclient").setLevel(logging.CRITICAL)
    logging.getLogger("paramiko").setLevel(logging.CRITICAL)
    try:
        serve(sys.stdin, sys.stdout)
    except (ImportError, OSError) as exc:
        print(f"Python backend failed to start: {exc}. Check the Python environment and system libyang installation.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
