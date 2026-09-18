from types import SimpleNamespace
from unittest.mock import Mock
from pathlib import Path
import pytest
from lxml import etree
from netconf_backend.requests import build_request, display_xml, BASE
from netconf_backend.protocol.rpc import BackendError
from netconf_backend.yang.runtime import create_context
from netconf_backend.yang.serializer import serialize_context
from netconf_backend.main import Backend
from test_session import setup_session, PARAMS


@pytest.fixture
def schema(tmp_path):
    fixtures = Path(__file__).parent / 'fixtures' / 'yang'
    with create_context(fixtures) as context:
        context.load_module('test-system')
        context.load_module('test-augment')
        context.parse_module_str('''module multi {
          yang-version 1.1; namespace "urn:test:multi"; prefix m;
          list item { key "z a"; leaf a { type string; } leaf z { type string; }
            container nested { container inner { leaf value { type string; units "bytes"; } } }
          }
        }''')
        context.compile_schema()
        _, tree = serialize_context(context)
        yield SimpleNamespace(context=context, tree=tree)


def intent(*paths, operation='get', datastore=None, keys=None):
    return dict(operation=operation, datastore=datastore, selectedPaths=list(paths), listKeyValues=keys or {})


ROOT = '/test-system:system'
LIST = ROOT + '/interface'


def built(schema, *paths, **kwargs):
    return build_request(schema, intent(*paths, **kwargs), [])[1]


def tags(node):
    return [etree.QName(n).localname for n in node.iter()]


def test_leaf_ancestors_and_siblings(schema):
    assert tags(built(schema, ROOT + '/enabled')) == ['filter', 'system', 'enabled']
    assert tags(built(schema, ROOT + '/hostname', ROOT + '/enabled')) == ['filter', 'system', 'enabled', 'hostname']
    assert display_xml(built(schema, ROOT + '/enabled', ROOT + '/hostname')) == display_xml(built(schema, ROOT + '/hostname', ROOT + '/enabled', ROOT + '/enabled'))


def test_nested_containers_and_units(schema):
    assert tags(built(schema, '/multi:item/nested/inner/value')) == ['filter', 'item', 'nested', 'inner', 'value']
    def walk(nodes):
        for n in nodes:
            yield n
            yield from walk(n['children'])
    assert next(n for n in walk(schema.tree['roots']) if n['name'] == 'value')['units'] == 'bytes'


def test_list_without_keys_and_whole_subtree(schema):
    assert tags(built(schema, LIST + '/mtu')) == ['filter', 'system', 'interface', 'mtu']
    assert tags(built(schema, LIST, LIST + '/mtu')) == ['filter', 'system', 'interface']


def test_key_match_escape_and_no_duplicate(schema):
    result = built(schema, LIST + '/mtu', LIST + '/name', keys={LIST: {'name': 'eth<&"1/1'}})
    assert tags(result) == ['filter', 'system', 'interface', 'name', 'mtu']
    key = result[0][0][0]
    assert key.tag == '{urn:test:system}name'
    assert key.text == 'eth<&"1/1'
    assert etree.fromstring(display_xml(result).encode())[0][0][0].text == key.text


def test_multi_key_order(schema):
    result = built(schema, '/multi:item/nested/inner/value', keys={'/multi:item': {'a': '2', 'z': '1'}})
    assert tags(result) == ['filter', 'item', 'z', 'a', 'nested', 'inner', 'value']
    assert result[0][0].text == '1'


def test_full_subtree_with_key_keeps_output(schema):
    result = built(schema, LIST, keys={LIST: {'name': 'eth0'}})
    assert tags(result) == ['filter', 'system', 'interface', 'name', 'mtu', 'statistics', 'description']


def test_parent_subtree_with_nested_match_keeps_siblings(schema):
    result = built(schema, ROOT, keys={LIST: {'name': 'eth0'}})
    assert 'enabled' in tags(result) and 'service' in tags(result)
    assert result.find('.//{urn:test:system}name').text == 'eth0'


def test_state_get_and_augment_namespace(schema):
    assert tags(built(schema, LIST + '/statistics'))[-1] == 'statistics'
    result = built(schema, LIST + '/test-augment:description')
    assert result[0].tag == '{urn:test:system}system'
    assert result[0][0][0].tag == '{urn:test:augment}description'
    with pytest.raises(BackendError):
        built(schema, LIST + '/statistics', operation='get-config', datastore='running')


@pytest.mark.parametrize('patch', [
    {'selectedPaths': ['/stale:path']}, {'selectedPaths': []}, {'selectedPaths': [4]},
    {'operation': 'edit-config'}, {'datastore': 'running'}, {'namespace': 'fake'},
    {'listKeyValues': {LIST: {'mtu': '1500'}}}, {'listKeyValues': {LIST: {'name': 2}}},
    {'listKeyValues': {'/stale:list': {'name': 'x'}}}, {'listKeyValues': []},
    {'listKeyValues': {LIST: {'name': '\x00'}}},
])
def test_invalid_intent(schema, patch):
    with pytest.raises(BackendError):
        build_request(schema, {**intent(LIST + '/mtu'), **patch}, [])


@pytest.mark.parametrize('store', ['running', 'candidate', 'startup', 'unsupported'])
def test_datastore_validation(schema, store):
    params = intent(ROOT, operation='get-config', datastore=store)
    if store != 'running':
        with pytest.raises(BackendError):
            build_request(schema, params, [])
    if store != 'unsupported':
        payload, _ = build_request(schema, params, [f'urn:ietf:params:netconf:capability:{store}:1.0?extra=value'])
        assert payload.find(f'{{{BASE}}}source')[0].tag == f'{{{BASE}}}{store}'


def test_preview_pure_execute_single_owner(schema):
    session, transport, manager, factory, _ = setup_session()
    backend = Backend(session.emit, session=session, schema=schema)
    params = intent(ROOT + '/enabled')
    backend.dispatch('request.preview', params)
    factory.assert_not_called()
    with pytest.raises(BackendError):
        backend.dispatch('request.execute', params)
    session.connect(PARAMS)
    manager.get.return_value.xml = f'<rpc-reply xmlns="{BASE}"><data/></rpc-reply>'
    before = manager.mock_calls[:]
    preview = backend.dispatch('request.preview', params)
    assert manager.mock_calls == before
    backend.dispatch('request.execute', params)
    factory.assert_called_once()
    transport.connect.assert_called_once()
    manager.get.assert_called_once()
    expected = etree.fromstring(preview['xml'].encode(), etree.XMLParser(remove_blank_text=True))[0]
    assert etree.tostring(manager.get.call_args.kwargs['filter']) == etree.tostring(expected)
    session.disconnect()
    with pytest.raises(BackendError):
        backend.dispatch('request.execute', params)
    factory.assert_called_once()

from netconf_backend.requests import supported_with_defaults, WITH_DEFAULTS_CAP, WITH_DEFAULTS_NS


@pytest.mark.parametrize('suffix,expected', [
    (None, None),
    ('?basic-mode=explicit', ['explicit']),
    ('?basic-mode=explicit&also-supported=trim,report-all', ['explicit', 'trim', 'report-all']),
    ('?basic-mode=trim&also-supported=report-all-tagged', ['trim', 'report-all-tagged']),
    ('?basic-mode=explicit&also-supported=unknown', ['explicit']),
])
def test_with_defaults_capability(suffix, expected):
    assert supported_with_defaults([] if suffix is None else [WITH_DEFAULTS_CAP + suffix]) == expected


@pytest.mark.parametrize('operation', ['get', 'get-config'])
@pytest.mark.parametrize('mode', [None, 'explicit', 'trim', 'report-all', 'report-all-tagged'])
def test_with_defaults_preview_and_execution(schema, operation, mode):
    caps = [WITH_DEFAULTS_CAP + '?basic-mode=explicit&also-supported=trim,report-all,report-all-tagged']
    session, transport, manager, factory, _ = setup_session(caps)
    session.connect(PARAMS)
    backend = Backend(session.emit, session=session, schema=schema)
    params = {**intent(ROOT, operation=operation, datastore='running' if operation == 'get-config' else None), 'withDefaults': mode}
    method = manager.get if operation == 'get' else manager.get_config
    method.return_value.xml = f'<rpc-reply xmlns="{BASE}"><data/></rpc-reply>'
    before = manager.mock_calls[:]
    preview = backend.dispatch('request.preview', params)
    assert manager.mock_calls == before
    payload = etree.fromstring(preview['xml'].encode())
    wd = payload.find(f'{{{WITH_DEFAULTS_NS}}}with-defaults')
    if mode is None:
        assert wd is None
    else:
        assert wd.text == mode
        assert payload[-1] is wd
        assert etree.QName(payload[-2]).localname == 'filter'
    backend.dispatch('request.execute', params)
    assert method.call_args.kwargs['with_defaults'] == mode
    if operation == 'get-config':
        assert method.call_args.kwargs['source'] == 'running'
    assert session.require_connected() is manager
    factory.assert_called_once()
    transport.connect.assert_called_once()


@pytest.mark.parametrize('command', ['request.preview', 'request.execute'])
@pytest.mark.parametrize('caps,mode', [
    ([], 'explicit'),
    ([WITH_DEFAULTS_CAP + '?basic-mode=explicit'], 'trim'),
    ([WITH_DEFAULTS_CAP + '?basic-mode=explicit'], 'report-all-tagged'),
    ([WITH_DEFAULTS_CAP + '?basic-mode=explicit&also-supported=unknown'], 'unknown'),
    ([WITH_DEFAULTS_CAP + '?basic-mode=explicit'], []),
])
def test_with_defaults_rejected_by_backend(schema, command, caps, mode):
    session, _, manager, factory, _ = setup_session(caps)
    session.connect(PARAMS)
    backend = Backend(session.emit, session=session, schema=schema)
    with pytest.raises(BackendError, match='with-defaults'):
        backend.dispatch(command, {**intent(ROOT), 'withDefaults': mode})
    manager.get.assert_not_called()
    manager.get_config.assert_not_called()
    factory.assert_called_once()
