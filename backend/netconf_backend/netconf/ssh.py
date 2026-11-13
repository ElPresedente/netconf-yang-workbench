"""Compatibility with RSA SHA-2 negotiation in ncclient 0.7.1."""
from ncclient.transport import SSHSession as BaseSSHSession
from paramiko import HostKeys


class RSAHostKeys(HostKeys):
    def lookup(self, hostname):
        keys = super().lookup(hostname)
        if keys is None:
            return None
        # ncclient uses these names both for trust lookup and for its list of
        # preferred signature algorithms. An ssh-rsa public key also supports
        # SHA-2 signatures; the key bytes and trust decision remain identical.
        result = {}
        if 'ssh-rsa' in keys:
            result.update({'rsa-sha2-512': keys['ssh-rsa'],
                           'rsa-sha2-256': keys['ssh-rsa']})
        result.update(keys)
        return result


class SSHSession(BaseSSHSession):
    def __init__(self, device_handler):
        super().__init__(device_handler)
        # Installed before ncclient loads known_hosts. No trust file is changed.
        self._host_keys = RSAHostKeys()
