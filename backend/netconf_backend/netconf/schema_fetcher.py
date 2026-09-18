"""Standards-based inventories; source retrieval always uses the owned session."""
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlsplit
from lxml import etree
from ..protocol.rpc import BackendError

YL = "urn:ietf:params:xml:ns:yang:ietf-yang-library"
MON = "urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"


@dataclass
class ModuleSpec:
    name: str
    revision: str | None = None
    implemented: bool = True
    features: list[str] = field(default_factory=list)
    submodule: bool = False


def xml(text):
    return etree.fromstring(text.encode(), etree.XMLParser(resolve_entities=False, no_network=True))


def child(node, name, ns=YL):
    return node.findtext(f"{{{ns}}}{name}")


def library_inventory(text):
    root = xml(text)
    library = root.find(f".//{{{YL}}}yang-library")
    specs = []
    if library is not None:
        sets = library.findall(f"{{{YL}}}module-set")
        # RFC 8525: select the schema referenced by the running datastore.
        running = []
        for ds in library.findall(f"{{{YL}}}datastore"):
            identity = child(ds, "name") or ""
            prefix, _, local = identity.partition(":")
            if local == "running" and ds.nsmap.get(prefix) == "urn:ietf:params:xml:ns:yang:ietf-datastores":
                running.append(child(ds, "schema"))
        if running:
            schemas = [s for s in library.findall(f"{{{YL}}}schema") if child(s, "name") in running]
            names = {n.text for s in schemas for n in s.findall(f"{{{YL}}}module-set")}
            if not names or not names.issubset({child(s, 'name') for s in sets}):
                raise BackendError("schema_discovery_failed", "Running schema references missing module sets")
            sets = [s for s in sets if child(s, "name") in names]
        elif len(sets) != 1:
            raise BackendError("schema_discovery_failed", "Cannot select a running schema from multiple module sets")
        for module_set in sets:
            for tag, implemented in (("module", True), ("import-only-module", False)):
                for mod in module_set.findall(f"{{{YL}}}{tag}"):
                    specs.extend(module_specs(mod, implemented))
    else:
        for mod in root.findall(f".//{{{YL}}}modules-state/{{{YL}}}module"):
            specs.extend(module_specs(mod, child(mod, "conformance-type") == "implement"))
    if not any(s.implemented and not s.submodule for s in specs):
        raise BackendError("schema_discovery_failed", "YANG Library returned no implemented modules")
    unique = {}
    implemented_revisions = {}
    for spec in specs:
        key = (spec.name, spec.revision)
        if spec.implemented and not spec.submodule:
            if spec.name in implemented_revisions and implemented_revisions[spec.name] != spec.revision:
                raise BackendError("schema_discovery_failed", "Running schema has conflicting module revisions")
            implemented_revisions[spec.name] = spec.revision
        if key in unique:
            prior = unique[key]
            if prior.implemented and spec.implemented and prior.features != spec.features:
                raise BackendError("schema_discovery_failed", "Running module sets have conflicting feature selections")
            if prior.implemented:
                continue
        unique[key] = spec
    return list(unique.values())


def module_specs(mod, implemented):
    name = child(mod, "name")
    if not name:
        raise BackendError("schema_discovery_failed", "Module inventory is missing a name")
    result = [ModuleSpec(name, child(mod, "revision") or None, implemented,
                         sorted(n.text for n in mod.findall(f"{{{YL}}}feature") if n.text))]
    for sub in mod.findall(f"{{{YL}}}submodule"):
        if not child(sub, "name"):
            raise BackendError("schema_discovery_failed", "Submodule inventory is missing a name")
        result.append(ModuleSpec(child(sub, "name"), child(sub, "revision") or None, False, submodule=True))
    return result


def discover(session):
    caps = session.info()["capabilities"]
    if any(c.startswith("urn:ietf:params:netconf:capability:yang-library:")
           or c.split("?", 1)[0] == YL
           or parse_qs(urlsplit(c).query).get("module") == ["ietf-yang-library"]
           for c in caps):
        # Query both standard roots; an unsupported subtree is simply absent.
        try:
            return library_inventory(session.get([f'<yang-library xmlns="{YL}"/>', f'<modules-state xmlns="{YL}"/>']))
        except BackendError:
            # An advertised but broken/denied inventory may still have monitoring.
            if not any(MON in c or "module=ietf-netconf-monitoring" in c for c in caps):
                raise
            session.log("YANG Library unavailable; trying NETCONF monitoring", level="warning")
    if not any(MON in c or "module=ietf-netconf-monitoring" in c for c in caps):
        raise BackendError("schema_discovery_failed", "Device advertises neither YANG Library nor NETCONF monitoring")
    data = xml(session.get(f'<netconf-state xmlns="{MON}"><schemas/></netconf-state>'))
    inventory = {}
    for entry in data.findall(f".//{{{MON}}}schema"):
        fmt = child(entry, "format", MON) or ""
        if fmt.split(":")[-1] != "yang":
            continue
        name = child(entry, "identifier", MON)
        if name:
            inventory[(name, child(entry, "version", MON) or None)] = entry
    # Monitoring does not identify conformance or enabled features. Use module
    # capability parameters for roots; libyang resolves imports/includes itself.
    specs = []
    for cap in caps:
        query = parse_qs(urlsplit(cap).query)
        if "module" not in query:
            continue
        name = query["module"][0]
        revision = query.get("revision", [None])[0]
        if (name, revision) not in inventory:
            continue
        specs.append(ModuleSpec(name, revision, True,
                     [f for f in query.get("features", [""])[0].split(",") if f]))
        if query.get("deviations"):
            raise BackendError("schema_discovery_failed", "Monitoring fallback cannot determine deviation module revisions; YANG Library is required")
    if not specs:
        raise BackendError("schema_discovery_failed", "Monitoring fallback requires YANG module capabilities with matching schema entries")
    session.log("Monitoring fallback: implemented roots/features come from module capabilities")
    return specs
