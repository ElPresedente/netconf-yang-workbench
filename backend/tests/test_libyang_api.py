"""Regression coverage for native ownership and the libyang 6.4.13 API."""
from types import SimpleNamespace

import libyang
import pytest
from lxml import etree

from netconf_backend.yang import api
from netconf_backend.yang.data import parse_reply
from netconf_backend.yang.runtime import create_context
from netconf_backend.yang.serializer import serialize_context
from netconf_backend.yang_rpc import build_rpc, parse_rpc_reply
from netconf_backend.protocol.rpc import BackendError

NC = 'urn:ietf:params:xml:ns:netconf:base:1.0'
SOURCE = '''module api-test {
  yang-version 1.1; namespace "urn:api-test"; prefix a;
  revision 2026-11-13;
  container root {
    anydata payload;
    anyxml raw;
    leaf exact { type decimal64 { fraction-digits 18; } }
    leaf empty-value { type empty; }
    leaf-list defaults { type uint64; default 18446744073709551615; default 0; }
  }
  rpc inspect {
    input { leaf count { type uint8; } }
    output { anydata payload; }
  }
}'''


@pytest.fixture
def context():
    with create_context() as ctx:
        ctx.parse_module_str(SOURCE)
        ctx.compile_schema()
        yield ctx


class NativeCalls:
    """Track ownership while still executing the real C allocation and free."""
    def __init__(self, native):
        self.native = native
        self.allocated = []
        self.freed = []

    def __getattr__(self, name):
        return getattr(self.native, name)

    def lyd_any_value_str(self, node, fmt, out):
        ret = self.native.lyd_any_value_str(node, fmt, out)
        if out[0] != api.ffi.NULL:
            self.allocated.append(int(api.ffi.cast('uintptr_t', out[0])))
        return ret

    def free(self, ptr):
        if ptr != api.ffi.NULL:
            self.freed.append(int(api.ffi.cast('uintptr_t', ptr)))
        self.native.free(ptr)


def test_opaque_values_free_each_native_allocation(context, monkeypatch):
    calls = NativeCalls(api.lib)
    monkeypatch.setattr(api, 'lib', calls)
    xml = f'''<rpc-reply xmlns="{NC}"><data><root xmlns="urn:api-test">
      <payload><entry xmlns="urn:vendor"><value>42</value></entry></payload>
      <raw><unknown xmlns="urn:vendor">opaque</unknown></raw>
      <exact>0.123456789012345678</exact><empty-value/>
    </root></data></rpc-reply>'''
    for _ in range(20):
        nodes = parse_reply(context, xml)[0]['children']
        values = {node['name']: node['value'] for node in nodes}
        assert etree.fromstring(values['payload'].encode()).tag == '{urn:vendor}entry'
        assert etree.fromstring(values['raw'].encode()).text == 'opaque'
        assert values['exact'] == '0.123456789012345678'
        assert values['empty-value'] == ''
    assert len(calls.allocated) == 40
    assert calls.freed == calls.allocated


def test_opaque_buffer_freed_when_decoding_raises(context, monkeypatch):
    tree = context.parse_data_mem('<root xmlns="urn:api-test"><raw>text</raw></root>', 'xml', parse_only=True)
    calls = NativeCalls(api.lib)
    monkeypatch.setattr(api, 'lib', calls)
    def fail_decode(_):
        raise UnicodeError('decoding failed')
    monkeypatch.setattr(api, 'c2str', fail_decode)
    try:
        with pytest.raises(UnicodeError):
            api.any_value(next(tree.children()))
        assert len(calls.allocated) == 1
        assert calls.freed == calls.allocated
    finally:
        tree.free()


def test_empty_opaque_values(context):
    xml = f'<rpc-reply xmlns="{NC}"><data><root xmlns="urn:api-test"><payload/><raw/></root></data></rpc-reply>'
    assert [n['value'] for n in parse_reply(context, xml)[0]['children']] == [None, None]


def test_schema_arrays_and_metadata(context):
    modules, tree = serialize_context(context, implemented_names={'api-test'})
    module = next(m for m in modules if m['name'] == 'api-test')
    assert module['namespace'] == 'urn:api-test'
    assert module['revision'] == '2026-11-13'
    defaults = next(n for n in tree['roots'][0]['children'] if n['name'] == 'defaults')
    assert defaults['default'] == ['18446744073709551615', 0]


def test_failed_parses_leave_context_reusable(context):
    schema = SimpleNamespace(context=context, tree=serialize_context(context, implemented_names={'api-test'})[1])
    op = schema.tree['operations'][0]
    path = op['input'][0]['path']
    operation = etree.Element('{urn:api-test}inspect')
    for _ in range(20):
        with pytest.raises(libyang.LibyangError):
            parse_reply(context, f'<rpc-reply xmlns="{NC}"><data><root xmlns="urn:api-test"><exact>invalid</exact></root></data></rpc-reply>')
        with pytest.raises(BackendError):
            build_rpc(schema, {'operation': op['id'], 'nodes': [{'id': 'count', 'schemaPath': path, 'value': '256'}]})
        with pytest.raises(libyang.LibyangError):
            parse_rpc_reply(context, operation, f'<rpc-reply xmlns="{NC}"><unknown xmlns="urn:api-test"/></rpc-reply>')
        build_rpc(schema, {'operation': op['id'], 'nodes': []})
        output = parse_rpc_reply(context, operation, f'<rpc-reply xmlns="{NC}"><payload xmlns="urn:api-test"><value xmlns="urn:vendor">ok</value></payload></rpc-reply>')
        assert 'ok' in output[0]['value']


def test_destroyed_context_rejected_before_native_operation_parse():
    ctx = create_context()
    ctx.destroy()
    ctx.destroy()
    with pytest.raises(ValueError, match='No active schema context'):
        parse_rpc_reply(ctx, etree.Element('{urn:api-test}inspect'), f'<rpc-reply xmlns="{NC}"><ok/></rpc-reply>')
    with pytest.raises(ValueError, match='No active schema context'):
        parse_reply(ctx, f'<rpc-reply xmlns="{NC}"><data/></rpc-reply>')
    with pytest.raises(BackendError, match='Load YANG models first'):
        build_rpc(SimpleNamespace(context=ctx), {})
