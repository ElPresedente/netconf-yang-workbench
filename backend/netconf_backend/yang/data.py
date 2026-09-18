"""Runtime DTOs from the active libyang context; XML handling only unwraps NETCONF."""
import libyang
from _libyang import lib
from libyang.util import c2str
from lxml import etree
from .serializer import namespace

NC = 'urn:ietf:params:xml:ns:netconf:base:1.0'


def serialize_data(node):
    schema = node.schema()
    children = list(node.children()) if isinstance(node, libyang.DContainer) else []
    value = None
    if isinstance(node, (libyang.DLeaf, libyang.DLeafList)):
        # libyang canonical text preserves uint64/decimal64 precision in JSON.
        value = c2str(lib.lyd_get_value(node.cdata))
    elif isinstance(node, (libyang.DAnydata, libyang.DAnyxml)):
        value = node.value()
    keys = {}
    if isinstance(schema, libyang.SList):
        for key in schema.keys():
            for child in children:
                if child.schema().schema_path() == key.schema_path():
                    keys[key.name()] = c2str(lib.lyd_get_value(child.cdata))
    return {'id': node.path(), 'name': schema.name(), 'module': schema.module().name(),
            'namespace': namespace(schema.module()), 'schemaPath': schema.schema_path(),
            'instancePath': node.path(), 'kind': schema.keyword(), 'value': value,
            'keyValues': keys, 'config': not schema.config_false(),
            'children': [serialize_data(child) for child in children]}


def parse_reply(context, raw_xml):
    if context is None:
        raise ValueError('No active schema context')
    root = etree.fromstring(raw_xml.encode(), etree.XMLParser(resolve_entities=False, no_network=True))
    data = root.find(f'{{{NC}}}data')
    if data is None:
        raise ValueError('Reply has no NETCONF data element')
    payload = ''.join(etree.tostring(child, encoding='unicode', with_tail=False) for child in data if isinstance(child.tag, str))
    if not payload:
        return []
    # Partial retrievals are not complete datastores: no validation/default insertion.
    # Strict rejects unknown schema nodes instead of silently discarding device data.
    tree = context.parse_data_mem(payload, 'xml', parse_only=True, strict=True)
    if tree is None:
        return []
    try:
        return [serialize_data(node) for node in tree.siblings()]
    finally:
        tree.free()
