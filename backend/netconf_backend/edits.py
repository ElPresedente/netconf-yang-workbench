"""Pure, concrete-instance edit construction against the active libyang snapshot."""
from lxml import etree
from .requests import BASE, invalid
from .protocol.rpc import BackendError

CAP = 'urn:ietf:params:netconf:capability:'
OPERATIONS = ('merge', 'replace', 'create', 'delete', 'remove')


def edit_capabilities(capabilities):
    caps = {c.split('?', 1)[0] for c in capabilities}
    version = '1.1' if CAP + 'validate:1.1' in caps else '1.0' if CAP + 'validate:1.0' in caps else None
    return dict(editableTargets=[d for d, c in [('candidate', 'candidate'), ('running', 'writable-running')] if CAP + c + ':1.0' in caps],
                supportsRollbackOnError=CAP + 'rollback-on-error:1.0' in caps,
                validateVersion=version,
                supportedTestOptions=(['test-then-set', 'set'] + (['test-only'] if version == '1.1' else [])) if version else [])


def build_edit(schema, params, capabilities):
    if not schema.context:
        invalid('Load YANG models first')
    if not isinstance(params, dict) or set(params) - {'target', 'defaultOperation', 'testOption', 'errorOption', 'changes'}:
        invalid('Unsupported edit parameter')
    caps = edit_capabilities(capabilities)
    if params.get('target') not in caps['editableTargets']:
        invalid('Target requires :candidate or :writable-running; startup is not editable')
    default = params.get('defaultOperation')
    if default not in (None, 'merge', 'replace', 'none'):
        invalid('Invalid default-operation')
    if params.get('testOption') is not None and params['testOption'] not in caps['supportedTestOptions']:
        invalid('Unsupported test-option for advertised validate version')
    errors = [None, 'stop-on-error', 'continue-on-error'] + (['rollback-on-error'] if caps['supportsRollbackOnError'] else [])
    if params.get('errorOption') not in errors:
        invalid('Unsupported error-option')
    changes = params.get('changes')
    if not isinstance(changes, list) or not changes:
        invalid('Stage at least one change')
    nodes, chains = {}, {}
    def index(node, chain):
        nodes[node['path']] = node
        chains[node['path']] = [*chain, node]
        for child in node['children']:
            index(child, chains[node['path']])
    for root in schema.tree['roots']:
        index(root, [])
    validated = []
    for change in changes:
        if not isinstance(change, dict) or set(change) - {'id', 'schemaPath', 'operation', 'ancestorKeys', 'value', 'source', 'type', 'instancePath', 'currentValue'}:
            invalid('Unsupported edit change field')
        for field in ('id', 'type', 'instancePath', 'currentValue'):
            if change.get(field) is not None and not isinstance(change[field], str):
                invalid(f'{field} must be text')
        if change.get('source') not in (None, 'schema', 'runtime'):
            invalid('Invalid edit source')
        path = change.get('schemaPath')
        if not isinstance(path, str) or path not in nodes:
            invalid('Unknown/stale edit schema path')
        node = nodes[path]
        chain = chains[path]
        if any(not n['config'] for n in chain):
            invalid('State data is read-only')
        if node['kind'] not in ('leaf', 'container', 'list'):
            invalid('Leaf-list, anydata and anyxml editing is not supported')
        if node['isKey']:
            invalid('List keys identify instances; create a new list and delete/remove the old instance')
        operation = change.get('operation')
        if operation not in OPERATIONS:
            invalid('Invalid per-node operation')
        if operation in ('delete', 'remove') and default != 'none':
            invalid('Delete/remove requires default-operation none to avoid creating ancestors')
        if default == 'replace' and len(chain) > 1:
            invalid('Default-operation replace is unsafe with implicit ancestor scaffolding; use none or merge')
        supplied = change.get('ancestorKeys', [])
        if not isinstance(supplied, list):
            invalid('ancestorKeys must be an array')
        keys = {}
        for entry in supplied:
            if not isinstance(entry, dict) or set(entry) != {'listSchemaPath', 'values'} or not isinstance(entry['listSchemaPath'], str):
                invalid('Invalid list instance context')
            lp = entry['listSchemaPath']
            if lp in keys:
                invalid('Duplicate list context')
            keys[lp] = entry['values']
        lists = [n for n in chain if n['kind'] == 'list']
        if set(keys) != {n['path'] for n in lists}:
            invalid('Supply keys for every list on the target path, including the target list')
        identity = []
        for n in chain:
            values = keys.get(n['path'], {})
            if n['kind'] == 'list':
                if not n['keys'] or not isinstance(values, dict) or set(values) != set(n['keys']) or any(not isinstance(v, str) for v in values.values()):
                    invalid('Supply every schema key as text; keyless lists cannot be edited')
            identity.append((n['path'], tuple((k, values[k]) for k in n['keys'])))
        value = change.get('value')
        if node['kind'] == 'leaf' and operation not in ('delete', 'remove') and node['type'] != 'empty':
            if not isinstance(value, str):
                invalid('A scalar value must be text (including large numeric values)')
        elif value is not None:
            invalid('This operation/node requires no scalar value')
        validated.append((tuple(identity), chain, keys, operation, value))
    for i, (identity, _, _, operation, value) in enumerate(validated):
        for other, _, _, other_op, other_value in validated[:i]:
            overlap = identity[:len(other)] == other or other[:len(identity)] == identity
            if not overlap:
                continue
            if identity == other or (operation if len(identity) < len(other) else other_op) in ('delete', 'remove', 'replace'):
                raise BackendError('edit_conflict', f'Conflicting changes at {identity[-1][0]}: duplicate instance or overlapping destructive subtree', str(identity))
    payload = etree.Element(f'{{{BASE}}}edit-config', nsmap={None: BASE, 'nc': BASE})
    target = etree.SubElement(payload, f'{{{BASE}}}target')
    etree.SubElement(target, f"{{{BASE}}}{params['target']}")
    for field, tag in [('defaultOperation', 'default-operation'), ('testOption', 'test-option'), ('errorOption', 'error-option')]:
        if params.get(field) is not None:
            etree.SubElement(payload, f'{{{BASE}}}{tag}').text = params[field]
    config = etree.SubElement(payload, f'{{{BASE}}}config')
    elements = {}
    try:
        for identity, chain, keys, operation, value in validated:
            parent = config
            for depth, node in enumerate(chain):
                concrete = identity[:depth + 1]
                if concrete not in elements:
                    el = etree.SubElement(parent, f"{{{node['namespace']}}}{node['name']}", nsmap={None: node['namespace']})
                    elements[concrete] = el
                    for key in node['keys']:
                        kn = next(c for c in node['children'] if c['isKey'] and c['name'] == key)
                        etree.SubElement(el, f"{{{kn['namespace']}}}{kn['name']}", nsmap={None: kn['namespace']}).text = keys[node['path']][key]
                parent = elements[concrete]
            parent.set(f'{{{BASE}}}operation', operation)
            parent.text = value
    except (ValueError, TypeError):
        invalid('Edit value contains invalid XML characters')
    return payload, config
