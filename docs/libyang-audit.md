# Libyang API audit

Target: native libyang **6.4.13**, libyang-python **5.0.0**, Linux.
The native release uses SO version **5.11.11** (`libyang.so.5`); the
project version 6 does not imply SO ABI 6. Keep the binding pinned to 5.0.0.
The AppImage Dockerfile builds the target native release and compiles the
binding against its headers.

The clean native build exposed a header compatibility issue: binding 5.0.0
calls `lyplg_add_extension_plugin`, but does not explicitly include
`libyang/plugins.h`, where libyang 6 declares it. Build the binding with
`LIBYANG_EXTRA_CFLAGS='-D_GNU_SOURCE -include libyang/plugins.h'`. The Dockerfile applies
this to pip; do the same for development installs. This supplies the correct
declaration without disabling compiler errors or changing the plugin ABI.
`-D_GNU_SOURCE` preserves the libc feature declarations when this header is
included before Python's usual feature-macro setup.

Sources: [release CMake version definitions](https://github.com/CESNET/libyang/blob/v6.4.13/CMakeLists.txt),
[native public headers](https://github.com/CESNET/libyang/tree/v6.4.13/src),
[pinned Python binding](https://github.com/CESNET/libyang-python/tree/v5.0.0),
[anydata implementation](https://github.com/CESNET/libyang/blob/v6.4.13/src/tree_data_common.c).

## Application calls checked

| Location / API | Contract and result |
| --- | --- |
| `runtime.create_context`: `Context(search_path, explicit_compile=True, disable_searchdir_cwd=True)` | Supported. Standard models remain necessary; use matching installed modules or `NETCONF_LIBYANG_MODULES`. |
| `context.SchemaContext`: `external_module_loader.set_module_data_clb` | Callback takes module/revision/submodule/subrevision and returns `(format, source)` or `None`. The binding retains CFFI source buffers until the native free callback. Removed after compilation; context destruction handles failed compilation. |
| `load_module(..., enabled_features=...)`, `compile_schema()` | Supported. Explicit compilation loads implemented inventory modules/features before serialization. Imported modules do not become device roots unless implemented in inventory. |
| Context iteration, `Module.name()`, `implemented()`, `children(types=...)` | Supported. RPC enumeration uses `SNode.RPC`; data roots use explicit data kinds. |
| Module `cdata.ns`, `cdata.revision` | Borrowed strings, copied before context destruction; isolated in `yang/api.py`. No namespace wrapper exists in binding 5.0.0. |
| `SNode.schema_path()`, `name()`, `module()`, `keyword()`, `config_false()`, `mandatory()`, `description()` | Supported. Paths are copied to DTOs; no native node references escape serialization. |
| `SContainer.presence()`, `SList.keys()`, `SLeaf.is_key()` | Supported with the binding's parsed-node context option. Preserve key order and augment namespaces. |
| Leaf/leaf-list `type().basename()`, `units()`, `default()` / `defaults()` | Supported. Large integer defaults remain strings at the JSON boundary. Sized arrays still use a uint64 count before the array; the new public `LYA_*` macros do not require changing binding iteration. |
| RPC `input()` / `output()`, node `children(with_choice=True)` / choice `children(with_case=True)` | Supported. Choice/case relationships and schema order retained for operation forms. |
| `when_conditions()`, `obsolete()`, `deprecated()`, `min_elements()`, `max_elements()`, `type().enums()` | Supported. Existing RPC tests exercise conditionals, features, enums and cardinalities. |
| `parse_data_mem(payload, 'xml', parse_only=True, strict=True)` | Supported for partial NETCONF replies; avoids datastore validation/default insertion and rejects unknown schema nodes. |
| `parse_op_mem('xml', payload, dtype=RPC_YANG/REPLY_YANG, strict=True)` | Supported. Reply payload is wrapped in the operation element. Check context lifetime first: the pinned binding does not guard a destroyed context in this API. |
| `DNode.schema()`, `children()`, `siblings()`, `path()` | Supported. Serialize while the data tree and schema context are alive. |
| `lyd_get_value(node)` | Borrowed canonical string; copy without freeing. Avoid `DLeaf.value()` float conversion for decimal64 and preserve uint64 precision. |
| `DAnydata.value()` / `DAnyxml.value()` | Replaced: the binding omits freeing the returned C buffer. Use `lyd_any_value_str(node, LYD_XML, out)` and `free(out[0])` in `finally`, including conversion failures. Both tree and text forms allocate a new string. |
| `DNode.free()` | Supported; called in `finally` after successful parsing, including serialization/validation failures. Frees the full returned tree and siblings. |
| `Context.destroy()`, `cdata` lifetime check | Supported; repeated destruction is safe. Schema replacement remains transactional; context outlives all temporary data trees. |

## Verification

Run `npm run test:backend`. It exercises real native schema compilation,
imports, features, deviations, augments, data parsing, RPCs and loopback
NETCONF sessions. `test_libyang_api.py` adds native allocation/free tracking
for anydata and anyxml, empty values, conversion failure cleanup, exact
decimal64 text, leaf-list defaults, destroyed-context guards and repeated
invalid/valid parses using one context.

A separate-process stress check on the host library parsed 5,000 replies with
a 4 KiB anydata payload after warm-up: the old binding wrapper increased peak
RSS by 24,960 KiB; the corrected path increased it by 0 KiB. This is an observed
comparison, not a portable RSS threshold. The regression tests assert actual
native allocation/free pairs instead. Valgrind could not start on this host
because the loader's required debug symbols were unavailable.

Run `docker build -f packaging/Dockerfile -t netconf-appimage-builder:0.1.0 .`
to verify a clean binding build and frozen-backend self-test against the target
release. Native Windows and macOS have not been verified.

Verified locally: 165 backend tests on Python 3.14 / native 6.4.13, 26
application tests, and a clean Docker build with Python 3.12 / native 6.4.13.
The frozen-backend self-test covers standard-model imports, schema metadata,
retrieval data, anydata and RPC input/output with exact uint64 values.
