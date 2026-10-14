"""Top-level operation intent and libyang operation parsing, independent of datastores."""
import libyang
from lxml import etree
from .protocol.rpc import BackendError
from .yang.data import serialize_data, NC

VALIDATION = 'Local structure and scalar types checked with libyang. Datastore-dependent leafrefs, must/when and final validation are the server’s responsibility.'


def invalid(message):
    raise BackendError('invalid_rpc_input', message)


def build_rpc(schema, intent):
    if schema.context is None:
        invalid('Load YANG models first')
    if not isinstance(intent, dict) or set(intent) - {'operation', 'nodes'}:
        invalid('Expected structured RPC input')
    operation = next((o for o in schema.tree.get('operations', []) if o['id'] == intent.get('operation')), None)
    if operation is None:
        invalid('Unknown compiled RPC operation')
    root = etree.Element(etree.QName(operation['namespace'], operation['name']), nsmap={None: operation['namespace']})
    ids = set()

    def emit(parent, definitions, instances):
        if not isinstance(instances, list):
            invalid('Input children must be an array')
        known = {n['path']: n for n in definitions}
        grouped = {}
        for item in instances:
            if not isinstance(item, dict) or set(item) - {'id', 'schemaPath', 'value', 'children'}:
                invalid('Invalid input instance')
            identity = item.get('id')
            if not isinstance(identity, str) or not identity or identity in ids:
                invalid('Each input occurrence needs a unique identity')
            ids.add(identity)
            path = item.get('schemaPath')
            if path not in known:
                invalid('Input node does not belong to this operation/parent')
            grouped.setdefault(path, []).append(item)
        for node in definitions:
            items = grouped.get(node['path'], [])
            kind = node['kind']
            minimum = node.get('minElements', 0)
            if (node['mandatory'] or node.get('isKey')) and not node.get('conditional') and not items:
                invalid(f"Required input: {node['path']}")
            if (len(items) < minimum and not node.get('conditional')) or (node.get('maxElements') is not None and len(items) > node['maxElements']):
                invalid(f"Input cardinality: {node['path']}")
            if kind not in ('list', 'leaf-list') and len(items) > 1:
                invalid(f"Duplicate input: {node['path']}")
            if kind == 'container' and not node['presence'] and not node.get('conditional') and not items:
                # Non-presence containers cannot hide mandatory descendants.
                emit(etree.Element('validation-only'), node['children'], [])
            for item in items:
                if kind in ('choice', 'case'):
                    children = item.get('children', [])
                    if kind == 'choice' and len(children) != 1:
                        invalid('Select exactly one choice case')
                    if item.get('value') is not None:
                        invalid('Choice/case cannot have a scalar value')
                    emit(parent, node['children'], children)
                    continue
                if kind not in ('container', 'list', 'leaf', 'leaf-list'):
                    invalid(f'Unsupported RPC input structure: {kind}')
                element = etree.SubElement(parent, etree.QName(node['namespace'], node['name']))
                if kind in ('leaf', 'leaf-list'):
                    if item.get('children'):
                        invalid('Scalar input cannot have children')
                    value = item.get('value')
                    if node['type'] == 'empty':
                        if value is not None:
                            invalid('YANG empty uses inclusion, not a scalar value')
                    elif not isinstance(value, str):
                        invalid(f"Enter a textual value for {node['path']}")
                    else:
                        element.text = value
                else:
                    if item.get('value') is not None:
                        invalid('Structural input cannot have a scalar value')
                    emit(element, node['children'], item.get('children', []))
    emit(root, operation['input'], intent.get('nodes', []))
    # RPC_YANG parses operation input, including real scalar constraints, without
    # lyd_validate_op's datastore-dependent leafref/must/when validation.
    tree = None
    try:
        tree = schema.context.parse_op_mem('xml', etree.tostring(root, encoding='unicode'), dtype=libyang.DataType.RPC_YANG, strict=True)
        def check_instances(parent):
            seen = set()
            for child in parent.children():
                definition = child.schema()
                if isinstance(definition, libyang.SList) and list(definition.keys()):
                    # Libyang supplies canonical key values in instance paths;
                    # parse_op alone does not enforce sibling key uniqueness.
                    identity = child.path()
                    if identity in seen:
                        invalid('Duplicate keyed RPC list instance')
                    seen.add(identity)
                if isinstance(child, libyang.DContainer):
                    check_instances(child)
        if tree is not None:
            check_instances(tree)
    except BackendError:
        raise
    except Exception as exc:
        invalid(f'libyang RPC input parsing failed: {exc}')
    finally:
        if tree is not None:
            tree.free()
    return root


def parse_rpc_reply(context, operation, raw_xml):
    """REPLY_YANG uses the operation element as context, never a data wrapper."""
    reply = etree.fromstring(raw_xml.encode(), etree.XMLParser(resolve_entities=False, no_network=True))
    children = [c for c in reply if isinstance(c.tag, str)]
    if len(children) == 1 and children[0].tag == f'{{{NC}}}ok':
        return []
    payload = etree.Element(operation.tag, nsmap=operation.nsmap)
    for child in children:
        payload.append(child)
    tree = context.parse_op_mem('xml', etree.tostring(payload, encoding='unicode'), dtype=libyang.DataType.REPLY_YANG, strict=True)
    if tree is None:
        return []
    try:
        return [serialize_data(child) for child in tree.children()]
    finally:
        tree.free()
