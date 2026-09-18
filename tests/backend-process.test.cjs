const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { BackendProcess } = require('../dist/electron/backend-process');

test('Python bridge: readiness, correlated responses, validation, clean shutdown', async () => {
  const backend = new BackendProcess();
  const statuses = [];
  backend.on('backend.status', s => statuses.push(s));
  const ready = once(backend, 'backend.status');
  backend.start(path.resolve(__dirname, '..'));
  await ready;
  try {
    assert.equal(backend.status.ready, true, backend.status.error);
    const [state, modules, rejected] = await Promise.all([
      backend.request('connection.getState'), backend.request('schema.getModules'), backend.request('unknown'),
    ]);
    assert.equal(state.result.state, 'disconnected');
    assert.deepEqual(modules.result, []);
    assert.equal(rejected.error.code, 'invalid_request');
    const fetch = await backend.request('schema.fetch');
    assert.equal(fetch.error.code, 'not_connected');
  } finally {
    const pid = backend.child.pid;
    await backend.stop();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  assert.equal(statuses.at(-1).ready, false);
});

test('missing Python produces an error and shutdown completes', async () => {
  const old = process.env.NETCONF_PYTHON;
  process.env.NETCONF_PYTHON = '/missing-netconf-test-python';
  const backend = new BackendProcess();
  const failed = once(backend, 'backend.status');
  backend.start(path.resolve(__dirname, '..'));
  if (old === undefined) delete process.env.NETCONF_PYTHON;
  else process.env.NETCONF_PYTHON = old;
  await failed;
  assert.equal(backend.status.ready, false);
  assert.match(backend.status.error, /failed to start/);
  await backend.stop();
});
