"""Pure request construction from the existing compiled SchemaNode snapshot."""
from typing import Literal
from ncclient.capabilities import Capability
from lxml import etree
from .protocol.rpc import BackendError

BASE = 'urn:ietf:params:xml:ns:netconf:base:1.0'
WITH_DEFAULTS_CAP = 'urn:ietf:params:netconf:capability:with-defaults:1.0'
WITH_DEFAULTS_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults'
WithDefaultsMode = Literal['report-all', 'trim', 'explicit', 'report-all-tagged']
WITH_DEFAULTS_MODES = ('report-all', 'trim', 'explicit', 'report-all-tagged')


def supported_with_defaults(capabilities) -> list[WithDefaultsMode] | None:
    for uri in capabilities:
        if uri.split('?', 1)[0] == WITH_DEFAULTS_CAP:
            params = Capability.from_uri(uri).parameters
            basic = params.get('basic-mode')
            if basic not in WITH_DEFAULTS_MODES:
                return []
            return list(dict.fromkeys(mode for mode in
                [basic, *params.get('also-supported', '').split(',')]
                if mode in WITH_DEFAULTS_MODES))
    return None


KINDS = {'container', 'list', 'leaf', 'leaf-list'}


def datastores(capabilities):
    caps = {c.split('?', 1)[0] for c in capabilities}
    return ['running'] + [d for d in ('candidate', 'startup')
        if f'urn:ietf:params:netconf:capability:{d}:1.0' in caps]


def invalid(message):
    raise BackendError('invalid_request', message)


def build_request(schema, params, capabilities):
    if not schema.context:
        invalid('Load YANG models first')
    if not isinstance(params, dict) or set(params) - {'operation', 'datastore', 'selectedPaths', 'listKeyValues', 'withDefaults'}:
        invalid('Unsupported request parameter')
    operation = params.get('operation')
    if operation not in ('get', 'get-config'):
        invalid('Choose get or get-config')
    datastore = params.get('datastore')
    if operation == 'get' and datastore is not None:
        invalid('GET does not accept a datastore')
    if operation == 'get-config' and datastore not in datastores(capabilities):
        invalid('Unsupported source datastore')
    with_defaults = params.get('withDefaults')
    if with_defaults is not None:
        if not isinstance(with_defaults, str) or with_defaults not in WITH_DEFAULTS_MODES:
            invalid('Unknown with-defaults mode')
        modes = supported_with_defaults(capabilities)
        if modes is None or with_defaults not in modes:
            invalid('Unsupported with-defaults mode for this server')
    paths = params.get('selectedPaths')
    values = params.get('listKeyValues', {})
    if not isinstance(paths, list) or not paths or any(not isinstance(p, str) for p in paths):
        invalid('Select at least one data node')
    if not isinstance(values, dict):
        invalid('listKeyValues must be an object')
    nodes, parents = {}, {}
    def index(node, parent=None):
        nodes[node['path']] = node
        parents[node['path']] = parent
        for child in node['children']:
            index(child, node['path'])
    for root in schema.tree['roots']:
        index(root)
    selected = set(paths)
    relevant = set()
    for path in selected:
        if path not in nodes or nodes[path]['kind'] not in KINDS:
            invalid(f'Unknown/stale or unsupported schema path: {path}')
        if operation == 'get-config' and not nodes[path]['config']:
            invalid('GET-CONFIG cannot select state data; use GET')
        while path is not None:
            relevant.add(path)
            path = parents[path]
    # A selected subtree also makes its descendant lists relevant to key matching.
    def below_selected(path):
        while path is not None:
            if path in selected:
                return True
            path = parents[path]
        return False
    matches = {}
    constrained_paths = set()
    for path, keys in values.items():
        if path not in nodes or nodes[path]['kind'] != 'list' or not (path in relevant or below_selected(path)):
            invalid(f'Unknown/stale or irrelevant list path: {path}')
        if not isinstance(keys, dict) or set(keys) - set(nodes[path]['keys']) or any(not isinstance(v, str) for v in keys.values()):
            invalid('Invalid list key values')
        matches[path] = {k: v for k, v in keys.items() if v != ''}
        if matches[path]:
            current = path
            while current is not None:
                relevant.add(current)
                constrained_paths.add(current)
                current = parents[current]
    payload = etree.Element(f'{{{BASE}}}{operation}', nsmap={None: BASE})
    if operation == 'get-config':
        source = etree.SubElement(payload, f'{{{BASE}}}source')
        etree.SubElement(source, f'{{{BASE}}}{datastore}')
    filter_node = etree.SubElement(payload, f'{{{BASE}}}filter', type='subtree')
    def emit(node, parent, entire=False):
        path = node['path']
        element = etree.SubElement(parent, f"{{{node['namespace']}}}{node['name']}", nsmap={None: node['namespace']})
        full = entire or path in selected
        keys = matches.get(path, {})
        children = node['children']
        # If a full subtree has constraints below it, expand its data children so
        # content matches do not accidentally narrow the requested output fields.
        constrained = path in constrained_paths
        if full and not constrained:
            return
        ordered = [next(c for c in children if c['name'] == k and c['isKey']) for k in node['keys']]
        ordered += [c for c in children if c not in ordered]
        for child in ordered:
            if child['isKey'] and child['name'] in keys:
                item = etree.SubElement(element, f"{{{child['namespace']}}}{child['name']}", nsmap={None: child['namespace']})
                try:
                    item.text = keys[child['name']]
                except ValueError:
                    invalid('Key value contains invalid XML characters')
            elif child['path'] in relevant or (full and (operation == 'get' or child['config'])):
                emit(child, element, full)
    for root in schema.tree['roots']:
        if root['path'] in relevant:
            emit(root, filter_node)
    if with_defaults is not None:
        etree.SubElement(payload, f'{{{WITH_DEFAULTS_NS}}}with-defaults',
                         nsmap={None: WITH_DEFAULTS_NS}).text = with_defaults
    return payload, filter_node


def display_xml(element):
    return etree.tostring(element, encoding='unicode', pretty_print=True)
