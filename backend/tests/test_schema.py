import json
from pathlib import Path
from unittest.mock import Mock
import libyang
import pytest
from netconf_backend.yang.serializer import serialize_context
from netconf_backend.yang.runtime import create_context
from netconf_backend.yang.context import SchemaContext
from netconf_backend.yang.repository import YangRepository, filename
from netconf_backend.netconf.schema_fetcher import ModuleSpec, library_inventory, YL
from netconf_backend.protocol.rpc import BackendError

FIXTURES = Path(__file__).parent / "fixtures" / "yang"


def descendants(roots):
    return [n for root in roots for n in [root, *descendants(root["children"])]]


def test_real_libyang_effective_tree():
    with create_context(FIXTURES) as ctx:
        ctx.load_module("test-system")
        ctx.load_module("test-augment")
        ctx.compile_schema()
        modules, tree = serialize_context(ctx)
        json.dumps(tree, allow_nan=False)
        system = next(n for n in tree["roots"] if n["name"] == "system")
        enabled = next(n for n in system["children"] if n["name"] == "enabled")
        assert enabled["type"] == "boolean" and enabled["default"] is True
        nodes = descendants([system])
        names = {n["name"] for n in nodes}
        assert "uses" not in names and "common-settings" not in names
        assert "advanced-setting" not in names
        interface = next(n for n in nodes if n["kind"] == "list")
        assert interface["keys"] == ["name"]
        assert next(n for n in interface["children"] if n["name"] == "name")["isKey"]
        augmented = next(n for n in interface["children"] if n["name"] == "description")
        assert augmented["namespace"] == "urn:test:augment"
        assert augmented["path"] == "/test-system:system/interface/test-augment:description"
        assert not next(n for n in nodes if n["name"] == "statistics")["config"]
        assert next(n for n in nodes if n["name"] == "dns")["kind"] == "leaf-list"
        assert next(n for n in nodes if n["name"] == "service")["presence"]
        assert next(n for n in nodes if n["name"] == "hostname")["mandatory"]
        assert len({n["id"] for n in nodes}) == len(nodes)
        assert {m["name"] for m in modules} >= {"test-system", "test-augment"}


def test_features_deviations_and_on_demand_imports(tmp_path):
    session = Mock()
    session.get_schema.side_effect = lambda name, revision: (FIXTURES / f"{name}.yang").read_text()
    repository = YangRepository("router", 830, tmp_path)
    schema = SchemaContext()
    inventory = [ModuleSpec("test-augment", "2026-09-15"), ModuleSpec("test-system", "2026-09-14", features=["advanced"]), ModuleSpec("test-deviation", "2026-09-16")]
    result = schema.compile(inventory, repository, session)
    nodes = descendants(schema.tree["roots"])
    assert "advanced-setting" in {n["name"] for n in nodes}
    assert "mtu" not in {n["name"] for n in nodes}
    assert result["modulesDownloaded"] == 3
    assert (repository.path / "test-system@2026-09-14.yang").exists()
    schema.clear()
    session.reset_mock()
    # Import callback is called by libyang, not an application YANG parser.
    schema.compile([ModuleSpec("test-augment", "2026-09-15")], repository, session)
    assert any(call.args[0] == "test-system" for call in session.get_schema.call_args_list)
    schema.clear()


def test_invalid_yang_does_not_replace_working_tree(tmp_path):
    session = Mock()
    session.get_schema.return_value = (FIXTURES / 'test-system.yang').read_text()
    schema = SchemaContext()
    repo = YangRepository('router', 830, tmp_path)
    schema.compile([ModuleSpec('test-system')], repo, session)
    before = schema.tree
    session.get_schema.return_value = 'not valid YANG'
    with pytest.raises(BackendError) as exc:
        schema.compile([ModuleSpec('broken')], repo, session)
    assert exc.value.code == 'yang_compile_failed'
    assert schema.tree is before
    schema.clear()


def test_repository_rejects_traversal():
    for name, revision in [("../oops", None), ("test", "../../x"), ("/tmp/x", None)]:
        with pytest.raises(BackendError): filename(name, revision)


def test_7895_inventory():
    result = library_inventory(f'<data><modules-state xmlns="{YL}"><module><name>test-system</name><revision>2026-09-14</revision><conformance-type>implement</conformance-type><feature>advanced</feature><submodule><name>test-sub</name></submodule></module></modules-state></data>')
    assert result[0].implemented and result[0].features == ['advanced']
    assert result[1].submodule and not result[1].implemented


def test_8525_selects_running_not_union_of_datastores():
    text = f'''<data><yang-library xmlns="{YL}" xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">
      <module-set><name>a</name><module><name>running-module</name></module></module-set>
      <module-set><name>b</name><module><name>other-module</name></module></module-set>
      <schema><name>running-schema</name><module-set>a</module-set></schema>
      <datastore><name>ds:running</name><schema>running-schema</schema></datastore>
    </yang-library></data>'''
    assert [m.name for m in library_inventory(text)] == ['running-module']
    with pytest.raises(BackendError):
        library_inventory(text.replace('ds:running', 'ds:operational'))


@pytest.mark.parametrize('capability', [
    'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=test',
    f'{YL}?module=ietf-yang-library&revision=2016-06-21',
    f'{YL}?module-set-id=2026-09-14',
])
def test_library_capability_forms_take_precedence_over_monitoring(capability):
    from netconf_backend.netconf.schema_fetcher import discover, MON
    session = Mock()
    session.info.return_value = {'capabilities': [capability, MON]}
    session.get.return_value = f'''<data><modules-state xmlns="{YL}">
      <module><name>sys</name><revision>2026-09-14</revision>
      <conformance-type>implement</conformance-type></module>
    </modules-state></data>'''
    specs = discover(session)
    assert [(s.name, s.revision) for s in specs] == [('sys', '2026-09-14')]
    session.get.assert_called_once_with([
        f'<yang-library xmlns="{YL}"/>', f'<modules-state xmlns="{YL}"/>',
    ])
