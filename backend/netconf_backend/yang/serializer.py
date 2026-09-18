"""JSON DTOs from libyang's compiled schema, never its parsed source AST."""
import libyang
from libyang.util import c2str

DATA_TYPES = (libyang.SNode.CONTAINER, libyang.SNode.LIST, libyang.SNode.LEAF,
              libyang.SNode.LEAFLIST, libyang.SNode.ANYDATA, libyang.SNode.ANYXML)


def namespace(module):
    # libyang-python 5.0.0 has no Module.namespace() wrapper. Isolate its
    # documented CFFI struct access here; ns is the defining module namespace.
    return c2str(module.cdata.ns)


def serialize_node(node):
    module = node.module()
    path = node.schema_path()
    children = node.children(types=DATA_TYPES) if hasattr(node, "children") else ()
    result = {"id": path, "name": node.name(), "module": module.name(),
              "namespace": namespace(module), "path": path,
              "kind": node.keyword(), "config": not node.config_false(),
              "mandatory": node.mandatory(), "description": node.description(),
              "presence": isinstance(node, libyang.SContainer) and node.presence() is not None,
              "keys": [key.name() for key in node.keys()] if isinstance(node, libyang.SList) else [],
              "isKey": isinstance(node, libyang.SLeaf) and node.is_key(),
              "type": node.type().basename() if isinstance(node, (libyang.SLeaf, libyang.SLeafList)) else None,
              "units": node.units() if isinstance(node, (libyang.SLeaf, libyang.SLeafList)) else None,
              "default": None, "children": [serialize_node(c) for c in children]}
    if isinstance(node, libyang.SLeaf):
        value = node.default()
        # Keep large integers exact across the JSON/JavaScript boundary.
        result["default"] = str(value) if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 2**53 - 1 else value
    elif isinstance(node, libyang.SLeafList):
        result["default"] = [str(v) if isinstance(v, int) and not isinstance(v, bool) and abs(v) > 2**53 - 1 else v for v in node.defaults()]
    return result


def serialize_context(context, *, implemented_names=None, loaded_names=None):
    modules, roots = [], []
    for module in context:
        # libyang loads internal implemented modules even when the server does
        # not advertise them. They must not become device data-tree roots.
        if loaded_names is not None:
            if module.name() in loaded_names:
                modules.append({"name": module.name(), "revision": c2str(module.cdata.revision), "namespace": namespace(module)})
        elif module.implemented():
            modules.append({"name": module.name(), "revision": c2str(module.cdata.revision), "namespace": namespace(module)})
        if module.implemented() and (implemented_names is None or module.name() in implemented_names):
            roots.extend(serialize_node(node) for node in module.children(types=DATA_TYPES))
    return sorted(modules, key=lambda m: m["name"]), {"roots": roots}
