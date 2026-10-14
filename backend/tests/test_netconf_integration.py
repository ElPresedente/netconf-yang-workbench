"""Local SSH/NETCONF device fixture. Exercises real ncclient base-1.1 framing."""
import pytest
import socket
import threading
from pathlib import Path
from types import SimpleNamespace

import paramiko
from lxml import etree
from ncclient.transport import SSHSession

from netconf_backend.netconf.session import NetconfSession, BASE_11
from netconf_backend.netconf.schema_fetcher import discover, YL
from netconf_backend.yang.context import SchemaContext
from netconf_backend.yang.repository import YangRepository

BASE = "urn:ietf:params:xml:ns:netconf:base:1.0"
MON = "urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"
FIXTURES = Path(__file__).parent / 'fixtures' / 'yang'


class SSHServer(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL

    def get_allowed_auths(self, username):
        return 'password'

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_subsystem_request(self, channel, name):
        return name == 'netconf'


class Device:
    def __init__(self, version='1.1', with_defaults=False, edit=False):
        self.candidate_errors = False
        self.edit = edit
        self.with_defaults = with_defaults
        self.version = version
        self.payloads = []
        self.key = paramiko.RSAKey.generate(2048)
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]
        self.requests = []
        self.client_caps = []
        self.errors = []
        self.transport = None
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        try:
            connection, _ = self.listener.accept()
            self.transport = paramiko.Transport(connection)
            self.transport.add_server_key(self.key)
            self.transport.start_server(server=SSHServer())
            channel = self.transport.accept(10)
            channel.settimeout(10)
            stream = channel.makefile('rb')
            hello = b''
            while not hello.endswith(b']]>]]>'):
                chunk = stream.read(1)
                if not chunk:
                    return
                hello += chunk
            self.client_caps = etree.fromstring(hello[:-6]).xpath('//*[local-name()="capability"]/text()')
            server_hello = f'<hello xmlns="{BASE}"><capabilities><capability>urn:ietf:params:netconf:base:{self.version}</capability><capability>urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&amp;content-id=test</capability><capability>{MON}</capability></capabilities><session-id>42</session-id></hello>]]>]]>'
            if self.with_defaults:
                server_hello = server_hello.replace('</capabilities>', '<capability>urn:ietf:params:netconf:capability:with-defaults:1.0?basic-mode=explicit&amp;also-supported=trim,report-all</capability></capabilities>')
            if self.edit:
                server_hello = server_hello.replace('</capabilities>', ''.join(f'<capability>urn:ietf:params:netconf:capability:{cap}</capability>' for cap in ['candidate:1.0', 'writable-running:1.0', 'validate:1.1', 'rollback-on-error:1.0']) + '</capabilities>')
            channel.sendall(server_hello.encode())
            while True:
                message = b''
                if self.version == '1.0':
                    while not message.endswith(b']]>]]>'):
                        chunk = stream.read(1)
                        if not chunk:
                            return
                        message += chunk
                    message = message[:-6]
                else:
                    while True:
                        line = stream.readline()
                        if not line:
                            return
                        if line == b'\n':
                            continue
                        if line == b'##\n':
                            break
                        assert line.startswith(b'#'), line
                        message += stream.read(int(line[1:]))
                self.payloads.append(message)
                rpc = etree.fromstring(message)
                operation = etree.QName(rpc[0]).localname
                self.requests.append(operation)
                reply = etree.Element(f'{{{BASE}}}rpc-reply', attrib={'message-id': rpc.get('message-id')}, nsmap={None: BASE})
                if operation == 'get':
                    data = etree.SubElement(reply, f'{{{BASE}}}data')
                    if rpc[0].findtext('.//{urn:test:system}name') == 'parse-failure':
                        etree.SubElement(data, '{urn:unknown:fixture}unknown').text = 'unmodeled response'
                    elif rpc[0].find('.//{urn:test:system}system') is not None:
                        system = etree.SubElement(data, '{urn:test:system}system')
                        interface = etree.SubElement(system, '{urn:test:system}interface')
                        etree.SubElement(interface, '{urn:test:system}name').text = 'eth1/1'
                        etree.SubElement(interface, '{urn:test:augment}description').text = 'Fixture uplink'
                    else:
                        library = etree.SubElement(data, f'{{{YL}}}yang-library')
                        module_set = etree.SubElement(library, f'{{{YL}}}module-set')
                        etree.SubElement(module_set, f'{{{YL}}}name').text = 'running'
                        for name, revision in [('test-system', '2026-09-14'), ('test-augment', '2026-09-15')]:
                            mod = etree.SubElement(module_set, f'{{{YL}}}module')
                            etree.SubElement(mod, f'{{{YL}}}name').text = name
                            etree.SubElement(mod, f'{{{YL}}}revision').text = revision
                elif operation in ('commit', 'discard-changes'):
                    if self.candidate_errors:
                        for tag in ['operation-failed', 'access-denied']:
                            error = etree.SubElement(reply, f'{{{BASE}}}rpc-error')
                            for name, value in [('error-type', 'application'), ('error-tag', tag), ('error-severity', 'error'), ('error-message', 'Fixture denied candidate action')]:
                                etree.SubElement(error, f'{{{BASE}}}{name}').text = value
                    else:
                        etree.SubElement(reply, f'{{{BASE}}}ok')
                elif operation == 'edit-config':
                    if rpc[0].findtext('.//{urn:test:system}mtu') == 'error':
                        for tag in ['invalid-value', 'operation-failed']:
                            error = etree.SubElement(reply, f'{{{BASE}}}rpc-error')
                            for name, value in [('error-type', 'application'), ('error-tag', tag), ('error-severity', 'error'), ('error-app-tag', 'edit-fixture'), ('error-path', '/system/interface/mtu'), ('error-message', 'Fixture denied edit'), ('error-info', 'details')]:
                                etree.SubElement(error, f'{{{BASE}}}{name}').text = value
                    else:
                        etree.SubElement(reply, f'{{{BASE}}}ok')
                elif operation == 'get-config' and self.edit and rpc[0].find(f'{{{BASE}}}source/{{{BASE}}}candidate') is not None:
                    data = etree.SubElement(reply, f'{{{BASE}}}data')
                    system = etree.SubElement(data, '{urn:test:system}system')
                    interface = etree.SubElement(system, '{urn:test:system}interface')
                    etree.SubElement(interface, '{urn:test:system}name').text = 'eth1/1'
                    etree.SubElement(interface, '{urn:test:system}mtu').text = '1500'
                    etree.SubElement(interface, '{urn:test:augment}description').text = 'Fixture uplink'
                elif operation == 'get-config':
                    error = etree.SubElement(reply, f'{{{BASE}}}rpc-error')
                    for name, value in [('error-type', 'application'), ('error-tag', 'operation-failed'), ('error-severity', 'error'), ('error-app-tag', 'fixture'), ('error-path', '/system'), ('error-message', 'Fixture denied read'), ('error-info', 'details')]:
                        etree.SubElement(error, f'{{{BASE}}}{name}').text = value
                elif operation == 'get-schema':
                    name = rpc[0].findtext(f'{{{MON}}}identifier')
                    etree.SubElement(reply, f'{{{MON}}}data').text = (FIXTURES / f'{name}.yang').read_text()
                elif operation in ('ping', 'clear-lldp-counters', 'complex'):
                    if getattr(self, 'rpc_errors', False):
                        for tag in ['operation-failed', 'access-denied']:
                            error = etree.SubElement(reply, f'{{{BASE}}}rpc-error')
                            etree.SubElement(error, f'{{{BASE}}}error-tag').text = tag
                    elif getattr(self, 'rpc_unexpected', False):
                        etree.SubElement(reply, '{urn:unknown}unexpected')
                    elif operation == 'complex':
                        result = etree.SubElement(reply, '{urn:test:rpc}result')
                        etree.SubElement(result, '{urn:test:rpc}count').text = '0'
                    elif operation == 'clear-lldp-counters':
                        etree.SubElement(reply, '{urn:test:system}cleared').text = '2'
                    else:
                        etree.SubElement(reply, f'{{{BASE}}}ok')
                elif operation == 'close-session':
                    etree.SubElement(reply, f'{{{BASE}}}ok')
                else:
                    raise AssertionError(f'Unexpected RPC {operation}')
                payload = etree.tostring(reply)
                channel.sendall(payload + b']]>]]>' if self.version == '1.0' else b'\n#' + str(len(payload)).encode() + b'\n' + payload + b'\n##\n')
                if operation == 'close-session':
                    return
        except Exception as exc:
            self.errors.append(exc)
        finally:
            if self.transport:
                self.transport.close()

    def close(self):
        if self.transport:
            self.transport.close()
        self.listener.close()
        self.thread.join(3)


@pytest.mark.parametrize('with_defaults', [False, True])
@pytest.mark.parametrize('version', ['1.0', '1.1'])
def test_real_ssh_discover_download_compile_disconnect(tmp_path, version, with_defaults):
    device = Device(version, with_defaults)
    events = []

    class TrustedTestTransport(SSHSession):
        def connect(self, **kwargs):
            # Trust only this ephemeral fixture key, retaining host-key checking.
            return super().connect(**kwargs, hostkey_b64=device.key.get_base64())

    session = NetconfSession(lambda event, data: events.append((event, data)), transport_factory=TrustedTestTransport)
    schema = SchemaContext()
    try:
        assert session.info()['state'] == 'disconnected'
        assert not device.client_caps
        info = session.connect({'host': '127.0.0.1', 'port': device.port, 'username': 'test', 'password': 'test-password'})
        assert info['sessionId'] == '42'
        assert BASE_11 in device.client_caps
        assert 'urn:ietf:params:netconf:base:1.0' in device.client_caps
        assert info['protocolVersion'] == version
        assert not device.requests  # Connect never triggers schema loading.
        specs = discover(session)
        result = schema.compile(specs, YangRepository('127.0.0.1', device.port, tmp_path), session)
        assert result['modulesDownloaded'] == 2
        assert result['modulesLoaded'] == 2
        assert [node['name'] for node in schema.tree['roots']] == ['system']
        system = next(n for n in schema.tree['roots'] if n['name'] == 'system')
        assert any(n['name'] == 'enabled' for n in system['children'])
        interface = next(n for n in system['children'] if n['name'] == 'interface')
        assert any(n['name'] == 'description' and n['namespace'] == 'urn:test:augment' for n in interface['children'])
        from netconf_backend.main import Backend
        backend = Backend(session.emit, session=session, schema=schema)
        intent = {'operation': 'get', 'datastore': None, 'selectedPaths': [interface['children'][0]['path']], 'listKeyValues': {interface['path']: {'name': 'eth1/1'}}}
        intent['withDefaults'] = 'trim' if with_defaults else None
        before = list(device.requests)
        preview = backend.dispatch('request.preview', intent)
        assert device.requests == before
        response = backend.dispatch('request.execute', intent)
        assert 'rpc-reply' in response['xml']
        assert response['dataNodes'][0]['children'][0]['keyValues'] == {'name': 'eth1/1'}
        sent = etree.fromstring(device.payloads[-1])[0]
        def semantic(node):
            return (node.tag, dict(node.attrib), node.text if node.text and node.text.strip() else None, [semantic(c) for c in node])
        assert semantic(sent) == semantic(etree.fromstring(preview['xml'].encode()))
        result = backend.dispatch('request.execute', {**intent, 'operation': 'get-config', 'datastore': 'running'})
        sent_config = etree.fromstring(device.payloads[-1])[0]
        wd = sent_config.find('{urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults}with-defaults')
        assert (wd.text if wd is not None else None) == intent['withDefaults']
        assert result['errors'][0]['error-app-tag'] == 'fixture'
        assert 'error-info' in result['errors'][0]
        assert session.info()['sessionId'] == info['sessionId']
        session.disconnect()
        assert device.requests == ['get', 'get-schema', 'get-schema', 'get', 'get-config', 'close-session']
        assert session.info()['state'] == 'disconnected'
        assert 'test-password' not in str(events)
        assert not device.errors
    finally:
        session.disconnect()
        schema.clear()
        device.close()


@pytest.mark.parametrize('version', ['1.0', '1.1'])
def test_edit_real_session(tmp_path, version):
    from netconf_backend.main import Backend
    from test_edits import intent, change
    device = Device(version, edit=True)
    connects = []
    class TrustedTransport(SSHSession):
        def connect(self, **kwargs):
            connects.append(1)
            return super().connect(**kwargs, hostkey_b64=device.key.get_base64())
    session = NetconfSession(lambda *args: None, transport_factory=TrustedTransport)
    schema = SchemaContext()
    try:
        session.connect({'host': '127.0.0.1', 'port': device.port, 'username': 'test', 'password': 'test'})
        schema.compile(discover(session), YangRepository('127.0.0.1', device.port, tmp_path), session)
        backend = Backend(session.emit, session=session, schema=schema)
        manager = session.require_connected()
        for target in ['candidate', 'running']:
            for test in [None, 'set', 'test-then-set', 'test-only']:
                params = {**intent(change(), testOption=test, errorOption='rollback-on-error'), 'target': target}
                before = device.requests[:]
                preview = backend.dispatch('edit.preview', params)
                assert device.requests == before
                reply = backend.dispatch('edit.execute', params)
                assert not reply['errors'] and '<ok' in reply['rawXml']
                assert device.requests == before + ['edit-config']
                def semantic(node):
                    return node.tag, dict(node.attrib), (node.text or '').strip(), [semantic(c) for c in node]
                assert semantic(etree.fromstring(device.payloads[-1])[0]) == semantic(etree.fromstring(preview['xml'].encode()))
                assert session.require_connected() is manager
        result = backend.dispatch('edit.execute', intent(change(value='error')))
        assert len(result['errors']) == 2
        assert all(len(error) == 7 for error in result['errors'])
        assert [e['error-tag'] for e in result['errors']] == ['invalid-value', 'operation-failed']
        assert result['rawXml'].count('<rpc-error>') == 2
        assert connects == [1]
        assert 'commit' not in device.requests
        session.disconnect()
        assert not device.errors
    finally:
        session.disconnect()
        schema.clear()
        device.close()


@pytest.mark.parametrize('version', ['1.0', '1.1'])
def test_candidate_real_session_without_schema(version):
    from netconf_backend.main import Backend
    device = Device(version, edit=True)
    connects = []
    class TrustedTransport(SSHSession):
        def connect(self, **kwargs):
            connects.append(1)
            return super().connect(**kwargs, hostkey_b64=device.key.get_base64())
    session = NetconfSession(lambda *args: None, transport_factory=TrustedTransport)
    backend = Backend(session.emit, session=session)
    try:
        session.connect({'host': '127.0.0.1', 'port': device.port, 'username': 'test', 'password': 'test'})
        manager = session.require_connected()
        assert device.requests == []
        for errors in [False, True]:
            device.candidate_errors = errors
            for action, wire in [('commit', 'commit'), ('discard', 'discard-changes')]:
                before = device.requests[:]
                reply = backend.dispatch('candidate.' + action, {})
                assert len(reply['errors']) == (2 if errors else 0)
                assert reply['rawXml'].count('<rpc-error>') == (2 if errors else 0)
                assert device.requests == before + [wire]
                rpc = etree.fromstring(device.payloads[-1])
                assert rpc[0].tag == f'{{{BASE}}}{wire}'
                assert len(rpc[0]) == 0  # No confirmed-commit or other arguments.
                assert session.require_connected() is manager
        session.disconnect()
        assert device.requests == ['commit', 'discard-changes', 'commit', 'discard-changes', 'close-session']
        assert connects == [1]
        assert not device.errors
    finally:
        session.disconnect()
        backend.schema.clear()
        device.close()


@pytest.mark.parametrize('version', ['1.0', '1.1'])
def test_yang_rpc_same_session(tmp_path, version):
    from netconf_backend.main import Backend
    from netconf_backend.netconf.schema_fetcher import ModuleSpec
    from test_yang_rpc import intent
    device = Device(version)
    class TrustedTransport(SSHSession):
        def connect(self, **kwargs):
            return super().connect(**kwargs, hostkey_b64=device.key.get_base64())
    session = NetconfSession(lambda *args: None, transport_factory=TrustedTransport)
    schema = SchemaContext()
    backend = Backend(session.emit, session, schema)
    try:
        session.connect({'host': '127.0.0.1', 'port': device.port, 'username': 'test', 'password': 'test'})
        manager = session.require_connected()
        assert device.requests == []
        schema.compile([ModuleSpec('test-rpc'), ModuleSpec('test-system')], YangRepository('rpc-test', device.port, tmp_path), session)
        before = list(device.requests)
        ping = intent(schema, name='ping')
        for _ in range(3):
            assert '<ping' in backend.dispatch('yangRpc.preview', ping)['xml']
        assert device.requests == before
        result = backend.dispatch('yangRpc.execute', ping)
        assert result['rpcOutput'] == [] and not result['errors']
        complex_intent = intent(schema, {'required': 'x'})
        preview = backend.dispatch('yangRpc.preview', complex_intent)['xml']
        result = backend.dispatch('yangRpc.execute', complex_intent)
        assert result['rpcOutput'][0]['children'][0]['value'] == '0'
        assert etree.tostring(etree.fromstring(device.payloads[-1])[0], method='c14n', exclusive=True) == etree.tostring(etree.fromstring(preview.encode(), etree.XMLParser(remove_blank_text=True)), method='c14n', exclusive=True)
        device.rpc_unexpected = True
        result = backend.dispatch('yangRpc.execute', complex_intent)
        assert 'parseWarning' in result and 'unexpected' in result['rawXml'] and not result['errors']
        device.rpc_unexpected = False; device.rpc_errors = True
        result = backend.dispatch('yangRpc.execute', ping)
        assert len(result['errors']) == 2 and result['rawXml'].count('<rpc-error>') == 2
        device.rpc_errors = False
        op = next(o for o in schema.tree['operations'] if o['module'] == 'test-system' and o['name'] == 'clear-lldp-counters')
        from test_yang_rpc import instance
        params = {'operation': op['id'], 'nodes': [instance(n, 'false' if n['type'] == 'boolean' else 'ETH1/1') for n in op['input']]}
        preview = backend.dispatch('yangRpc.preview', params)['xml']
        assert '<input' not in preview and 'ETH1/1' in preview
        assert backend.dispatch('yangRpc.execute', params)['rpcOutput'][0]['value'] == '2'
        assert session.require_connected() is manager
        assert device.requests[len(before):] == ['ping', 'complex', 'complex', 'ping', 'clear-lldp-counters']
        session.disconnect()
        assert device.requests[-1] == 'close-session'
    finally:
        session.disconnect(); schema.clear(); device.close()
    assert not device.errors
