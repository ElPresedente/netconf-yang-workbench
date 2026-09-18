const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../dist/electron/profiles');

// Test double simulates opaque OS storage. Production uses only Electron safeStorage.
function secure(backend = 'gnome_libsecret', available = true) {
  let secret;
  return { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
    encryptString: value => { secret = value; return Buffer.from('opaque-os-credential'); },
    decryptString: () => secret };
}
function fixture(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-'));
  try { fn(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
const fields = { displayName: 'Lab', host: 'router', port: 830, username: 'user', auth: { type: 'password' }, rememberPassword: false };

test('profile CRUD, last selection, nonsecret restore and credential isolation', () => fixture(directory => {
  const storage = secure();
  const store = new ProfileStore(directory, storage, 'linux');
  let state = store.save(fields);
  const id = state.lastSelectedId;
  assert.equal(state.profiles[0].hasPassword, false);
  state = store.save({ ...fields, id, displayName: 'Renamed', rememberPassword: true, password: 'test-only-secret' });
  assert.equal(state.profiles[0].hasPassword, true);
  assert.equal(state.profiles[0].displayName, 'Renamed');
  const disk = fs.readFileSync(path.join(directory, 'device-profiles.json'), 'utf8');
  assert.ok(!disk.includes('test-only-secret'));
  assert.ok(!JSON.stringify(state).includes('opaque-os-credential'));
  assert.ok(!JSON.stringify(state).includes('test-only-secret'));
  const restored = new ProfileStore(directory, storage, 'linux');
  assert.deepEqual(restored.state(), state);
  const params = { host: 'router', port: 830, username: 'user', password: '', profileId: id };
  assert.equal(restored.resolve(params).password, 'test-only-secret');
  assert.equal(restored.resolve({ ...params, password: 'temporary' }).password, 'temporary');
  assert.equal(restored.resolve(params).password, 'test-only-secret');
  assert.throws(() => restored.resolve({ ...params, host: 'other' }));
  restored.select(null);
  assert.equal(new ProfileStore(directory, storage, 'linux').state().lastSelectedId, null);
  restored.select(id);
  restored.save({ ...fields, id });
  assert.equal(restored.state().profiles[0].hasPassword, false);
  assert.ok(!fs.readFileSync(path.join(directory, 'device-profiles.json'), 'utf8').includes('opaque-os-credential'));
  restored.delete(id);
  assert.deepEqual(restored.state().profiles, []);
  assert.equal(restored.state().lastSelectedId, null);
}));

for (const [backend, available] of [['basic_text', true], ['unknown', true], ['gnome_libsecret', false]]) {
  test('insecure/unavailable storage blocks credential persistence: ' + backend, () => fixture(directory => {
    const store = new ProfileStore(directory, secure(backend, available), 'linux');
    assert.equal(store.state().secureStorageAvailable, false);
    assert.throws(() => store.save({ ...fields, rememberPassword: true, password: 'test-only-secret' }));
    assert.equal(store.save(fields).profiles[0].hasPassword, false);
  }));
}
test('endpoint edits cannot silently carry credentials to another host', () => fixture(directory => {
  const store = new ProfileStore(directory, secure(), 'linux');
  const id = store.save({ ...fields, rememberPassword: true, password: 'test-only-secret' }).lastSelectedId;
  assert.throws(() => store.save({ ...fields, id, host: 'other', rememberPassword: true }));
  assert.equal(store.state().profiles[0].host, 'router');
}));
