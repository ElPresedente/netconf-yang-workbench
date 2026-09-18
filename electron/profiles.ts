import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectionParams, DeviceProfile, ProfileSave, ProfileState } from '../shared/types';

type Storage = Pick<Electron.SafeStorage, 'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'>;
type Stored = Omit<DeviceProfile, 'hasPassword'> & { credential?: string };

/** Main-process only. Neither ciphertext nor decrypted credentials leave this boundary except connect. */
export class ProfileStore {
  private profiles: Stored[] = [];
  private lastSelectedId: string | null = null;
  private file: string;
  constructor(directory: string, private secure: Storage, private platform = process.platform) {
    this.file = path.join(directory, 'device-profiles.json');
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.profiles)) throw new Error('Invalid profile store');
      this.profiles = data.profiles.map((p: Stored) => {
        this.validate(p);
        if (typeof p.id !== 'string' || (p.credential !== undefined && typeof p.credential !== 'string')) throw new Error('Invalid profile store');
        return { id: p.id, displayName: p.displayName, host: p.host, port: p.port, username: p.username, auth: { type: 'password' }, ...(p.credential ? { credential: p.credential } : {}) };
      });
      this.lastSelectedId = this.profiles.some(p => p.id === data.lastSelectedId) ? data.lastSelectedId : null;
    }
  }
  available() {
    return this.secure.isEncryptionAvailable() && (this.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.secure.getSelectedStorageBackend()));
  }
  state(): ProfileState {
    return { profiles: this.profiles.map(({ credential, ...p }) => ({ ...p, hasPassword: !!credential })), lastSelectedId: this.lastSelectedId, secureStorageAvailable: this.available() };
  }
  private validate(p: Omit<ProfileSave, 'rememberPassword'>) {
    if (!p || !['displayName', 'host', 'username'].every(k => typeof p[k as keyof typeof p] === 'string' && String(p[k as keyof typeof p]).trim().length > 0 && String(p[k as keyof typeof p]).length <= 4096) || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535 || p.auth?.type !== 'password') throw new Error('Invalid profile fields');
  }
  private write(profiles: Stored[], lastSelectedId: string | null) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, profiles, lastSelectedId }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.profiles = profiles; this.lastSelectedId = lastSelectedId;
    return this.state();
  }
  save(input: ProfileSave) {
    this.validate(input);
    if (typeof input.rememberPassword !== 'boolean' || (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 4096))) throw new Error('Invalid credential options');
    const old = this.profiles.find(p => p.id === input.id);
    if (input.id && !old) throw new Error('Profile does not exist');
    const profile: Stored = { id: old?.id || randomUUID(), displayName: input.displayName.trim(), host: input.host.trim(), port: input.port, username: input.username, auth: { type: 'password' } };
    if (input.rememberPassword) {
      if (!this.available()) throw new Error('Secure credential storage is unavailable');
      if (input.password) profile.credential = this.secure.encryptString(input.password).toString('base64');
      else if (old?.credential && old.host === profile.host && old.port === profile.port && old.username === profile.username) profile.credential = old.credential;
      else throw new Error('Enter a password to remember for this endpoint');
    }
    return this.write([...this.profiles.filter(p => p.id !== profile.id), profile], profile.id);
  }
  select(id: string | null) {
    if (id !== null && !this.profiles.some(p => p.id === id)) throw new Error('Profile does not exist');
    return this.write(this.profiles, id);
  }
  delete(id: string) {
    if (!this.profiles.some(p => p.id === id)) throw new Error('Profile does not exist');
    return this.write(this.profiles.filter(p => p.id !== id), this.lastSelectedId === id ? null : this.lastSelectedId);
  }
  resolve(input: ConnectionParams): ConnectionParams {
    const { profileId, ...params } = input;
    if (!profileId) return params;
    const profile = this.profiles.find(p => p.id === profileId);
    if (!profile || params.host !== profile.host || params.port !== profile.port || params.username !== profile.username) throw new Error('Profile endpoint changed; save it or use a manual connection');
    if (!params.password && profile.credential) {
      if (!this.available()) throw new Error('Secure credential storage is unavailable; enter a password');
      return { ...params, password: this.secure.decryptString(Buffer.from(profile.credential, 'base64')) };
    }
    return params;
  }
}
