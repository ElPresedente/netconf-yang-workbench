import json
from pathlib import Path
from unittest.mock import Mock
import pytest
from netconf_backend.yang.runtime import create_context
from netconf_backend.yang.data import parse_reply
from netconf_backend.yang.serializer import serialize_context
from netconf_backend.main import Backend

FIXTURES = Path(__file__).parent / 'fixtures' / 'yang'
NC = 'urn:ietf:params:xml:ns:netconf:base:1.0'


def reply(payload):
    return f'<rpc-reply xmlns="{NC}" message-id="1"><data>{payload}</data></rpc-reply>'


@pytest.fixture
def context():
    with create_context(FIXTURES) as ctx:
        ctx.load_module('test-system')
        ctx.load_module('test-augment')
        ctx.parse_module_str('''module runtime-extra {
          yang-version 1.1; namespace "urn:runtime:extra"; prefix re;
          list route { key "vrf prefix"; leaf vrf { type string; } leaf prefix { type string; } }
        }''')
        ctx.compile_schema()
        yield ctx


def test_real_partial_runtime_data(context):
    xml = reply('''<system xmlns="urn:test:system"><hostname>NPB</hostname>
      <enabled>false</enabled><dns>a</dns><dns>b</dns>
      <interface><name>eth0</name><statistics>18446744073709551615</statistics>
        <description xmlns="urn:test:augment">uplink</description></interface>
      <interface><name>eth1</name></interface></system>
      <route xmlns="urn:runtime:extra"><vrf>main</vrf><prefix>10.0.0.0/24</prefix></route>''')
    nodes = parse_reply(context, xml)
    assert json.loads(json.dumps(nodes)) == nodes
    system = next(n for n in nodes if n['name'] == 'system')
    route = next(n for n in nodes if n['name'] == 'route')
    assert system['kind'] == 'container'
    assert system['schemaPath'] == '/test-system:system'
    assert [n['name'] for n in system['children']] == ['enabled', 'hostname', 'dns', 'dns', 'interface', 'interface']
    assert system['children'][1]['value'] == 'NPB'
    assert system['children'][0]['value'] == 'false'
    dns = system['children'][2:4]
    assert [n['value'] for n in dns] == ['a', 'b']
    assert dns[0]['id'] != dns[1]['id']
    interface = system['children'][4]
    assert interface['keyValues'] == {'name': 'eth0'}
    assert interface['instancePath'] == "/test-system:system/interface[name='eth0']"
    assert interface['schemaPath'] == '/test-system:system/interface'
    stats, augmented = interface['children'][1:]
    assert stats['value'] == '18446744073709551615' and stats['config'] is False
    assert augmented['namespace'] == 'urn:test:augment'
    assert augmented['schemaPath'] == '/test-system:system/interface/test-augment:description'
    assert list(route['keyValues']) == ['vrf', 'prefix']
    assert route['instancePath'] == "/runtime-extra:route[vrf='main'][prefix='10.0.0.0/24']"
    assert parse_reply(context, xml) == nodes
    # Neither mandatory hostname nor default enabled is synthesized for a partial subtree.
    partial = parse_reply(context, reply('<system xmlns="urn:test:system"><dns>a</dns></system>'))
    assert [n['name'] for n in partial[0]['children']] == ['dns']
    assert parse_reply(context, reply('')) == []


def test_dispatch_parse_failure_preserves_request_success_and_raw_reply(context):
    schema = Mock(context=context)
    schema.modules, schema.tree = serialize_context(context)
    session = Mock()
    session.info.return_value = {'capabilities': []}
    raw = reply('<unknown xmlns="urn:missing"/>')
    session.execute_request.return_value = {'rawXml': raw, 'xml': raw, 'errors': []}
    backend = Backend(lambda *args: None, session=session, schema=schema)
    intent = {'operation': 'get', 'datastore': None, 'selectedPaths': ['/test-system:system'], 'listKeyValues': {}}
    result = backend.dispatch('request.execute', intent)
    assert result['rawXml'] == raw and result['errors'] == []
    assert 'parseWarning' in result and 'dataNodes' not in result
    session.log.assert_called_once()
    raw = reply('<system xmlns="urn:test:system"><hostname>ok</hostname></system>')
    session.execute_request.return_value = {'rawXml': raw, 'xml': raw, 'errors': []}
    assert backend.dispatch('request.execute', intent)['dataNodes'][0]['children'][0]['value'] == 'ok'
    session.execute_request.return_value = {'rawXml': '<rpc-error/>', 'xml': '<rpc-error/>', 'errors': [{'error-tag': 'operation-failed'}]}
    assert 'dataNodes' not in backend.dispatch('request.execute', intent)
