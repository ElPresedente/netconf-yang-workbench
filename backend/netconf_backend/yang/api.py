"""CFFI access not covered by libyang-python 5.0.0's public wrappers.

libyang 6.4.13 uses SO ABI 5, supported by that binding. Keep borrowed
strings separate from allocated strings: only lyd_any_value_str transfers
ownership to us. See docs/libyang-audit.md for the checked API surface.
"""
from _libyang import ffi, lib
from libyang.util import c2str


def namespace(module):
    return c2str(module.cdata.ns)


def revision(module):
    return c2str(module.cdata.revision)


def canonical_value(node):
    # Borrowed canonical text; DLeaf.value() converts decimal64 to float.
    return c2str(lib.lyd_get_value(node.cdata))


def any_value(node):
    # DAnydata/DAnyxml.value() in binding 5.0.0 omits free() on this buffer.
    # Since libyang 5 the format argument is required even for XML input.
    value = ffi.new("char **", ffi.NULL)
    try:
        ret = lib.lyd_any_value_str(node.cdata, lib.LYD_XML, value)
        if ret != lib.LY_SUCCESS:
            raise node.context.error("cannot get anydata/anyxml value")
        return c2str(value[0])
    finally:
        lib.free(value[0])


def require_context(context):
    # parse_op_mem() in binding 5.0.0 does not check destroyed contexts.
    if context is None or context.cdata is None:
        raise ValueError("No active schema context")
