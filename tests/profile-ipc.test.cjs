const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('named profile IPC never connects on restore/select, resolves saved secret only for explicit connect', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-ipc-'));
  const handlers = new Map();
  let secret;
  const electron = { app: { getPath: () => directory }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }, safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => { secret = value; return Buffer.from('opaque'); }, decryptString: () => secret,
  } };
  const load = Module._load;
  Module._load = function(name, ...args) { return name === 'electron' ? electron : load.call(this, name, ...args); };
  const { registerIPC } = require('../dist/electron/ipc');
  Module._load = load;
  const window = new EventEmitter();
  window.webContents = { mainFrame: {}, send() {} }; window.isDestroyed = () => false;
  const backend = new EventEmitter();
  const requests = [];
  backend.request = async (method, params) => { requests.push({ method, params }); return { result: {} }; };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const invoke = (name, params) => handlers.get('netconf:' + name)(event, params);
  try {
    registerIPC(window, backend);
    assert.equal((await invoke('getProfiles')).result.profiles.length, 0);
    const state = await invoke('saveProfile', { displayName: 'Fixture', host: 'router', port: 830, username: 'user', auth: { type: 'password' }, rememberPassword: true, password: 'fixture-secret' });
    const id = state.result.lastSelectedId;
    await invoke('selectProfile', null);
    await invoke('selectProfile', id);
    await invoke('getProfiles');
    assert.deepEqual(requests, []);
    assert.ok(!JSON.stringify(state).includes('fixture-secret'));
    assert.ok(!JSON.stringify(state).includes('opaque'));
    await invoke('connect', { host: 'router', port: 830, username: 'user', password: '', profileId: id });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'connect');
    assert.equal(requests[0].params.password, 'fixture-secret');
    assert.equal('profileId' in requests[0].params, false);
    backend.emit('connection.stateChanged', { state: 'connected' });
    assert.equal((await invoke('selectProfile', null)).error.code, 'profile_busy');
    assert.equal((await invoke('deleteProfile', id)).error.code, 'profile_busy');
    assert.equal(requests.length, 1);
    assert.throws(() => handlers.get('netconf:getProfiles')({ sender: {}, senderFrame: {} }), /Untrusted/);
  } finally {
    window.emit('closed');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
