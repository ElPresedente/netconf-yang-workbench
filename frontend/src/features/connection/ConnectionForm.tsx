import { useEffect, useState, type FormEvent } from 'react';
import type { ConnectionInfo, ConnectionParams, ProfileState } from '../../../../shared/types';

import { api, unwrap } from '../../api/netconf-api';

interface Props {
  info: ConnectionInfo; ready: boolean; busy: boolean;
  connect: (params: ConnectionParams) => Promise<void>; disconnect: () => void;
}
export function ConnectionForm({ info, ready, busy, connect, disconnect }: Props) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(830);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [profiles, setProfiles] = useState<ProfileState>({ profiles: [], lastSelectedId: null, secureStorageAvailable: false });
  const [profileId, setProfileId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [remember, setRemember] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const selected = profiles.profiles.find(p => p.id === profileId);
  function apply(state: ProfileState) {
    setProfiles(state); setProfileId(state.lastSelectedId); setPassword('');
    const p = state.profiles.find(p => p.id === state.lastSelectedId);
    setDisplayName(p?.displayName || ''); setRemember(!!p?.hasPassword && state.secureStorageAvailable);
    if (p) { setHost(p.host); setPort(p.port); setUsername(p.username); }
  }
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.getProfiles().then(result => { if (alive) apply(unwrap(result)); }).catch(() => { if (alive) setProfileError('Could not load device profiles. Manual connections remain available.'); });
    return () => { alive = false; };
  }, []);
  async function profileAction(action: () => Promise<ProfileState>) {
    setProfileBusy(true); setProfileError('');
    try { apply(await action()); } catch (e) { setProfileError(e instanceof Error ? e.message : 'Profile operation failed'); }
    finally { setProfileBusy(false); }
  }
  const matches = selected && selected.host === host.trim() && selected.port === port && selected.username === username;
  const disabled = profileBusy || busy || info.state !== 'disconnected';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || disabled) return;
    const secret = password;
    setPassword('');
    void connect({ host: host.trim(), port, username, password: secret, authMode: 'password', ...(matches ? { profileId: selected.id } : {}) });
  };
  return <section className="connection">
    <form onSubmit={submit}>
      <label>Device<select aria-label="Device profile" disabled={disabled} value={profileId || ''} onChange={e => void profileAction(async () => unwrap(await api.selectProfile(e.target.value || null)))}><option value="">Manual connection</option>{profiles.profiles.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
      <label>Host<input required value={host} onChange={e => setHost(e.target.value)} disabled={disabled} placeholder="Device hostname or IP" autoComplete="off" /></label>
      <label className="port">Port<input required type="number" min="1" max="65535" value={port} onChange={e => setPort(Number(e.target.value))} disabled={disabled} /></label>
      <label>Username<input required value={username} onChange={e => setUsername(e.target.value)} disabled={disabled} autoComplete="off" /></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} disabled={disabled} autoComplete="off" placeholder={matches && selected.hasPassword ? "Saved credential · type to override" : "Enter password"} /></label>
      <button type="submit" disabled={!ready || disabled}>{info.state === 'connecting' ? 'Connecting…' : 'Connect'}</button>
      <button type="button" onClick={disconnect} disabled={busy || info.state !== 'connected'}>Disconnect</button>
    </form>
    <details className="profile-editor"><summary>Device profiles{selected?.hasPassword ? ' · saved credential' : ''}</summary>
      <div className="profile-fields">
        <label>Profile name<input aria-label="Profile name" disabled={disabled} value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Name / rename profile" /></label>
        <label className="remember"><input type="checkbox" checked={remember} disabled={disabled || !profiles.secureStorageAvailable} onChange={e => setRemember(e.target.checked)} />Remember password</label>
        {!profiles.secureStorageAvailable && <span>Secure credential storage unavailable; passwords cannot be saved.</span>}
        <button type="button" disabled={disabled} onClick={() => void profileAction(async () => unwrap(await api.selectProfile(null)))}>New profile</button>
        <button type="button" disabled={disabled || !displayName.trim() || !host.trim() || !username.trim()} onClick={() => void profileAction(async () => unwrap(await api.saveProfile({ ...(profileId ? { id: profileId } : {}), displayName, host: host.trim(), port, username, auth: { type: 'password' }, rememberPassword: remember, password })))}>Save profile</button>
        <button type="button" disabled={disabled || !profileId} onClick={() => void profileAction(async () => unwrap(await api.deleteProfile(profileId!)))}>Delete profile</button>
      </div>
    </details>
    {profileError && <p role="alert" className="error">{profileError}</p>}
    <div className="session-line"><strong className={`state ${info.state}`}>{info.state.toUpperCase()}</strong>
      <span>{info.host ? `${info.host}:${info.port}` : 'No device selected'}</span>
      <span>Session ID: <code>{info.sessionId || '—'}</code></span>
      <span>{info.protocolVersion ? `NETCONF ${info.protocolVersion}` : 'NETCONF'} · explicit sessions</span>
    </div>
    <details className="capabilities"><summary>Server capabilities ({info.capabilities.length})</summary>
      <ul>{info.capabilities.map(c => <li key={c}><code>{c}</code></li>)}</ul>
    </details>
  </section>;
}
