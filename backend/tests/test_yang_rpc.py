from pathlib import Path
from types import SimpleNamespace
import libyang
import pytest
from lxml import etree
from netconf_backend.yang.runtime import create_context
from netconf_backend.yang.serializer import serialize_context
from netconf_backend.yang_rpc import build_rpc, parse_rpc_reply
from netconf_backend.protocol.rpc import BackendError

FIXTURES = Path(__file__).parent / 'fixtures' / 'yang'

@pytest.fixture
def schema():
    with create_context(FIXTURES) as ctx:
        ctx.load_module('test-rpc')
        ctx.compile_schema()
        _, tree = serialize_context(ctx, implemented_names={'test-rpc'})
        yield SimpleNamespace(context=ctx, tree=tree)


def operation(schema, name='complex'):
    return next(o for o in schema.tree['operations'] if o['name'] == name)


def instance(node, value=None, children=None, identity=None):
    return {'id': identity or node['path'], 'schemaPath': node['path'], 'value': value, 'children': children or []}


def intent(schema, values=None, name='complex'):
    op = operation(schema, name)
    nodes = [instance(n, values[n['name']]) for n in op['input'] if n['name'] in (values or {})]
    return {'operation': op['id'], 'nodes': nodes}


def test_discovery_and_parameterless(schema):
    assert not schema.tree['roots']
    assert {o['name'] for o in schema.tree['operations']} == {'ping', 'complex', 'clear-lldp-counters'}
    element = build_rpc(schema, intent(schema, name='ping'))
    assert element.tag == '{urn:test:rpc}ping' and len(element) == 0


def test_scalar_presence_and_leafref(schema):
    payload = build_rpc(schema, intent(schema, {'required': '', 'enabled': 'false', 'count': '0', 'flag': None}))
    assert payload.findtext('{urn:test:rpc}enabled') == 'false'
    assert payload.findtext('{urn:test:rpc}count') == '0'
    assert payload.find('{urn:test:rpc}flag') is not None
    assert payload.find('{urn:test:rpc}required') is not None
    payload = build_rpc(schema, intent(schema, {'total-neighbors-stat': 'true', 'interface': 'ETH1/1'}, 'clear-lldp-counters'))
    assert payload.findtext('{urn:test:rpc}interface') == 'ETH1/1'
    assert all(etree.QName(n).namespace == 'urn:test:rpc' for n in payload)


def test_nested_repeating_and_choices(schema):
    op = operation(schema); fields = {n['name']: n for n in op['input']}
    nodes = [instance(fields['required'], 'yes')]
    for i in range(2):
        entry = fields['entries']
        nodes.append(instance(entry, children=[instance(n, str(i), identity=n['path']+str(i)) for n in entry['children']], identity='entry'+str(i)))
        nodes.append(instance(fields['tags'], str(i), identity='tag'+str(i)))
        nodes.append(instance(fields['keyless'], children=[instance(fields['keyless']['children'][0], str(i), identity='text'+str(i))], identity='keyless'+str(i)))
    choice = fields['method']; case = choice['children'][0]
    nodes.append(instance(choice, children=[instance(case, children=[instance(case['children'][0], 'one')])]))
    nested = fields['nested']; nodes.append(instance(nested, children=[instance(nested['children'][0], 'hello')]))
    root = build_rpc(schema, {'operation': op['id'], 'nodes': nodes})
    assert len(root.findall('{urn:test:rpc}entries')) == 2
    assert len(root.findall('{urn:test:rpc}tags')) == 2
    assert root.findtext('{urn:test:rpc}first') == 'one'
    assert root.findtext('{urn:test:rpc}nested/{urn:test:rpc}text') == 'hello'


@pytest.mark.parametrize('values', [{}, {'required': None}, {'required': 'x', 'enabled': 'invalid'}, {'required': 'x', 'count': '-1'}, {'required': 'x', 'mode': 'other'}])
def test_invalid_scalar_and_mandatory(schema, values):
    with pytest.raises(BackendError): build_rpc(schema, intent(schema, values))


def test_output_and_ok(schema):
    payload = build_rpc(schema, intent(schema, {'required': 'x'}))
    raw = '<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><result xmlns="urn:test:rpc"><count>18446744073709551615</count><rows><name>a</name><values>x</values><values>y</values></rows></result></rpc-reply>'
    result = parse_rpc_reply(schema.context, payload, raw)
    assert result[0]['children'][0]['value'] == '18446744073709551615'
    assert len(result[0]['children'][1]['children']) == 3
    assert parse_rpc_reply(schema.context, payload, '<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><ok/></rpc-reply>') == []
    with pytest.raises(Exception): parse_rpc_reply(schema.context, payload, raw.replace('result', 'unexpected'))


def test_feature_and_import_only():
    with create_context(FIXTURES) as ctx:
        ctx.load_module('test-rpc', enabled_features=['advanced']); ctx.compile_schema()
        assert 'featured' in {o['name'] for o in serialize_context(ctx, implemented_names={'test-rpc'})[1]['operations']}
        assert serialize_context(ctx, implemented_names=set())[1]['operations'] == []


def test_augment_namespaces(schema):
    schema.context.load_module('test-rpc-augment'); schema.context.compile_schema()
    schema.tree = serialize_context(schema.context, implemented_names={'test-rpc', 'test-rpc-augment'})[1]
    op = operation(schema)
    extra = next(n for n in op['input'] if n['name'] == 'extra')
    params = intent(schema, {'required': 'x'})
    params['nodes'].append(instance(extra, '<escaped>&'))
    payload = build_rpc(schema, params)
    assert payload[-1].tag == '{urn:test:rpc:augment}extra'
    assert payload[-1].text == '<escaped>&'
    output = parse_rpc_reply(schema.context, payload, '<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><result xmlns="urn:test:rpc"><extra-result xmlns="urn:test:rpc:augment">yes</extra-result></result></rpc-reply>')
    assert output[0]['children'][0]['namespace'] == 'urn:test:rpc:augment'


def test_references_choices_keys_and_cardinality(schema):
    op = operation(schema); fields = {n['name']: n for n in op['input']}
    base = intent(schema, {'required': 'x'})
    invalid_nodes = [
        [dict(instance(fields['required'], 'x'), schemaPath='/forged')],
        [instance(fields['entries'])],
        [instance(fields['present'])],
        [instance(fields['tags'], str(i), identity=str(i)) for i in range(4)],
        [instance(fields['method'], children=[instance(c) for c in fields['method']['children']])],
        [instance(fields['required'], 'duplicate')],
    ]
    for nodes in invalid_nodes:
        with pytest.raises(BackendError): build_rpc(schema, {**base, 'nodes': base['nodes'] + nodes})



def test_imported_type_and_conditional_mandatory(schema):
    assert build_rpc(schema, intent(schema, {'required': 'x', 'enabled': 'false', 'imported-count': '65535'})) is not None
    with pytest.raises(BackendError):
        build_rpc(schema, intent(schema, {'required': 'x', 'imported-count': '65536'}))
    # A missing conditional field is not guessed mandatory without dependency data.
    assert build_rpc(schema, intent(schema, {'required': 'x'})) is not None



def test_real_min_elements_and_duplicate_keys(schema):
    op = operation(schema); fields = {n['name']: n for n in op['input']}
    base = intent(schema, {'required': 'x'})
    bounded = fields['bounded']; value = bounded['children'][0]
    for count in (0, 1, 2, 3, 4):
        branch = instance(bounded, children=[instance(value, str(i), identity=f'value-{i}') for i in range(count)])
        params = {**base, 'nodes': base['nodes'] + [branch]}
        if count in (2, 3):
            build_rpc(schema, params)
        else:
            with pytest.raises(BackendError): build_rpc(schema, params)
    entry = fields['entries']; key = next(n for n in entry['children'] if n['isKey'])
    entries = [instance(entry, children=[instance(key, 'same', identity=f'key-{i}')], identity=f'entry-{i}') for i in range(2)]
    with pytest.raises(BackendError): build_rpc(schema, {**base, 'nodes': base['nodes'] + entries})
