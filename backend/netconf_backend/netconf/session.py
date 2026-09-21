"""The sole owner of the single explicit NETCONF connection."""
import threading
from datetime import datetime, timezone
from typing import Callable

from ncclient.devices.default import DefaultDeviceHandler
from ncclient.manager import Manager
from ncclient.transport import SSHSession
from ncclient.transport.errors import AuthenticationError, SSHUnknownHostError
from ncclient.transport.session import SessionListener
from ncclient.operations.rpc import RPCError, RaiseMode
from lxml import etree

from ..protocol.rpc import BackendError

BASE_11 = "urn:ietf:params:netconf:base:1.1"


class Listener(SessionListener):
    def __init__(self, owner, transport):
        self.owner, self.transport = owner, transport

    def callback(self, root, raw):
        self.owner.log("NETCONF reply", direction="rx", payload=raw)

    def errback(self, ex):
        self.owner.transport_lost(self.transport)


class NetconfSession:
    def __init__(self, emit: Callable, transport_factory=SSHSession, manager_factory=Manager):
        self.emit = emit
        self.transport_factory, self.manager_factory = transport_factory, manager_factory
        self._transport = None
        self._manager = None
        self._lock = threading.RLock()
        self._state = "disconnected"
        self.endpoint: tuple[str, int] | None = None

    def log(self, message, *, level="info", direction=None, payload=None):
        self.emit("log.entry", {"timestamp": datetime.now(timezone.utc).isoformat(),
                  "level": level, "message": message, "direction": direction,
                  "payload": payload[:100_000] if payload else None})

    def info(self):
        with self._lock:
            m = self._manager
            return {"state": self._state,
                    "sessionId": str(m.session_id) if m and self._state == "connected" else None,
                    "capabilities": list(m.server_capabilities) if m and self._state == "connected" else [],
                    "protocolVersion": ("1.1" if BASE_11 in m.server_capabilities else "1.0") if m and self._state == "connected" else None,
                    "host": self.endpoint[0] if self.endpoint else None,
                    "port": self.endpoint[1] if self.endpoint else None}

    def _change(self, state):
        self._state = state
        self.emit("connection.stateChanged", self.info())

    def connect(self, params):
        with self._lock:
            if self._state != "disconnected":
                raise BackendError("already_connected", "Disconnect before connecting again")
            self.endpoint = (params["host"].strip(), params["port"])
            self._change("connecting")
            handler = DefaultDeviceHandler()
            transport = self.transport_factory(handler)
            self._transport = transport
        self.log(f"Connecting to {self.endpoint[0]}:{self.endpoint[1]}")
        try:
            # This is the only connection-opening call in the application.
            transport.connect(host=self.endpoint[0], port=self.endpoint[1],
                              username=params["username"], password=params["password"],
                              timeout=20, allow_agent=False, look_for_keys=False,
                              hostkey_verify=True)
            with self._lock:
                self._manager = self.manager_factory(transport, handler, timeout=30)
                transport.add_listener(Listener(self, transport))
                if not transport.connected:
                    raise BackendError("connection_failed", "Connection closed during NETCONF handshake")
                self._change("connected")
            self.log(f"NETCONF {self.info()['protocolVersion']} session established")
            return self.info()
        except Exception as exc:
            self._close_transport(transport)
            with self._lock:
                self._transport = self._manager = None
                self._change("disconnected")
            if isinstance(exc, BackendError):
                raise
            if isinstance(exc, AuthenticationError):
                raise BackendError("authentication_failed", "SSH authentication failed") from None
            if isinstance(exc, SSHUnknownHostError):
                raise BackendError("connection_failed", "SSH host key is unknown or changed; verify the device key in ~/.ssh/known_hosts") from None
            # Do not echo library exception text: it could contain credentials.
            raise BackendError("connection_failed", f"Connection failed ({type(exc).__name__}); check host, port and SSH/NETCONF service") from None

    @staticmethod
    def _close_transport(transport):
        if transport is None or transport.transport is None:
            return
        # ncclient.close() can join its reader indefinitely. First close the SSH
        # socket synchronously, then bound the reader cleanup wait.
        if transport.transport is not None:
            transport.transport.close()
        thread = threading.Thread(target=transport.close, daemon=True)
        thread.start()
        thread.join(2)

    def transport_lost(self, transport):
        with self._lock:
            if transport is not self._transport or self._state != "connected":
                return
            if transport.transport is not None:
                transport.transport.close()
            self._manager = self._transport = None
            self._change("disconnected")
        self.log("NETCONF transport closed; reconnect requires Connect", level="error")
        self.emit("connection.closed", {"reason": "Transport closed"})

    def disconnect(self):
        with self._lock:
            if self._state == "disconnected":
                return self.info()
            self._change("disconnecting")
            manager, transport = self._manager, self._transport
        try:
            if manager and transport.connected:
                manager.timeout = 3
                self.log("Sending close-session", direction="tx")
                manager.close_session()
        except Exception:
            self.log("close-session did not complete; closing SSH transport", level="warning")
        finally:
            self._close_transport(transport)
            with self._lock:
                self._manager = self._transport = None
                self._change("disconnected")
        self.log("Disconnected")
        return self.info()

    def require_connected(self):
        with self._lock:
            if self._state != "connected" or self._manager is None:
                raise BackendError("not_connected", "Connect to a device first")
            return self._manager

    def _rpc(self, method, **kwargs):
        manager = self.require_connected()
        try:
            return getattr(manager, method)(**kwargs)
        except RPCError as exc:
            raise BackendError("netconf_error", "Device rejected the NETCONF operation", exc.message) from None
        except Exception as exc:
            if self._transport and not self._transport.connected:
                self.transport_lost(self._transport)
            raise BackendError("netconf_error", f"NETCONF operation failed ({type(exc).__name__})") from None

    def get(self, subtree):
        self.log("Schema inventory query", direction="tx", payload="\n".join(subtree) if isinstance(subtree, list) else subtree)
        return self._rpc("get", filter=subtree if isinstance(subtree, list) else ("subtree", subtree)).data_xml

    def get_schema(self, name, revision=None):
        self.log(f"get-schema {name}@{revision or 'latest'}", direction="tx")
        return self._rpc("get_schema", identifier=name, version=revision, format="yang").data

    def execute_request(self, operation, datastore, filter_node, preview, with_defaults=None):
        manager = self.require_connected()
        self.log("Request builder: " + operation, direction="tx", payload=preview)
        previous = manager.raise_mode
        try:
            manager.raise_mode = RaiseMode.NONE
            kwargs = {"filter": filter_node, "with_defaults": with_defaults}
            if operation == 'get-config':
                kwargs['source'] = datastore
            reply = self._rpc('get' if operation == 'get' else 'get_config', **kwargs)
            return self._reply_result(reply)
        finally:
            manager.raise_mode = previous

    @staticmethod
    def _reply_result(reply):
        raw = reply.xml
        root = etree.fromstring(raw.encode(), etree.XMLParser(resolve_entities=False, no_network=True))
        errors = [{etree.QName(c).localname: (etree.tostring(c, encoding='unicode') if etree.QName(c).localname == 'error-info' else ''.join(c.itertext())) for c in error}
                  for error in root.findall('{urn:ietf:params:xml:ns:netconf:base:1.0}rpc-error')]
        return {"xml": etree.tostring(root, encoding='unicode', pretty_print=True), "rawXml": raw, "errors": errors}

    def execute_edit(self, params, config, preview):
        manager = self.require_connected()
        self.log("Edit draft: edit-config", direction="tx", payload=preview)
        previous = manager.raise_mode
        try:
            manager.raise_mode = RaiseMode.NONE
            kwargs = {"target": params["target"], "config": config}
            for field, argument in [("defaultOperation", "default_operation"), ("testOption", "test_option"), ("errorOption", "error_option")]:
                if params.get(field) is not None:
                    kwargs[argument] = params[field]
            return self._reply_result(self._rpc('edit_config', **kwargs))
        finally:
            manager.raise_mode = previous

    def execute_candidate(self, action):
        manager = self.require_connected()
        if action not in ('commit', 'discard'):
            raise BackendError('invalid_request', 'Unknown candidate action')
        capabilities = {str(c).split('?', 1)[0] for c in manager.server_capabilities}
        if 'urn:ietf:params:netconf:capability:candidate:1.0' not in capabilities:
            raise BackendError('invalid_request', 'Candidate actions require :candidate')
        method = 'commit' if action == 'commit' else 'discard_changes'
        self.log('Candidate: ' + ('commit' if action == 'commit' else 'discard-changes'), direction='tx')
        previous = manager.raise_mode
        try:
            manager.raise_mode = RaiseMode.NONE
            # Public ncclient APIs own the RPC envelope and use the existing manager.
            return self._reply_result(self._rpc(method))
        finally:
            manager.raise_mode = previous
