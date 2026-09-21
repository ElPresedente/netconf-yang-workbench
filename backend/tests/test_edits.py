from copy import deepcopy
import pytest
from lxml import etree
from netconf_backend.edits import build_edit, edit_capabilities, CAP
from netconf_backend.requests import BASE, display_xml
from netconf_backend.protocol.rpc import BackendError
from netconf_backend.main import Backend
from test_requests import schema, ROOT, LIST, tags
from test_session import setup_session, PARAMS

CAPS = [CAP + x for x in ('candidate:1.0', 'writable-running:1.0', 'validate:1.1', 'rollback-on-error:1.0')]


def change(path=LIST + '/mtu', operation='merge', value='9000', name='eth1/1'):
    return dict(schemaPath=path, operation=operation, value=value,
                ancestorKeys=[dict(listSchemaPath=LIST, values={'name': name})] if path.startswith(LIST) else [])


def intent(*changes, **options):
    return dict(target='candidate', defaultOperation='none', changes=list(changes), **options)


def test_capabilities():
    assert edit_capabilities([])['editableTargets'] == []
    assert edit_capabilities([CAP + 'startup:1.0'])['editableTargets'] == []
    assert edit_capabilities([CAP + 'candidate:1.0'])['editableTargets'] == ['candidate']
    assert edit_capabilities([CAP + 'writable-running:1.0'])['editableTargets'] == ['running']
    assert edit_capabilities(CAPS)['editableTargets'] == ['candidate', 'running']


@pytest.mark.parametrize('version,options', [(None, []), ('1.0', ['test-then-set', 'set']), ('1.1', ['test-then-set', 'set', 'test-only'])])
def test_validate_versions(schema, version, options):
    caps = [CAP + 'candidate:1.0'] + ([CAP + 'validate:' + version] if version else [])
    assert edit_capabilities(caps)['supportedTestOptions'] == options
    for mode in [None, 'test-then-set', 'set', 'test-only', 'invalid']:
        params = intent(change(), testOption=mode)
        if mode is None or mode in options:
            build_edit(schema, params, caps)
        else:
            with pytest.raises(BackendError):
                build_edit(schema, params, caps)


@pytest.mark.parametrize('patch', [
    {'target': 'startup'}, {'target': 'running'}, {'testOption': 'test-only'},
    {'errorOption': 'rollback-on-error'}, {'defaultOperation': 'replace'},
    {'defaultOperation': []}, {'changes': []}, {'withDefaults': 'trim'},
])
def test_invalid_options(schema, patch):
    with pytest.raises(BackendError):
        build_edit(schema, {**intent(change()), **patch}, [CAP + 'candidate:1.0'])


def test_no_editable_target(schema):
    with pytest.raises(BackendError):
        build_edit(schema, intent(change()), [])


@pytest.mark.parametrize('patch', [
    {'schemaPath': LIST + '/statistics'}, {'schemaPath': LIST + '/name'},
    {'schemaPath': ROOT + '/dns'}, {'schemaPath': '/stale'},
    {'value': 9007199254740993}, {'value': '\x00'}, {'operation': 'invalid'},
    {'ancestorKeys': []}, {'ancestorKeys': [{'listSchemaPath': LIST, 'values': {'mtu': '5'}}]},
    {'ancestorKeys': [{'listSchemaPath': LIST, 'values': {'name': 1}}]},
])
def test_invalid_change(schema, patch):
    with pytest.raises(BackendError):
        build_edit(schema, intent({**change(), **patch}), CAPS)


def test_siblings_instances_namespace_escape(schema):
    payload, config = build_edit(schema, intent(change(), change(LIST + '/test-augment:description', value='a<&"b'), change(name='eth1/2')), CAPS)
    assert tags(config) == ['config', 'system', 'interface', 'name', 'mtu', 'description', 'interface', 'name', 'mtu']
    assert config[0][0][2].tag == '{urn:test:augment}description'
    assert config[0][0][2].text == 'a<&"b'
    assert config[0][1][0].text == 'eth1/2'
    assert etree.fromstring(display_xml(payload).encode()).find('.//{urn:test:augment}description').text == 'a<&"b'
    assert config[0][0][1].get(f'{{{BASE}}}operation') == 'merge'


def test_keys_order_creation_and_children(schema):
    c = dict(schemaPath='/multi:item', operation='create', ancestorKeys=[dict(listSchemaPath='/multi:item', values={'a': '2', 'z': '1'})])
    child = {**c, 'schemaPath': '/multi:item/nested/inner/value', 'operation': 'merge', 'value': 'text'}
    _, config = build_edit(schema, intent(child, c), CAPS)
    assert tags(config) == ['config', 'item', 'z', 'a', 'nested', 'inner', 'value']
    assert config[0].get(f'{{{BASE}}}operation') == 'create'
    assert config[0][0].text == '1'


@pytest.mark.parametrize('operation', ['create', 'merge', 'delete', 'remove', 'replace'])
def test_structure_and_operations(schema, operation):
    _, config = build_edit(schema, intent(change(ROOT + '/service', operation, None)), CAPS)
    assert config[0][0].get(f'{{{BASE}}}operation') == operation
    assert len(config[0][0]) == 0


@pytest.mark.parametrize('default', [None, 'merge', 'replace'])
@pytest.mark.parametrize('op', ['delete', 'remove'])
def test_destructive_scaffold_requires_none(schema, default, op):
    params = {**intent(change(operation=op, value=None)), 'defaultOperation': default}
    with pytest.raises(BackendError, match='default-operation none'):
        build_edit(schema, params, CAPS)


@pytest.mark.parametrize('pair', [
    [change(), change(value='8000')], [change(), change()],
    [change(LIST, 'create', None), change(LIST, 'delete', None)],
    [change(LIST, 'delete', None), change()],
    [change(), change(LIST, 'remove', None)],
    [change(LIST, 'replace', None), change()],
])
def test_conflicts(schema, pair):
    with pytest.raises(BackendError) as exc:
        build_edit(schema, intent(*pair), CAPS)
    assert exc.value.code == 'edit_conflict'


def test_same_session_preview_and_omission(schema):
    session, transport, manager, factory, _ = setup_session(CAPS)
    session.connect(PARAMS)
    backend = Backend(session.emit, session=session, schema=schema)
    params = {**intent(change()), 'defaultOperation': None, 'testOption': None, 'errorOption': None}
    before = manager.mock_calls[:]
    preview = backend.dispatch('edit.preview', params)
    assert manager.mock_calls == before
    assert 'default-operation' not in preview['xml']
    manager.edit_config.return_value.xml = f'<rpc-reply xmlns="{BASE}"><ok/></rpc-reply>'
    mode = manager.raise_mode
    result = backend.dispatch('edit.execute', params)
    assert not result['errors']
    assert manager.raise_mode == mode
    assert set(manager.edit_config.call_args.kwargs) == {'config', 'target'}
    factory.assert_called_once()
    transport.connect.assert_called_once()
    manager.commit.assert_not_called()
    manager.get.assert_not_called()
    manager.get_config.assert_not_called()
    manager.get_schema.assert_not_called()


def test_nested_instance_contexts_and_text_precision(tmp_path):
    from types import SimpleNamespace
    from netconf_backend.yang.runtime import create_context
    from netconf_backend.yang.serializer import serialize_context
    with create_context(tmp_path) as context:
        context.parse_module_str('''module nested {
          yang-version 1.1; namespace "urn:nested"; prefix n;
          list outer { key "z a"; leaf z { type string; } leaf a { type string; }
            list inner { key "id"; leaf id { type string; } leaf value { type uint64; } }
          }
        }''')
        context.compile_schema()
        _, tree = serialize_context(context)
        snapshot = SimpleNamespace(context=context, tree=tree)
        c = dict(schemaPath='/nested:outer/inner/value', operation='merge', value='18446744073709551615', ancestorKeys=[
            dict(listSchemaPath='/nested:outer', values={'a': '2', 'z': '1'}),
            dict(listSchemaPath='/nested:outer/inner', values={'id': 'first'})])
        d = deepcopy(c)
        d['ancestorKeys'][1]['values']['id'] = 'second'
        _, config = build_edit(snapshot, intent(c, d), CAPS)
        assert tags(config) == ['config', 'outer', 'z', 'a', 'inner', 'id', 'value', 'inner', 'id', 'value']
        assert config[0][2][1].text == '18446744073709551615'
        assert config[0][3][0].text == 'second'
        with pytest.raises(BackendError):
            build_edit(snapshot, intent({**c, 'ancestorKeys': c['ancestorKeys'][:1]}), CAPS)
