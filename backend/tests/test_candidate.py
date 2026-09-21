import json
from unittest.mock import Mock, call

import pytest
from ncclient.operations.rpc import RaiseMode
from netconf_backend.main import Backend
from netconf_backend.protocol.rpc import BackendError, parse_request
from test_session import setup_session, PARAMS

CAP = 'urn:ietf:params:netconf:capability:candidate:1.0'
BASE = 'urn:ietf:params:xml:ns:netconf:base:1.0'
OK = f'<rpc-reply xmlns="{BASE}"><ok/></rpc-reply>'


@pytest.mark.parametrize('action,method', [('commit', 'commit'), ('discard', 'discard_changes')])
def test_candidate_same_session_no_schema_or_hidden_rpcs(action, method):
    session, transport, manager, factory, _ = setup_session([CAP + '?test=1'])
    session.connect(PARAMS)
    schema = Mock()
    backend = Backend(session.emit, session=session, schema=schema)
    assert manager.mock_calls == []  # Connect never commits or discards.
    getattr(manager, method).return_value.xml = OK
    previous = manager.raise_mode
    getattr(manager, method).side_effect = lambda: (assert_none(manager), Mock(xml=OK))[1]
    result = backend.dispatch('candidate.' + action, {})
    assert result['rawXml'] == OK
    assert result['errors'] == []
    assert manager.mock_calls == [getattr(call, method)()]
    assert manager.raise_mode == previous
    assert session.require_connected() is manager
    schema.assert_not_called()
    assert schema.mock_calls == []
    transport.connect.assert_called_once()
    factory.assert_called_once()
    session.disconnect()
    assert manager.mock_calls == [getattr(call, method)(), call.close_session()]


def assert_none(manager):
    assert manager.raise_mode == RaiseMode.NONE


@pytest.mark.parametrize('action,method', [('commit', 'commit'), ('discard', 'discard_changes')])
def test_candidate_errors_and_uncertain_failure(action, method):
    session, transport, manager, factory, _ = setup_session([CAP])
    session.connect(PARAMS)
    raw = f'<rpc-reply xmlns="{BASE}">' + ''.join(
        f'<rpc-error><error-type>application</error-type><error-tag>{tag}</error-tag>'
        '<error-severity>error</error-severity><error-app-tag>candidate-test</error-app-tag>'
        '<error-path>/system</error-path><error-message>Denied</error-message>'
        '<error-info><detail>why</detail></error-info></rpc-error>'
        for tag in ['operation-failed', 'access-denied']) + '</rpc-reply>'
    getattr(manager, method).return_value.xml = raw
    previous = manager.raise_mode
    result = session.execute_candidate(action)
    assert result['rawXml'] == raw
    assert [e['error-tag'] for e in result['errors']] == ['operation-failed', 'access-denied']
    assert all(len(e) == 7 and 'detail' in e['error-info'] for e in result['errors'])
    assert manager.raise_mode == previous
    getattr(manager, method).side_effect = TimeoutError()
    with pytest.raises(BackendError, match='NETCONF operation failed'):
        session.execute_candidate(action)
    assert manager.raise_mode == previous
    assert manager.mock_calls == [getattr(call, method)(), getattr(call, method)()]
    factory.assert_called_once()
    transport.connect.assert_called_once()


@pytest.mark.parametrize('action', ['commit', 'discard'])
def test_candidate_gating_and_no_parameters(action):
    session, _, manager, factory, _ = setup_session([])
    with pytest.raises(BackendError, match='Connect to a device first'):
        session.execute_candidate(action)
    factory.assert_not_called()
    session.connect(PARAMS)
    with pytest.raises(BackendError, match='require :candidate'):
        session.execute_candidate(action)
    assert manager.mock_calls == []
    method = 'candidate.' + action
    assert parse_request(json.dumps({'id': 1, 'method': method}))['params'] == {}
    for params in [{'confirmed': True}, {'timeout': 30}, {'target': 'candidate'}]:
        with pytest.raises(BackendError, match='does not accept parameters'):
            parse_request(json.dumps({'id': 1, 'method': method, 'params': params}))
        with pytest.raises(BackendError, match='does not accept parameters'):
            Backend(session.emit, session=session, schema=Mock()).dispatch(method, params)
