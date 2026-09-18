# Architecture

> **No component except NetconfSession may open a NETCONF connection.**
>
> **A NETCONF connection may only be opened in response to an explicit user Connect action.**

There is one session in the MVP. No reconnect loop, periodic network probe, temporary schema session, pool, or startup connection exists.

## Layers and files

```text
frontend/src/                   React presentation and user actions
  api/netconf-api.ts             Typed preload API and structured error handling
  features/connection/          Connection form, session state and capabilities
  features/schema/              Module list and effective tree
  features/requests/            Structured intent, capability helper, preview and response
  features/logs/                Bounded log display
shared/types.ts                 Stable renderer-facing DTOs and API

electron/
  main.ts                       Window isolation and application lifecycle
  preload.ts                    Named contextBridge methods and subscriptions
  ipc.ts                        Sender-checked named IPC routing
  backend-process.ts            Owned Python child, NDJSON framing and correlation

backend/netconf_backend/
  main.py                       Serialized command dispatcher and event output lock
  protocol/rpc.py                Input validation and structured response encoding
  netconf/session.py             Sole ncclient/SSH connection owner
  netconf/schema_fetcher.py      RFC 8525 / RFC 7895 / monitoring inventory adapters
  requests.py                   Pure schema-backed subtree construction/validation
  yang/repository.py             Safe revisioned filenames and device cache
  yang/runtime.py                System libyang initialization/search paths
  yang/context.py                Transactional compile and libyang dependency callback
  yang/serializer.py             Compiled node → JSON DTO conversion
backend/tests/                  Unit tests, real libyang fixtures, local SSH fixture
scripts/                        File-based development and Electron smoke test
```

```text
React renderer
    │ named methods/events via contextBridge
    ▼
Electron preload / main
    │ newline-delimited JSON on child stdin/stdout
    ▼
Python serialized command loop
    ├── NetconfSession ── ncclient ── SSH / NETCONF 1.0 or 1.1 ── device
    └── schema inventory → source repository → system libyang → JSON tree
```

Renderer has no Node APIs, sockets, filesystem access or YANG parsing. It receives only named operations and event subscriptions, never `ipcRenderer`. Main has no NETCONF/YANG business logic; it owns profile persistence and native credential resolution. The Python domain modules are usable independently of React.

Electron uses `contextIsolation: true`, `nodeIntegration: false`, sandboxed preload, disabled navigation/new windows, and a content security policy with `connect-src 'none'`. It launches Python directly without a shell. Neither runtime nor development uses HTTP/WebSocket application services. Vite builds to files loaded with `loadFile()`.

## Protocol and concurrency

Each UTF-8 line is one JSON object. stdout is exclusively protocol output; diagnostics go to stderr. A lock serializes responses and events from ncclient's reader thread so lines cannot interleave. Integer request IDs correlate replies; events have no request ID.

```json
{"id":12,"method":"connect","params":{"host":"router","port":830,"username":"admin","password":"ephemeral"}}
{"id":12,"result":{"state":"connected","sessionId":"42","capabilities":["urn:ietf:params:netconf:base:1.1"],"host":"router","port":830}}
{"id":13,"error":{"code":"not_connected","message":"Connect to a device first"}}
{"event":"connection.stateChanged","data":{"state":"disconnected","sessionId":null,"capabilities":[]}}
```

Known methods: `connect`, `disconnect`, `connection.getState`, `schema.fetch`, `schema.getModules`, `schema.getTree`, `request.preview`, `request.execute`, and main-process-only `shutdown`. Arbitrary methods and unexpected parameters are rejected. The shutdown command is not exposed to the renderer.

Events: `backend.ready`, `connection.stateChanged`, `connection.closed`, `schema.progress`, `log.entry`. Electron retains readiness/failure status so startup errors cannot be lost before the renderer subscribes. State and schema getter methods are read-only; they never touch the network. Session ID is a string to preserve the server-provided identifier.

A single blocking command loop is intentional. ncclient does SSH reads in its own thread and reports transport errors through a `SessionListener`; only state changes and log events cross back from it. The renderer remains responsive. The frontend serializes user operations, disables invalid actions and blocks rapid double submission. It uses connection events as authoritative, avoiding a late connect response overwriting a transport-loss event. Disconnect during schema work or request execution is not implemented in this milestone.

Errors carry `code`, `message`, and optional `details`. Credentials and credential-bearing library exceptions are never logged. Request-builder operation XML (including supplied key matches) is logged on TX. The session owner retains only the endpoint. Optional encrypted credentials are persisted solely by Electron main, outside Python. Password authentication is represented explicitly so a future discriminated authentication type can add keys.

## Session ownership and shutdown

```text
DISCONNECTED -- Connect --> CONNECTING -- success --> CONNECTED
                              │                       │
                            failure             Disconnect
                              │                       ▼
                              └────────────── DISCONNECTING
                                                      │
                                                      ▼
                                                DISCONNECTED
CONNECTED -- transport EOF/error ----------------------┘
```

Only `NetconfSession.connect()` invokes `SSHSession.connect()`, once per accepted command. It uses ncclient's `DefaultDeviceHandler`, advertising both base 1.0 and base 1.1. ncclient negotiates base 1.1 when mutually supported and otherwise uses base 1.0; all framing remains owned by ncclient. The session DTO reports `protocolVersion` (`1.0`, `1.1`, or null when inactive) from the negotiated default-handler capability intersection.

A `Manager` wraps that exact SSH session. Discovery/get-schema and request execution reuse it. `SessionListener.errback` clears the active owner and emits Disconnected; it never calls connect. Listener identity prevents a stale callback from affecting a later session. Host keys are verified through known_hosts, SSH agent/key discovery are disabled, and no host trust is silently added.

Disconnect attempts close-session with a three-second RPC timeout, closes the underlying SSH transport and bounds ncclient reader-thread cleanup to two seconds. Electron normally sends shutdown and closes stdin; EOF also triggers backend cleanup. If an outstanding command prevents graceful exit, Electron sends SIGTERM at six seconds and SIGKILL at eight seconds. Process termination releases the owned sockets. There is no backend respawn. Developer process signals route through the same app shutdown path.

## Schema acquisition and semantics

Schema work begins only on `schema.fetch`, corresponding to Load YANG models. Discovery selects a practical standards-based inventory, preserves conformance and feature selections, then downloads YANG sources over the active session. RFC 8525 running-schema selection prevents silently combining different datastore schemas. Ambiguous/conflicting module sets fail explicitly. An advertised but failed/denied YANG Library query falls back to monitoring when available. Monitoring roots/features are matched from module capability parameters and schema inventory entries; fallback deviations without known revisions and inventories without matching implemented roots are rejected. Both standard YANG Library roots are queried together. Monitoring fallback details are documented in the README.

Repository keys use a hash of normalized host + port, never username/password. Names/revisions are validated before filesystem use; source writes use an adjacent temporary file plus atomic replacement. No cache read can cause a connection. Each fetch creates a fresh temporary search directory, so old device revisions in the persistent cache do not affect compilation.

`Context(..., explicit_compile=True)` defers compilation until implemented modules and their enabled features have been loaded. `external_module_loader.set_module_data_clb()` supplies dependencies requested by libyang using the existing session. The application does not tokenize YANG or resolve import/include/grouping/uses/augment/typedef/identity/feature/deviation semantics. The callback exists only during the explicit fetch operation and is removed afterward. Compilation and serialization complete before replacing the previous context; failed loads leave the last good model available.

The serializer traverses compiled module/node children, not parsed statements. It includes container/list/leaf/leaf-list/anydata/anyxml nodes and flattens choice/case for this data-focused view. RPCs, actions and notifications are intentionally outside the first tree. Defining module, namespace, effective schema path, keys, config/state, type, defaults, mandatory/presence and description survive as JSON-safe metadata. Paths serve as stable identities within a schema snapshot. Augmented nodes retain the augmenting module's namespace at their effective location.

The installed libyang-python API lacks a namespace accessor; `serializer.namespace()` isolates access to `module.cdata.ns` through the binding's CFFI structure. Binding versions are pinned and real libyang tests guard these API assumptions. Large integer defaults are converted to strings to avoid JavaScript precision loss. Internal libyang modules are excluded unless downloaded as part of the device inventory; data-tree roots are restricted to the implemented inventory modules. Imported source modules appear in the module list without contributing standalone device roots. All UI values render as text, including XML and descriptions.

## Extension points

- Add request methods on the same session owner and dispatcher; never create a second transport for a raw console or builder.
- Extend `SchemaNode` and the isolated serializer for enum/union constraints, choice/case relationships, when/must and request-editor metadata. libyang remains the semantic authority.
- Add discovery adapters without vendor behavior in the session or React layers.
- Add bounded command cancellation before enabling Disconnect during downloads; retain one connection owner and explicit state transitions.
- Add richer TX capture to the session logging boundary. Current RX uses ncclient's supported listener API; logs are bounded previews, not a complete packet capture.
- Extend the discriminated profile auth type for SSH keys when implemented. Multi-session ownership is deferred until needed.
- Binary packaging, bundled libyang/Python and operating-system distribution are separate future work.

## Request intent, preview and execution

React owns `RequestIntent` independently from the visual tree: operation, source datastore, stable selected paths, and optional list-key values indexed by stable list paths. Ordinary node inspection has separate local selection. Parent selection means the full subtree; descendants inherit checked/disabled state; partial descendant selection produces an indeterminate parent. Both source datastores and request execution availability are derived from typed state. Successful schema replacement/new connection clears intent.

Named preload/IPC methods `previewRequest` and `executeRequest` map to `request.preview` and `request.execute`. Both validate intent in `requests.build_request` against `SchemaContext.tree`, the existing transactionally serialized libyang snapshot. No parallel schema representation or renderer-supplied namespaces are used. Units are the only added SchemaNode metadata. Unknown paths, unsupported data kinds, invalid key mappings, empty selections, explicit state selections for GET-CONFIG, and unsupported source datastores are rejected. Running is a base datastore; candidate/startup require their server capabilities.

The pure builder creates namespace-qualified lxml elements in schema traversal order, merges ancestor paths, orders key content matches using compiled key order, and escapes values. Whole-subtree selection normally emits an empty selection element; if constrained by keys it expands output children as needed to preserve requested output. Blank key inputs are absent matches. Paths identify schema nodes, not particular list instances; only one optional match per list key is supported.

Preview only reads schema and session capability snapshots; it never calls the active manager or network. Execution rebuilds/validates the same intent and passes the generated filter element to the public `Manager.get` / `Manager.get_config` APIs through `NetconfSession`. ncclient owns the RPC envelope, message ID, transport, negotiation and framing. The serialized command loop prevents schema replacement during either command. No extra connection or retry exists.

During request execution, ncclient's raise mode is temporarily NONE so rpc-error replies remain complete, then restored in a finally block. The result contains original `rawXml`, formatted `xml`, and all error-type/tag/severity/app-tag/path/message/info fields present in the reply. Existing RX listener logging remains unchanged and bounded. Transport/timeout errors use the existing structured error channel. Preview is debounced, ignores obsolete asynchronous responses, and disables Execute until the current intent has a valid preview. GET/GET-CONFIG only; XPath, edits, arbitrary leaf matching and raw RPC editing remain out of scope.

List key inputs are shown only for explicitly selected lists and lists on the path to explicitly selected nodes. Selecting an ancestor subtree does not expose keys of lists inside it; existing matches for those nested lists are cleared so the whole subtree is retrieved without those restrictions.

RFC 6243 `:with-defaults` is supported for GET and GET-CONFIG. The capability-driven **With defaults** selector offers the advertised `basic-mode` plus valid modes in `also-supported` (including `report-all-tagged` only when advertised). It is hidden without the capability. **Server default** maps to null and omits the parameter. The choice is session-local and resets on a new connection or capability-set change; it is not saved across devices.

Both preview and execution reject unknown or unadvertised modes. Preview places the RFC 6243 element in `urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults` after the filter, matching installed ncclient 0.7.1 ordering. Execution passes `with_defaults` to `Manager.get` / `Manager.get_config` through the existing active NetconfSession. ncclient retains capability validation, RPC envelopes, message IDs and framing; no additional session, reconnect or custom dispatch is used. COPY-CONFIG remains outside scope.

## Workbench presentation and preferences

`App` retains schema, request intent and latest successful runtime DTOs. `SchemaView` supplies Schema/Last response modes, name/module filtering, the module sidebar and shared inspector. Runtime clicks only inspect; schema checkboxes continue to update schema-based intent. A schema-path index links runtime nodes to full schema metadata without duplicating descriptions/types/defaults into every instance.

`react-resizable-panels` owns accessible horizontal and vertical splitter mechanics. Side pane visibility restores width to the center; the output dock has full-width Preview/Response/Session log tabs, collapse and maximize/restore controls. `RequestBuilder` retains its preview debounce, stale-result protection, validation and execution semantics, rendering outputs into the dock through React portals. Execute opens the Response tab before awaiting the RPC; error replies and transport errors are visible there. Selection and inspection are independent of dock/tab state.

Only non-sensitive pane visibility, splitter layouts, output height/collapse and last output tab persist in localStorage (`workbench.*`). Profiles and passwords never use renderer persistence. Layout preferences do not trigger backend operations.

## Profiles and secure credentials

`electron/profiles.ts` owns a versioned profile file under `app.getPath('userData')`. Profiles contain UUID, displayName, host, port, username and discriminated `auth: { type: "password" }`. A private optional credential field contains base64-encoded Electron `safeStorage.encryptString` output; atomic file replacement uses restrictive file creation permissions. Save, rename/edit, delete and last-selected updates are local-only named, sender-checked IPC operations. Their DTOs contain only public fields and `hasPassword`. The preload exposes getProfiles/saveProfile/selectProfile/deleteProfile, never raw storage or decrypt methods.

Main checks `isEncryptionAvailable()` and, on Linux, `getSelectedStorageBackend()` against libsecret/KWallet backends. It never enables plaintext/basic fallback or implements encryption itself. If secure storage is unavailable, metadata-only profiles/manual transient passwords still work, while credential persistence and saved-credential resolution fail explicitly. Storage exceptions return a generic error without secret-bearing exception text.

Only explicit Connect may resolve a saved credential. A nonempty transient password overrides it without saving. Main verifies host/port/username match the profile before decrypting; endpoint edits cannot silently reuse an unrelated saved credential. A changed endpoint also cannot retain the previous credential on Save without a new password. Main removes profileId before forwarding the existing Python connect command. Backend protocol/NetconfSession ownership is unchanged. Profile mutation is rejected by main while connected and disabled in the UI while busy. No selection/restoration operation sends connect, discovery, probes or RPCs.

## Runtime response parsing

After `NetconfSession.execute_request` returns a successful retrieval, the serialized dispatcher calls `yang/data.py` with the retained `SchemaContext.context`. lxml only unwraps the NETCONF `<data>` envelope; it does not match XML names to schema nodes. The installed libyang-python 5.0 API `Context.parse_data_mem(..., "xml", parse_only=True, strict=True)` parses the payload. `parse_only` avoids complete-datastore validation and implicit defaults; strict mode rejects unknown schema data. No external module-loading callback remains active and parsing cannot retrieve schemas or open sessions.

The serializer traverses libyang DNodes and their actual compiled schema objects. Each DTO carries schemaPath, instancePath, defining module/namespace, kind, canonical value, config flag, ordered keyValues and children. Paths come from `schema.schema_path()` and `node.path()`; the latter also supplies deterministic response-local identity. List keys follow `SList.keys()` order. Canonical scalar text comes from libyang `lyd_get_value` through the pinned binding's CFFI interface, preserving large integer and decimal precision. The temporary libyang data tree is freed after serialization, while the schema context remains active.

The additive execute result fields are `dataNodes` (present on successful parse, including empty data) and `parseWarning` (local parse failure). Raw and formatted XML and rpc-error fields retain their existing backend representations. A parse error does not reject the execution result: raw XML remains available, a concise warning goes to Response and bounded diagnostic details go to Session log. RPC errors skip parsing. The renderer replaces runtime nodes only when dataNodes is present, retains them on RPC/transport/parse failure and Disconnect, and clears them on a new explicit connection attempt or successful schema replacement. Failed schema replacement retains both snapshots. Runtime trees/raw replies are memory-only and clear on renderer reload; schema getters still restore only the backend's existing schema snapshot without network activity.
