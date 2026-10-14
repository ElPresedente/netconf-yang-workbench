# netconf-client

A local Electron/React desktop NETCONF and YANG inspection tool. Electron owns a Python child process; all application communication uses stdin/stdout JSON messages. There is no HTTP or WebSocket service, including in development.

## Current milestone

- Explicit password-based Connect and Disconnect, one session at a time; no startup connections, probes, schema downloads, or automatic reconnection.
- NETCONF 1.0 / 1.1 using ncclient capability negotiation and framing; the active negotiated version is shown. Server capabilities, device endpoint, and session ID are visible.
- Explicit YANG Library discovery (RFC 8525 / RFC 7895), with a limited NETCONF monitoring fallback.
- `<get-schema>` downloads through the existing session, a per-device local cache, and real system libyang compilation.
- Effective data tree with containers, lists/keys, leaves, leaf-lists, config/state, presence, defaults, descriptions, module namespaces and paths. Groupings/uses, augments, features and deviations are processed by libyang.
- Connection/schema logs and received XML previews. Sent inventory filters and operation summaries are recorded; full byte-level TX capture is not implemented.
- Structured errors, transport-loss events, isolated preload API, and bounded application shutdown.

The desktop uses a workbench layout: compact connection and request toolbars, a dominant central tree, collapsible schema sidebar and inspector, and one full-width output dock. Drag the splitters to resize side panes and output height. **Preview**, **Response**, and **Session log** tabs share the dock; Execute activates Response. Collapse the dock for tree space, or use **Maximize / Restore** (also double-click the dock header) for large replies. Server capabilities remain available but are collapsed by default. The sidebar includes module revisions and a simple schema name/module filter.

Sidebar/inspector visibility, splitter sizes, output collapse state and last output tab persist in renderer localStorage. No credentials or device data are saved there. Raw XML authoring, notifications, multiple simultaneous devices, cache-only loading and distributable packaging remain future work.

## Prerequisites

- Node.js **22.12 or newer** and npm (the Electron installer requires this minimum).
- Python **3.12+** with virtualenv support.
- System **libyang 5**, its development headers, and its standard YANG modules.
- A C compiler, Python development headers, and libffi development headers for the Python binding.
- Desktop libraries needed by Electron (GTK, NSS, etc. on Linux).

This project pins `libyang` (the **libyang-python** package) to 5.0.0 and ncclient to 0.7.1. Paramiko is constrained below 5 because ncclient 0.7.1's host-key selection is incompatible with Paramiko 5 in the tested RSA-key path. Tested with Python 3.14, system libyang 5.8.6, and Paramiko 4.0.0.

Install libyang through a package manager if it offers **major version 5** with headers and standard models, or follow the [upstream libyang build instructions](https://github.com/CESNET/libyang#building). Older distribution packages named `libyang2-dev` are not a substitute for this pinned binding. The [Python binding instructions](https://github.com/CESNET/libyang-python#installation) describe compiler/header settings for nonstandard prefixes. Check `pkg-config --modversion libyang` before installing Python dependencies.

On Windows, use a native Python/libyang toolchain compatible with the Electron process. Native Windows and macOS startup have not been verified; this milestone was developed and tested on Linux.

## Installation and startup

From the repository root:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -e './backend[test]'
npm install
npm run dev
```

On Windows, the virtualenv Python is `backend\.venv\Scripts\python.exe`.

`npm run dev` builds TypeScript and the renderer, starts Electron, and runs Vite in **build/watch** mode. Electron starts only after the first watch build finishes; subsequent successful builds notify Electron to reload the window after all assets are written. Failed builds keep the current window. No development server is started. Reloading never opens a connection. Restart development mode after editing Electron or Python code.

For a build without watchers:

```sh
npm run build
npm start
```

Configuration (environment variables):

| Variable | Purpose |
| --- | --- |
| `NETCONF_PYTHON` | Python executable; defaults to `backend/.venv`, then system Python |
| `NETCONF_BACKEND_PATH` | Working directory containing the `netconf_backend` package |
| `NETCONF_LIBYANG_MODULES` | Directory containing libyang's standard modules if installed at a nonstandard location |

The backend checks `/usr/share/yang/modules/libyang` and `/usr/local/share/yang/modules/libyang`. A missing shared library or Python dependency appears as a startup error in the window. A missing standard model installation produces an explicit libyang initialization error.

## Connecting to a device

1. Enable NETCONF over SSH on the device with base 1.0 or 1.1 support.
2. Independently verify its SSH host key and put the trusted key in your normal `~/.ssh/known_hosts`. For port 830, the entry may use `[hostname]:830`. Unknown/changed keys are rejected; the MVP does not disable host verification or offer a trust dialog.
3. Enter host, port (830 by default), username and password. Press **Connect**. The password field clears immediately. Passwords are never logged; saving one requires explicit opt-in through device profiles.
4. Inspect the state, session ID and server capabilities. No schema RPCs have been sent yet.
5. Press **Load YANG models**. This performs inventory queries, downloads, and compilation. The device must expose a supported inventory and permit `<get-schema>` for required modules and dependencies.
6. Expand the tree. Select a node to see its effective path, namespace and description. Server XML is available in expandable entries in the Session log output tab.
7. Check data nodes independently of inspection, optionally fill list keys, and choose GET or GET-CONFIG. Review the generated XML, then press **Execute**. GET-CONFIG offers running and capability-supported candidate/startup datastores.
8. Press **Disconnect** to send `<close-session>` and close SSH. An unexpected transport termination also transitions to Disconnected; reconnection always requires another Connect action.

Backend commands are serialized. Disconnect is disabled during schema loading and request execution; individual RPCs have a 30-second timeout. Close the application to terminate a stalled operation: graceful backend shutdown is allowed six seconds, followed by termination and an eight-second forced-kill deadline. Disconnect's close-session timeout is three seconds, followed by a bounded reader-thread cleanup. Silent network black holes may be detected only when an RPC times out or SSH reports failure; there are no background probes.

Models remain visible after disconnect for inspection and are cleared on the next explicit connection attempt. Failed reloads retain the last successfully compiled tree. The cache lives under the platform cache directory, e.g. `~/.cache/netconf-client/devices/<host-port-hash>/yang/`; it contains YANG source only, with revisioned filenames where known. Each load downloads afresh into a clean compilation view, so obsolete cache revisions cannot affect the effective tree.

## Discovery limits

RFC 8525 inventories select the running datastore's schema and its referenced module sets. A single module set is accepted when no running reference exists; ambiguous inventories fail explicitly. RFC 7895 preserves implement/import conformance and enabled features. Deviation modules must be present as implemented modules in the inventory so libyang can apply them.

Discovery first queries both standard YANG Library roots when the server advertises a YANG Library capability or module. If the advertised inventory fails or is denied and monitoring is advertised, discovery tries NETCONF monitoring. The monitoring fallback uses module capability parameters to identify implemented roots and enabled features, and lets libyang request imports/includes. It requires matching monitoring entries and module capabilities. Monitoring-only inventories that cannot identify implemented modules, and fallback inventories advertising deviations, fail explicitly. External HTTP schema URLs are not downloaded. Vendor-specific discovery is not implemented.

## Tests

```sh
npm run build
npm test
npm run test:backend
npm run test:desktop
npm run test:dev
```

On a headless Linux machine: `xvfb-run -a npm run test:desktop` (requires Xvfb).

Backend tests include an ephemeral **loopback SSH/NETCONF device fixture**, not an HTTP server. No physical device or credentials are needed. It checks actual ncclient client-hello capabilities, base-1.0 delimiter framing and base-1.1 chunking, preview without network activity, GET / GET-CONFIG over the same session, detailed rpc-errors, no schema RPCs after connect, discovery, source retrieval, effective schema compilation and close-session. The remaining backend tests can run without socket access:

```sh
backend/.venv/bin/python -m pytest backend/tests --ignore=backend/tests/test_netconf_integration.py
```

Node tests verify the real Python child-process bridge, response correlation, errors and shutdown. The desktop smoke test launches the actual Electron app with a temporary profile and checks renderer visibility, isolation, backend readiness, disconnected control states and Python process cleanup. On Linux/macOS it also runs the entire Connect → Load models → inspect/select/key inputs → preview → GET / GET-CONFIG → rpc-reply / rpc-error → reload → Disconnect flow against the local SSH fixture. It saves `dist/desktop-smoke.png` and `dist/desktop-schema.png`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership invariants, protocol and extension points.

The dev smoke test uses the same Vite watch orchestration as `npm run dev`, checks initial rendering, changes a source file, and verifies that the rebuilt interface loads without missing assets. On headless Linux, run `xvfb-run -a npm run test:dev`.

## Request builder

Retrieval supports subtree-filter GET and GET-CONFIG. EDIT-CONFIG uses the separate Edit Draft workflow described below. Preview is the operation payload, without ncclient's RPC envelope or message ID. Execution validates the same structured intent again and uses the sole active session; it never reconnects or retries. A compiled schema and at least one selected data node are required. GET permits state nodes; GET-CONFIG rejects explicit state-node selections.

Click a node to inspect metadata; use its separate checkbox to select request data. Checked containers/lists select the complete subtree. Their descendants appear checked and disabled until the parent is unchecked. An indeterminate checkbox means descendants are selected; checking it replaces those selections with the whole subtree. Clearing it removes selections below it. Unchecked nodes have no selected descendants. Selection uses effective schema paths and is cleared on successful schema reload or a new connection attempt.

Ancestors are generated automatically and shared by sibling selections. Optional list key values apply a content match in schema key order, using the actual key leaf namespace. Blank keys mean no match constraint. A key used for both matching and selection produces one XML element. Selecting a whole subtree with key constraints expands the relevant output children so matching does not unintentionally remove sibling output. Only one match value per key per list schema path is supported; arbitrary non-key matches and XPath are outside this milestone.

The backend resolves paths and namespaces from the existing compiled schema DTO, including augment namespaces, and rejects unknown paths and unsupported datastores. Key values are escaped XML content matches, not configuration values; retrieval key matching is independent of the edit value inputs described below. The Response output tab displays the original rpc-reply XML plus all available rpc-error fields. The original reply remains available to the existing session logging boundary, with its existing size limit.

List key inputs are shown only for explicitly selected lists and lists on the path to explicitly selected nodes. Selecting an ancestor subtree does not expose keys of lists inside it; existing matches for those nested lists are cleared so the whole subtree is retrieved without those restrictions.

RFC 6243 `:with-defaults` is supported for GET and GET-CONFIG. The capability-driven **With defaults** selector offers the advertised `basic-mode` plus valid modes in `also-supported` (including `report-all-tagged` only when advertised). It is hidden without the capability. **Server default** maps to null and omits the parameter. The choice is session-local and resets on a new connection or capability-set change; it is not saved across devices.

Both preview and execution reject unknown or unadvertised modes. Preview places the RFC 6243 element in `urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults` after the filter, matching installed ncclient 0.7.1 ordering. Execution passes `with_defaults` to `Manager.get` / `Manager.get_config` through the existing active NetconfSession. ncclient retains capability validation, RPC envelopes, message IDs and framing; no additional session, reconnect or custom dispatch is used. COPY-CONFIG remains outside scope.

## Saved device profiles

Choose **Device profiles** beneath the connection fields to save the current endpoint, edit/rename the selected profile using **Profile name** and **Save profile**, or delete it. **New profile** switches to manual mode while retaining the endpoint fields for saving a copy. The Device selector also offers **Manual connection**; saving is never required. The last selected profile restores its host, port and username at startup. **Restoring or selecting a profile never connects or loads schemas. Press Connect explicitly.** Profile controls are disabled while a connection or operation is active.

**Remember password** is optional. Electron main stores metadata and native `safeStorage` encrypted credential blobs in `device-profiles.json` under Electron's normal userData directory. No plaintext password is written. Linux requires an available libsecret/KWallet backend; `basic_text`, unknown or unavailable storage disables password saving. Windows uses Electron's native secure storage API; Windows packaging is not part of this milestone.

The renderer receives a saved-credential indicator, never the decrypted saved password or encrypted blob. Connect passes a profile ID and optional transient password to main, which resolves a saved password only for that explicit connection. Typing a password overrides the saved one for that connection; only **Save profile** replaces it. Saving with Remember password unchecked removes the stored credential. Changing host/port/username requires a fresh password to remember for the new endpoint. Manual endpoint edits do not use a mismatched profile's credential. Python only receives the transient connection parameters and knows nothing about profile storage.

## Last response data tree

The central **Schema / Last response / Edit draft / RPC** tabs separate schema selection, runtime inspection, and configuration authoring. A successful GET or GET-CONFIG is parsed through the same active libyang context used by the request builder. **Last response** shows returned containers, keyed list instances, leaf-lists and canonical scalar values, with schema type and state hints. Clicking data nodes inspects them without changing request selection. Configurable nodes also offer explicit edit staging.

The shared inspector shows runtime value, module/namespace, list keys, schema path and instance path alongside linked schema metadata. `schemaPath` identifies the effective schema node; `instancePath` identifies the particular list/leaf-list instance using libyang's paths. Multi-key labels use YANG key order. Scalar values are canonical strings so uint64/decimal64 precision survives JSON. Partial responses contain only returned nodes; absent/default nodes are not synthesized.

The Response output tab always retains the latest raw XML. Local parsing failure reports **Request succeeded. YANG data-tree parsing failed** and logs a diagnostic; it does not turn a successful NETCONF operation into a failure. Unknown schema data is rejected by the strict parser rather than silently discarded.

A successfully parsed retrieval replaces the runtime tree, including an empty `<data>` result. RPC errors, transport errors and local parse failures retain the last successfully parsed tree. A new explicit connection attempt or successful schema replacement clears it; failed schema reload and Disconnect retain it for inspection. Runtime data and raw replies are in renderer memory and clear on renderer reload/app restart. Restoring UI preferences or profiles causes no network activity.


## EDIT-CONFIG and Edit Draft

Select **EDIT-CONFIG** in the operation toolbar. It is available only when the connected server advertises `:candidate` or `:writable-running`: candidate is preferred initially; running requires writable-running, and startup is never an edit target. With defaults is hidden for edits and its retrieval choice is retained when switching modes.

The central **Edit draft** tree is the primary configuration editor. The inspector holds metadata; a collapsed **Draft summary** below the tree provides a secondary flat review. Select EDIT-CONFIG first to show the Edit draft tab and inline add/edit/delete/remove actions beside tree nodes. GET and GET-CONFIG hide these controls while retaining the draft. Its compact toolbar holds Target, Default operation, capability-supported Test option, Error option, Execute and Clear draft. Schema/Last response remain available as palettes, and GET checkboxes remain independent retrieval selections. Changing a draft never sends network traffic.

- **Edit existing:** in Last response, choose **Edit in draft** beside a configurable leaf. The corresponding branch opens in Edit draft with automatically inherited, read-only list keys and `original → input` values. Type directly in the tree. Repeating the action reuses the concrete branch and preserves edits. **Edit instance** loads the returned configurable children of a list/container as untouched context. Only modified children or explicitly included rows are emitted; unchanged siblings are not sent. Selecting a leaf explicitly includes it even if its value stays unchanged. Reverting an untouched leaf to its original value excludes it again.
- **Create new:** in Schema, click **+ Add instance** on a list or **+** on a configurable container/leaf. Required list keys appear immediately in schema order at each ancestor list. Enter them directly in the tree, then use that instance's **+ Add field** picker to select configurable children. Search by field name/module; nested containers and lists preserve the hierarchy. Lists can be added repeatedly for distinct instances. Use Add field within a particular instance to choose its parent unambiguously. Schema additions beneath an existing schema-authored ancestor reuse the first such branch.
- New lists start with **create**; scalar fields start with **merge**. No child values or defaults are invented. Unfilled keys/scalars prevent a valid preview. Presence containers can be included empty; ordinary containers begin as structural branches with Add field. Booleans use a selector, empty leaves use a presence checkbox, and other values use text inputs, including large integers and decimals.
- State (`config=false`), keyless lists, leaf-lists, anyxml and anydata remain read-only. Existing list keys cannot be renamed: create another instance and delete/remove the old instance. Required keys are emitted as addressing scaffolding, never independent leaf edits.

Each draft row has an operation selector: `merge`, `replace`, `create`, `delete`, and `remove` retain their distinct meanings. Last response also offers Delete/Remove in its compact action menu. Deleted/removed branches have destructive styling and read-only descendants; conversion omits those descendants while retaining them locally if the operation is changed back. Delete requires existence; remove tolerates absence. Replacing a container/list can remove omitted children. The backend continues to reject overlapping replace/descendant edits and duplicate concrete targets, including new lists given identical keys. No operation is silently rewritten. The × action removes a row/subtree from the local draft only.

Choose the **Preview** dock tab for the exact backend-generated `<edit-config>` payload, then **Execute** through the same explicitly connected session. The frontend converts the editable hierarchy into the existing structured `EditIntent`/`EditChange[]`; Python independently validates it and owns namespace-aware XML generation. Preview performs zero network activity and has no RPC message ID or transport framing.

**Default operation** is a separate RPC option. Server/RFC default omits the argument; explicit `merge`, `replace`, and `none` remain separate choices. The initial edit default is `none`. For this targeted builder, delete/remove requires `none` to avoid unintended ancestor creation. RPC default `replace` is rejected when a change requires implicit ancestors; it is available for root-level edits. Use an explicit node operation and default `none` or `merge` for targeted changes. The builder never silently changes the selected option.

**Error option** offers omission, stop-on-error and continue-on-error; rollback-on-error requires the advertised capability. **Test option** appears only with validate support: validate 1.0 permits test-then-set and set; validate 1.1 additionally permits test-only, matching pinned ncclient 0.7.1. Omission leaves server/RFC defaults intact. These rules are enforced again in the backend. Protocol details: [RFC 6241 sections 7.2 and 8.6](https://www.rfc-editor.org/rfc/rfc6241.html#section-7.2), with validate 1.0 defined in [RFC 4741](https://www.rfc-editor.org/rfc/rfc4741.html#section-8.6).

Execution activates Response and preserves the raw rpc-reply and every rpc-error field, including multiple errors. **The draft is retained after success or failure until explicitly cleared.** Successful candidate edits report **Candidate modified; not committed.** There is no automatic commit, GET, GET-CONFIG, schema reload, reconnect, or retry. Re-executing a retained draft sends it again; create/delete may therefore fail on a subsequent execution.

Last response records GET or GET-CONFIG plus source datastore. A running edit marks generic GET and GET-CONFIG running stale; a candidate edit marks GET-CONFIG candidate stale. Test-only leaves freshness unchanged. RPC errors and uncertain execution failures conservatively mark affected data stale, including failures that may have partially applied. The existing tree and its **Raw retrieval response** remain inspectable. A new successful parsed retrieval replaces both and clears staleness; parse failures retain the old snapshot and marker.

The draft, provenance and raw retrieval XML are memory-only. A new explicit connection attempt or successful schema replacement clears the draft and runtime snapshot; failed schema reload and Disconnect retain them for inspection. Execution is disabled while disconnected. Panel visibility, tree expansion, output tabs and operation switching never clear the draft.

Value entry is intentionally small: boolean choices and textual scalar inputs, with empty type represented as presence without text. Large integer/decimal values stay strings throughout. Type metadata is retained with each draft item. Enumeration, identityref, leafref and other scalar types use text; there is no range/pattern validation, generated complete form, identity/leafref chooser, or client-side semantic validation. The server remains the final validator. XML values are escaped by lxml and each effective node uses its actual schema namespace, including augments.


## Explicit candidate actions

With a connected server advertising `:candidate`, select **EDIT-CONFIG** and target **candidate** to show **Commit** and **Discard changes**. Commit applies the device's candidate configuration to running; Discard changes replaces candidate with running. These actions operate on the device's entire candidate datastore, which may include other clients' changes. They do not send the local Edit draft and do not require a loaded schema or valid draft preview. **Clear draft** remains a separate, local-only action.

A successful non-test-only candidate edit shows **This session modified candidate**. This is a local observation, not a global dirty-state check. The indication survives schema reload, layout changes and draft clearing; it resets after successful Commit/Discard, a new connection attempt, or renderer reload. Errors retain the previous indication. Its absence never means candidate is globally clean.

Both actions open Response, preserving the raw rpc-reply and all rpc-errors. They retain the Edit draft after success or failure. Commit marks generic GET, running and candidate snapshots stale; Discard marks candidate snapshots stale and preserves running/generic GET freshness. Failed or uncertain attempts use the same conservative stale rules; neither action makes an existing snapshot fresh. Refresh only happens on a subsequent explicit GET/GET-CONFIG.

There is no automatic commit after edit-config, no discard on Disconnect, and no automatic retrieval, retry, reconnect or schema reload. Both use the same active session. Confirmed-commit and standalone validate remain out of scope.


## YANG-defined RPCs

After explicit Connect and Load YANG models, open **RPC**. Search by module/name and select an operation from the module-grouped list. Only top-level RPCs from implemented device modules are offered, using the compiled effective model and enabled features. Selection sends nothing.

Required input fields appear in the central tree. Use **Add field / entry** to include optional fields, containers, presence containers, list entries and leaf-list values. Remove excludes an occurrence; choice selectors replace the selected case. Values remain textual, preserving numeric precision. Boolean false, numeric zero, empty string and YANG empty are distinct from absence. No defaults or optional values are invented. Click input/output names for schema metadata and descriptions in the inspector.

**Preview RPC** validates locally and shows only the qualified operation payload in the Preview dock. **Execute RPC** requires a preview of the current arguments and dispatches through the existing connection. ncclient supplies the NETCONF envelope and framing. Parameterless RPCs have no fabricated input. Arguments are memory-only and reset on new connection attempts and successful schema replacement; they are never saved to profiles or localStorage. Operation summaries do not log outbound arguments. Raw device replies remain subject to the existing bounded response logging.

The Response dock preserves complete rpc-reply XML and every rpc-error. The RPC workspace displays schema-aware structured output when libyang can parse it, including repeated values and lists. An ok reply is valid. A local output parsing warning never changes remote success into failure. All custom RPC attempts that may have reached the server conservatively mark retained runtime snapshots potentially stale, including operations named get-*. No snapshot is cleared or automatically refreshed.

Local checks enforce references, structure, mandatory fields, choices, list keys/cardinality and scalar parsing using libyang's operation parser. Datastore-dependent leafrefs and must/when constraints require server validation; conditional mandatory fields are deferred rather than guessed without datastore context. Opaque anydata/anyxml inputs are currently unsupported. YANG 1.1 actions and notifications remain future work: actions need concrete datastore-instance context and list keys, unlike these top-level RPCs.
