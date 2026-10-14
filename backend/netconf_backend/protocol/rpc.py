"""Small NDJSON protocol. Never include requests/credentials in error output."""
import json
from dataclasses import dataclass
from typing import Any


@dataclass
class BackendError(Exception):
    code: str
    message: str
    details: str | None = None

    def dto(self) -> dict:
        result = {"code": self.code, "message": self.message}
        if self.details:
            result["details"] = self.details
        return result


METHODS = {"connect", "disconnect", "connection.getState", "schema.fetch",
           "schema.getModules", "schema.getTree", "shutdown", "request.preview", "request.execute", "edit.preview", "edit.execute", "candidate.commit", "candidate.discard", "yangRpc.preview", "yangRpc.execute"}


def parse_request(line: str) -> dict:
    try:
        req = json.loads(line)
    except (ValueError, RecursionError):
        raise BackendError("invalid_request", "Expected one JSON object per line") from None
    if not isinstance(req, dict) or type(req.get("id")) is not int:
        raise BackendError("invalid_request", "Request must have an integer id")
    if not isinstance(req.get("method"), str) or req["method"] not in METHODS:
        raise BackendError("invalid_request", "Unknown command")
    params = req.get("params", {})
    if not isinstance(params, dict):
        raise BackendError("invalid_request", "params must be an object")
    if req["method"] == "connect":
        if set(params) - {"host", "port", "username", "password", "authMode"}:
            raise BackendError("invalid_request", "Unsupported connection parameter")
        for name in ("host", "username", "password"):
            value = params.get(name)
            if not isinstance(value, str) or len(value) > 4096 or (name != "password" and not value.strip()):
                raise BackendError("invalid_request", f"Invalid {name}")
        if type(params.get("port")) is not int or not 1 <= params["port"] <= 65535:
            raise BackendError("invalid_request", "Port must be between 1 and 65535")
        if params.get("authMode", "password") != "password":
            raise BackendError("invalid_request", "Only password authentication is supported")
    elif req["method"] in ("request.preview", "request.execute", "edit.preview", "edit.execute", "yangRpc.preview", "yangRpc.execute"):
        pass  # Validated against the current compiled snapshot by build_request.
    elif params:
        raise BackendError("invalid_request", "This command does not accept parameters")
    return {**req, "params": params}


def response(request_id: int | None, *, result: Any = None, error: BackendError | None = None) -> dict:
    return {"id": request_id, **({"error": error.dto()} if error else {"result": result})}


def encode(message: dict) -> str:
    return json.dumps(message, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n"
