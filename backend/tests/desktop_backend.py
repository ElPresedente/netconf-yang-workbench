"""Desktop-test entry point: production backend plus an ephemeral test device.

Only invoked by the smoke script, never by the production application. The
fixture listens on loopback; NetconfSession still connects only on UI action.
"""
import json
import os
import sys
from pathlib import Path
from ncclient.transport import SSHSession
from netconf_backend.main import Backend, serve
from netconf_backend.netconf.session import NetconfSession
from test_netconf_integration import Device


def main():
    device = Device(edit=True)
    report = Path(os.environ['NETCONF_TEST_REPORT'])
    report.write_text(json.dumps({'port': device.port}))

    class TrustedFixtureTransport(SSHSession):
        def connect(self, **kwargs):
            return super().connect(**kwargs, hostkey_b64=device.key.get_base64())

    def factory(emit):
        return Backend(emit, session=NetconfSession(emit, transport_factory=TrustedFixtureTransport))

    try:
        serve(sys.stdin, sys.stdout, factory=factory)
    finally:
        device.close()
        report.write_text(json.dumps({'port': device.port, 'capabilities': device.client_caps,
                                     'requests': device.requests, 'errors': [str(e) for e in device.errors]}))


if __name__ == '__main__':
    main()
