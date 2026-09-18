import io
import json
import pytest
from netconf_backend.protocol.rpc import BackendError, parse_request, response, encode
from netconf_backend.main import serve


@pytest.mark.parametrize("raw", ["bad", "[]", "null", '{"id":true,"method":"disconnect"}',
    '{"id":1,"method":"exec"}', '{"id":1,"method":"connect","params":[]}',
    '{"id":1,"method":"disconnect","params":{"x":1}}'])
def test_invalid(raw):
    with pytest.raises(BackendError) as exc:
        parse_request(raw)
    assert exc.value.code == "invalid_request"


def test_connect_validation():
    params = {"host": "router", "port": 830, "username": "admin", "password": "secret"}
    for key, value in [("host", ""), ("port", True), ("port", 0), ("port", 65536), ("password", None), ("authMode", "key")]:
        with pytest.raises(BackendError):
            parse_request(json.dumps({"id": 1, "method": "connect", "params": {**params, key: value}}))
    assert parse_request(json.dumps({"id": 1, "method": "connect", "params": params}))["params"] == params


def test_response_encoding():
    assert json.loads(encode(response(12, result={"state": "connected"}))) == {"id": 12, "result": {"state": "connected"}}
    error = response(3, error=BackendError("not_connected", "Connect first"))
    assert error == {"id": 3, "error": {"code": "not_connected", "message": "Connect first"}}
    assert encode(response(1, result="a\nb")).count("\n") == 1


def test_loop_survives_errors_and_shuts_down_without_connecting():
    output = io.StringIO()
    serve(io.StringIO('oops\n{"id":1,"method":"exec"}\n{"id":2,"method":"connection.getState"}\n{"id":3,"method":"shutdown"}\n'), output)
    messages = [json.loads(line) for line in output.getvalue().splitlines()]
    assert messages[0]["event"] == "backend.ready"
    assert messages[1]["id"] is None
    assert messages[2]["id"] == 1
    assert messages[3]["result"]["state"] == "disconnected"
    assert messages[4]["result"]["state"] == "disconnected"
