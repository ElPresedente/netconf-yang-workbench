from unittest.mock import Mock
import pytest
from ncclient.transport.errors import AuthenticationError
from netconf_backend.netconf.session import NetconfSession, DefaultDeviceHandler, BASE_11
from netconf_backend.protocol.rpc import BackendError

PARAMS = {"host": "device", "port": 830, "username": "admin", "password": "never-log-this"}


def setup_session(capabilities=None):
    events = []
    transport = Mock()
    transport.server_capabilities = capabilities if capabilities is not None else [BASE_11]
    transport.connected = True
    manager = Mock()
    manager.session_id = 42
    manager.server_capabilities = transport.server_capabilities
    factory = Mock(return_value=transport)
    session = NetconfSession(lambda name, data: events.append((name, data)), factory, Mock(return_value=manager))
    return session, transport, manager, factory, events


def states(events):
    return [d["state"] for n, d in events if n == "connection.stateChanged"]


def test_only_explicit_connect_and_single_session():
    session, transport, manager, factory, events = setup_session()
    session.info(); session.disconnect()
    factory.assert_not_called()
    assert BASE_11 in DefaultDeviceHandler().get_capabilities()
    assert 'urn:ietf:params:netconf:base:1.0' in DefaultDeviceHandler().get_capabilities()
    result = session.connect(PARAMS)
    assert result["sessionId"] == "42"
    transport.connect.assert_called_once()
    assert transport.connect.call_args.kwargs["allow_agent"] is False
    assert transport.connect.call_args.kwargs["hostkey_verify"] is True
    manager.get.assert_not_called()
    manager.get_schema.assert_not_called()
    with pytest.raises(BackendError) as exc:
        session.connect(PARAMS)
    assert exc.value.code == "already_connected"
    session.disconnect()
    manager.close_session.assert_called_once()
    transport.transport.close.assert_called()
    assert states(events) == ["connecting", "connected", "disconnecting", "disconnected"]
    assert PARAMS["password"] not in str(events)


def test_failure_never_reconnects():
    session, transport, _, factory, events = setup_session()
    transport.connect.side_effect = AuthenticationError("bad credentials")
    with pytest.raises(BackendError) as exc:
        session.connect(PARAMS)
    assert exc.value.code == "authentication_failed"
    assert states(events) == ["connecting", "disconnected"]
    factory.assert_called_once()


@pytest.mark.parametrize('version', ['1.0', '1.1'])
def test_negotiated_version(version):
    session, transport, manager, factory, events = setup_session([f"urn:ietf:params:netconf:base:{version}"])
    assert session.connect(PARAMS)['protocolVersion'] == version
    factory.assert_called_once()
    session.disconnect()


def test_eof_event_no_reconnect_and_no_stale_listener():
    session, transport, _, factory, events = setup_session()
    session.connect(PARAMS)
    listener = transport.add_listener.call_args.args[0]
    listener.errback(EOFError())
    assert session.info()["state"] == "disconnected"
    factory.assert_called_once()
    with pytest.raises(BackendError) as exc:
        session.get_schema("example")
    assert exc.value.code == "not_connected"
    listener.errback(EOFError())
    assert states(events) == ["connecting", "connected", "disconnected"]


def test_close_error_still_closes_transport():
    session, transport, manager, _, events = setup_session()
    session.connect(PARAMS)
    manager.close_session.side_effect = TimeoutError()
    assert session.disconnect()["state"] == "disconnected"
    assert manager.timeout == 3
    transport.transport.close.assert_called()
