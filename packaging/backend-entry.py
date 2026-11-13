"""Executable entry point, with paths relative to the frozen runtime."""
import json
import os
import sys
from importlib.metadata import version
from pathlib import Path

if getattr(sys, "frozen", False):
    os.environ.setdefault("NETCONF_LIBYANG_MODULES", str(Path(sys._MEIPASS) / "yang"))

if "--self-test" in sys.argv:
    import libyang
    import ncclient
    import paramiko
    from netconf_backend.yang.runtime import create_context
    from netconf_backend.yang.serializer import serialize_context
    from netconf_backend.yang.data import parse_reply
    from netconf_backend.yang_rpc import build_rpc, parse_rpc_reply
    from types import SimpleNamespace

    # Exercise the actual bundled shared library, standard modules and data parser.
    with create_context() as context:
        context.parse_module_str('''module bundle-test {
          yang-version 1.1; namespace "urn:bundle-test"; prefix t;
          import ietf-inet-types { prefix inet; }
          leaf address { type inet:ipv4-address; }
          anydata payload;
          rpc inspect { output { leaf result { type uint64; } } }
        }''')
        context.compile_schema()
        modules, tree = serialize_context(context, implemented_names={'bundle-test'})
        assert any(m['namespace'] == 'urn:bundle-test' for m in modules)
        nodes = parse_reply(context, '''<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><data>
          <address xmlns="urn:bundle-test">192.0.2.1</address>
          <payload xmlns="urn:bundle-test"><opaque xmlns="urn:vendor">ok</opaque></payload>
        </data></rpc-reply>''')
        assert nodes[0]['value'] == '192.0.2.1'
        assert 'ok' in nodes[1]['value']
        schema = SimpleNamespace(context=context, tree=tree)
        operation = build_rpc(schema, {'operation': tree['operations'][0]['id'], 'nodes': []})
        output = parse_rpc_reply(context, operation, '''<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <result xmlns="urn:bundle-test">18446744073709551615</result></rpc-reply>''')
        assert output[0]['value'] == '18446744073709551615'
    if getattr(sys, "frozen", False):
        maps = Path('/proc/self/maps').read_text()
        assert any(str(Path(sys._MEIPASS) / 'libyang.so') in line for line in maps.splitlines()), 'libyang must load from the bundle'
    print(json.dumps({"ok": True, "python": sys.version.split()[0],
                      "libyang_python": version('libyang'), "ncclient": ncclient.__version__,
                      "paramiko": paramiko.__version__}))
else:
    from netconf_backend.main import main
    main()
