import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'netconf-desktop-'));
let app;
let backendPid;
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], timeout: 30000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('Backend ready', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Disconnect', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Load YANG models' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.netconf.connect), 'function');
  const state = await page.evaluate(() => window.netconf.getConnectionState());
  assert.equal(state.result.state, 'disconnected');
  assert.deepEqual(state.result.capabilities, []);
  if (process.platform === 'linux') {
    const pid = app.process().pid;
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/);
    for (const child of children) {
      try {
        if ((await readFile(`/proc/${child}/cmdline`, 'utf8')).includes('netconf_backend.main')) backendPid = Number(child);
      } catch { /* Electron utility children may exit during enumeration. */ }
    }
    assert.ok(backendPid, 'Electron must own a Python child');
  }
  await page.screenshot({ path: 'dist/desktop-smoke.png' });
  assert.deepEqual(errors, []);
  console.log('Desktop smoke passed: React visible, preload isolated, Python ready, disconnected, network controls disabled.');
} finally {
  if (app) await app.close();
  if (backendPid) {
    assert.throws(() => process.kill(backendPid, 0), { code: 'ESRCH' }, 'Python must exit with Electron');
    console.log('Owned Python process terminated with Electron.');
  }
  await rm(profile, { recursive: true, force: true });
}

// A second launch exercises the complete UI → IPC → Python → real ncclient →
// loopback SSH device → real libyang path. No production fixture switch exists.
if (process.platform !== 'win32') {
  const { writeFile, chmod } = await import('node:fs/promises');
  const fixtureProfile = await mkdtemp(path.join(tmpdir(), 'netconf-desktop-flow-'));
  const report = path.join(fixtureProfile, 'device.json');
  const wrapper = path.join(fixtureProfile, 'python-fixture');
  const root = process.cwd();
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(path.join(root, 'backend/.venv/bin/python'))} ${quote(path.join(root, 'backend/tests/desktop_backend.py'))}\n`);
  await chmod(wrapper, 0o700);
  let desktop;
  try {
    desktop = await electron.launch({
      args: ['.', `--user-data-dir=${fixtureProfile}`],
      env: { ...process.env, NETCONF_PYTHON: wrapper, NETCONF_TEST_REPORT: report, XDG_CACHE_HOME: path.join(fixtureProfile, 'cache') },
    });
    const page = await desktop.firstWindow();
    await page.getByText('Backend ready', { exact: true }).waitFor();
    const { port } = JSON.parse(await readFile(report, 'utf8'));
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(port));
    await page.getByLabel('Username').fill('test');
    assert.equal(await page.locator('.capabilities').getAttribute('open'), null);
    for (const name of ['Preview', 'Response', 'Session log']) assert.equal(await page.getByRole('tab', { name, exact: true }).isVisible(), true);
    await page.locator('.profile-editor summary').click();
    await page.getByLabel('Profile name', { exact: true }).fill('Fixture device');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Device profile"]').value !== '');
    const savedProfiles = await page.evaluate(() => window.netconf.getProfiles());
    const savedId = savedProfiles.result.lastSelectedId;
    assert.equal(savedProfiles.result.profiles[0].hasPassword, false);
    if (!savedProfiles.result.secureStorageAvailable) assert.equal(await page.getByLabel('Remember password', { exact: true }).isDisabled(), true);
    await page.getByLabel('Device profile').selectOption('');
    await page.getByLabel('Device profile').selectOption(savedId);
    assert.equal((await page.evaluate(() => window.netconf.getConnectionState())).result.state, 'disconnected');
    await page.reload();
    await page.waitForFunction(id => document.querySelector('[aria-label="Device profile"]').value === id, savedId);
    assert.equal(await page.getByLabel('Host', { exact: true }).inputValue(), '127.0.0.1');
    assert.equal(await page.getByLabel('Username').inputValue(), 'test');
    assert.equal((await page.evaluate(() => window.netconf.getConnectionState())).result.state, 'disconnected');
    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
    await page.getByRole('tab', { name: 'Session log', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Show inspector', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('tab', { name: 'Session log', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('CONNECTED', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Disconnect', exact: true }).isEnabled(), true);
    assert.equal(await page.getByText('No models loaded.', { exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('Device profile').isDisabled(), true);
    await page.getByRole('button', { name: 'Load YANG models' }).click();
    await page.locator('.module code').filter({ hasText: /^test-system$/ }).waitFor();
    await page.locator('.module code').filter({ hasText: /^test-augment$/ }).waitFor();
    await page.locator('.schema-tree .leaf').filter({ hasText: 'enabled' }).waitFor();
    await page.locator('.schema-tree .leaf').filter({ hasText: 'description' }).click();
    assert.equal(await page.getByLabel('Namespace', { exact: true }).inputValue(), 'urn:test:augment');
    assert.equal(await page.locator('.schema-tree .state-tag').count(), 1);
    assert.equal(await page.getByRole('alert').count(), 0);
    // Inspecting does not select request data. Checkboxes drive preview independently.
    assert.equal(await page.getByRole('button', { name: 'Execute', exact: true }).isDisabled(), true);
    await page.getByRole('checkbox', { name: 'Include /test-system:system/interface', exact: true }).check();
    assert.equal(await page.getByRole('checkbox', { name: 'Include /test-system:system/interface/name', exact: true }).isDisabled(), true);
    await page.getByRole('checkbox', { name: 'Include /test-system:system/interface', exact: true }).uncheck();
    const selectedPath = '/test-system:system/interface/test-augment:description';
    await page.getByRole('checkbox', { name: `Include ${selectedPath}`, exact: true }).check();
    assert.equal(await page.getByRole('checkbox', { name: 'Include /test-system:system/interface', exact: true }).evaluate(el => el.indeterminate), true);
    await page.getByLabel('/test-system:system/interface key name', { exact: true }).fill('eth1/1');
    await page.locator('.preview pre').first().filter({ hasText: 'eth1/1' }).waitFor();
    assert.match(await page.locator('.preview pre').first().innerText(), /urn:test:augment/);
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.response pre').filter({ hasText: 'rpc-reply' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Response', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    await page.locator('.runtime-tree').filter({ hasText: 'Fixture uplink' }).waitFor();
    await page.getByRole('button', { name: 'Collapse output', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: 'Last response', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Expand output', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: 'Last response', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.runtime-tree input[type=checkbox]').count(), 0);
    await page.locator('.runtime-tree .leaf').filter({ hasText: 'Fixture uplink' }).click();
    assert.equal(await page.getByLabel('Schema path', { exact: true }).inputValue(), '/test-system:system/interface/test-augment:description');
    assert.ok((await page.getByLabel('Instance path', { exact: true }).inputValue()).includes("[name='eth1/1']"));
    await page.getByRole('tab', { name: 'Schema', exact: true }).click();
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.getByLabel('/test-system:system/interface key name', { exact: true }).fill('parse-failure');
    await page.locator('.preview pre').filter({ hasText: 'parse-failure' }).waitFor();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.response pre').filter({ hasText: 'unmodeled response' }).waitFor();
    await page.locator('.response [role=alert]').filter({ hasText: 'Request succeeded.' }).waitFor();
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    await page.locator('.runtime-tree').filter({ hasText: 'Fixture uplink' }).waitFor();
    await page.getByRole('tab', { name: 'Schema', exact: true }).click();
    await page.getByLabel('/test-system:system/interface key name', { exact: true }).fill('eth1/1');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.getByLabel('Operation', { exact: true }).selectOption('get-config');
    assert.deepEqual(await page.getByLabel('Source datastore').locator('option').allTextContents(), ['running', 'candidate']);
    await page.locator('.preview pre').first().filter({ hasText: 'get-config' }).waitFor();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.response pre').filter({ hasText: 'Fixture denied read' }).waitFor();
    await page.locator('.response .error').filter({ hasText: 'error-app-tag' }).waitFor();
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    await page.locator('.runtime-tree').filter({ hasText: 'Fixture uplink' }).waitFor();
    await page.screenshot({ path: 'dist/desktop-data-tree.png' });
    await page.getByRole('button', { name: 'Maximize output', exact: true }).click();
    await page.screenshot({ path: 'dist/desktop-schema.png' });
    await page.getByRole('button', { name: 'Maximize output', exact: true }).click();
    await page.getByRole('tab', { name: 'Schema', exact: true }).click();
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    // Broadening selection must remove both nested key inputs and old matches.
    await page.getByRole('checkbox', { name: 'Include /test-system:system', exact: true }).check();
    assert.equal(await page.locator('.key-fields input').count(), 0);
    await page.waitForFunction(() => {
      const xml = document.querySelector('.preview pre')?.textContent || '';
      return xml.includes('<system xmlns="urn:test:system"/>') && !xml.includes('eth1/1');
    });
    assert.equal(await page.getByRole('button', { name: 'Execute', exact: true }).isEnabled(), true);
    await page.getByRole('checkbox', { name: 'Include /test-system:system', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: `Include ${selectedPath}`, exact: true }).check();
    assert.equal(await page.getByLabel('/test-system:system/interface key name', { exact: true }).inputValue(), '');

    assert.equal(await page.locator('.palette-action').count(), 0);
    assert.equal(await page.getByRole('tab', { name: 'Edit draft', exact: true }).count(), 0);
    // Stage runtime and schema changes locally, preview and execute through the same session.
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    assert.equal(await page.locator('.palette-action').count(), 0);
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.locator('.runtime-tree li').filter({ has: page.locator('.leaf').filter({ hasText: 'Fixture uplink' }) }).last().getByRole('button', { name: /^Edit / }).click();
    assert.equal(await page.getByLabel('Key name', { exact: true }).inputValue(), 'eth1/1');
    assert.equal(await page.getByLabel('Key name', { exact: true }).getAttribute('readonly'), '');
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    const runtimeLeaf = page.locator('.runtime-tree .leaf').filter({ hasText: 'Fixture uplink' });
    const leafBox = await runtimeLeaf.boundingBox();
    const actionBox = await runtimeLeaf.locator('..').locator(':scope > .palette-action').boundingBox();
    assert.ok(Math.abs(actionBox.y - leafBox.y) < 10);
    assert.ok(actionBox.x - (leafBox.x + leafBox.width) < 15);
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).click();
    await page.getByLabel('Value description', { exact: true }).fill('Edited uplink <&>');
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).waitFor();
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    assert.equal(await page.getByLabel('Edit target').inputValue(), 'candidate');
    assert.equal(await page.getByLabel('With defaults', { exact: true }).count(), 0);
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.locator('.preview pre').filter({ hasText: 'edit-config' }).waitFor();
    assert.match(await page.locator('.preview pre').innerText(), /urn:test:augment/);
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.getByText('Candidate modified; not committed. Draft retained.', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).waitFor();
    // Generic GET is unaffected by a candidate edit.
    await page.getByRole('tab', { name: 'Last response', exact: true }).waitFor();
    await page.getByText('This session modified candidate', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByText('Discard changes succeeded. Draft retained; snapshots were not refreshed.', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Last response', exact: true }).waitFor();
    assert.equal(await page.getByText('This session modified candidate', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Value description').inputValue(), 'Edited uplink <&>');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await page.getByText('Commit succeeded. Draft retained; snapshots were not refreshed.', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Last response · stale', exact: true }).waitFor();
    assert.match(await page.locator('.response pre').innerText(), /<ok/);
    assert.equal(await page.getByLabel('Value description').inputValue(), 'Edited uplink <&>');
    await page.getByRole('button', { name: 'Clear draft', exact: true }).click();
    // Capture candidate provenance, then verify test-only and a modifying edit.
    await page.getByLabel('Operation', { exact: true }).selectOption('get-config');
    await page.getByLabel('Source datastore').selectOption('candidate');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.locator('.preview pre').filter({ hasText: '<candidate' }).waitFor();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.response pre').filter({ hasText: '1500' }).waitFor();
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.locator('.runtime-tree li').filter({ has: page.locator('summary').filter({ hasText: /^interface/ }) }).last().locator(':scope > details > summary > .palette-action button').click();
    assert.equal(await page.getByLabel('Value description').inputValue(), 'Fixture uplink');
    // RPC options must not discard a tree that contains only untouched context.
    await page.getByLabel('Error option').selectOption('continue-on-error');
    assert.equal(await page.getByLabel('Value description').inputValue(), 'Fixture uplink');
    await page.getByLabel('Error option').selectOption('');
    await page.getByLabel('Value mtu', { exact: true }).fill('9000');
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.getByLabel('Test option').selectOption('test-only');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.locator('.preview pre').filter({ hasText: 'test-only' }).waitFor();
    assert.doesNotMatch(await page.locator('.preview pre').innerText(), /description|Fixture uplink/);
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.getByText('Test completed; configuration unchanged. Draft retained.', { exact: true }).waitFor();
    assert.equal(await page.getByText('This session modified candidate', { exact: true }).count(), 0);
    await page.getByRole('tab', { name: 'Last response', exact: true }).waitFor();
    await page.getByLabel('Test option').selectOption('');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.preview pre')?.textContent.includes('test-only') && document.querySelector('.preview pre')?.textContent.includes('9000'));
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.getByRole('tab', { name: 'Last response · stale', exact: true }).waitFor();
    await page.getByText('Candidate modified; not committed. Draft retained.', { exact: true }).waitFor();
    await page.screenshot({ path: 'dist/desktop-edit-draft.png' });
    // Draft value edits stay textual and conflicts cannot execute.
    await page.getByLabel('Value mtu').fill('error');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.locator('.preview pre').filter({ hasText: '>error<' }).waitFor();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.response pre').filter({ hasText: 'Fixture denied edit' }).waitFor();
    assert.equal(await page.locator('.response .error').count(), 2);
    await page.getByLabel('Operation', { exact: true }).selectOption('get-config');
    await page.getByLabel('Source datastore').selectOption('candidate');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.locator('.preview pre').filter({ hasText: '<candidate' }).waitFor();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.getByRole('tab', { name: 'Last response', exact: true }).waitFor();
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).click();

    await page.getByRole('button', { name: 'Clear draft', exact: true }).click();
    await page.getByRole('tab', { name: 'Schema', exact: true }).click();
    await page.getByRole('button', { name: 'Add /test-system:system/interface', exact: true }).click();
    await page.getByLabel('Key name', { exact: true }).fill('eth1/2');
    const newList = page.locator('.draft-tree li[data-schema-path="/test-system:system/interface"]');
    await newList.getByRole('button', { name: '+ Add field', exact: true }).click();
    await page.getByRole('button', { name: 'Add mtu', exact: true }).click();
    await page.getByLabel('Value mtu', { exact: true }).fill('9000');
    await newList.getByRole('button', { name: '+ Add field', exact: true }).click();
    await page.getByRole('button', { name: 'Add description', exact: true }).click();
    await page.getByLabel('Value description', { exact: true }).fill('Backup uplink <&>');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.locator('.preview pre').filter({ hasText: 'eth1/2' }).waitFor();
    assert.match(await page.locator('.preview pre').innerText(), /operation="create"/);
    await page.locator('.preview pre').filter({ hasText: 'Backup uplink &lt;&amp;&gt;' }).waitFor();
    const createdXml = await page.locator('.preview pre').innerText();
    assert.equal((createdXml.match(/<interface /g) || []).length, 1);
    assert.match(createdXml, />9000</);
    await page.getByRole('tab', { name: 'Schema', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: `Include ${selectedPath}`, exact: true }).isChecked(), true);
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).click();
    assert.equal(await page.getByLabel('Value description').inputValue(), 'Backup uplink <&>');
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).waitFor();

    // Two concrete instances remain distinct; row operations preserve delete/remove.
    await page.getByRole('tab', { name: 'Schema', exact: true }).click();
    await page.getByRole('button', { name: 'Add /test-system:system/interface', exact: true }).click();
    assert.equal(await page.getByLabel('Key name', { exact: true }).count(), 2);
    await page.getByLabel('Key name', { exact: true }).nth(1).fill('eth1/3');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.locator('.preview pre').filter({ hasText: 'eth1/3' }).waitFor();
    assert.equal(((await page.locator('.preview pre').innerText()).match(/<interface /g) || []).length, 2);
    for (const op of ['delete', 'remove']) {
      await page.getByLabel('Operation interface', { exact: true }).nth(1).selectOption(op);
      await page.locator('.preview pre').filter({ hasText: `operation="${op}"` }).waitFor();
      assert.equal(await page.getByLabel('Operation interface', { exact: true }).nth(0).inputValue(), 'create');
    }
    await page.getByRole('button', { name: 'Clear draft', exact: true }).click();
    assert.equal(await page.locator('.draft-tree').count(), 0);
    // Last response offers distinct destructive actions on an existing list.
    for (const op of ['delete', 'remove']) {
      await page.getByRole('tab', { name: 'Last response', exact: true }).click();
      await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
      await page.locator('.runtime-tree li').filter({ has: page.locator('summary').filter({ hasText: /^interface/ }) }).last().locator(':scope > details > summary > .palette-action select').selectOption(op);
      await page.locator('.preview pre').filter({ hasText: `operation="${op}"` }).waitFor();
      const xml = await page.locator('.preview pre').innerText();
      assert.match(xml, /eth1\/1/);
      assert.doesNotMatch(xml, /<mtu|<description/);
      assert.equal(await page.getByLabel('Value mtu').isDisabled(), true);
      await page.getByRole('button', { name: 'Clear draft', exact: true }).click();
    }

    // A successful schema replacement clears runtime instances.
    await page.getByRole('button', { name: 'Load YANG models' }).click();
    await page.getByRole('button', { name: 'Load YANG models' }).waitFor();
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    await page.getByText('No successfully parsed response for this schema. Execute a GET or GET-CONFIG.').waitFor();
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).click();
    assert.equal(await page.locator('.draft-tree').count(), 0);
    await page.getByRole('tab', { name: 'Schema', exact: true }).click();
    await page.getByRole('button', { name: 'Collapse output', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Expand output', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Expand output', exact: true }).click();
    // Reload reads snapshots; it does not reconnect or re-download models.
    await page.reload();
    await page.getByText('CONNECTED', { exact: true }).waitFor();
    await page.locator('.module code').filter({ hasText: /^test-system$/ }).waitFor();
    // Rebuild response after renderer reload, then retain it on Disconnect.
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Include /test-system:system', exact: true }).check();
    await page.locator('.preview pre').filter({ hasText: '<get' }).waitFor();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.response pre').filter({ hasText: 'Fixture uplink' }).waitFor();
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    await page.locator('.runtime-tree').filter({ hasText: 'Fixture uplink' }).waitFor();
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.locator('.runtime-tree li').filter({ has: page.locator('.leaf').filter({ hasText: 'Fixture uplink' }) }).last().getByRole('button', { name: /^Edit / }).click();
    await page.getByLabel('Value description', { exact: true }).fill('Running edit');
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.getByLabel('Edit target').selectOption('running');
    assert.equal(await page.getByRole('button', { name: 'Commit', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Discard changes', exact: true }).count(), 0);
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.locator('.preview pre').filter({ hasText: 'Running edit' }).waitFor();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.getByRole('tab', { name: 'Last response · stale', exact: true }).waitFor();
    await page.getByText('Running modified. Draft retained.', { exact: true }).waitFor();
    await page.getByLabel('Operation', { exact: true }).selectOption('get');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.locator('.preview pre').filter({ hasText: '<get ' }).waitFor();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.getByRole('tab', { name: 'Last response', exact: true }).waitFor();
    await page.getByLabel('Operation', { exact: true }).selectOption('edit-config');
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByText('DISCONNECTED', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Load YANG models' }).isDisabled(), true);
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    await page.locator('.runtime-tree').filter({ hasText: 'Fixture uplink' }).waitFor();
    // A fresh explicit attempt clears old-device data even if connection fails.
    await page.getByRole('tab', { name: 'Edit draft', exact: true }).waitFor();
    await page.getByLabel('Port', { exact: true }).fill('1');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('tab', { name: 'Last response', exact: true }).click();
    await page.getByText('No successfully parsed response for this schema. Execute a GET or GET-CONFIG.').waitFor();
    await page.getByText('DISCONNECTED', { exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Edit draft', exact: true }).count(), 0);
    await desktop.close(); desktop = undefined;
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.ok(result.capabilities.includes('urn:ietf:params:netconf:base:1.1'));
    assert.ok(result.capabilities.includes('urn:ietf:params:netconf:base:1.0'));
    assert.deepEqual(result.requests, ['get', 'get-schema', 'get-schema', 'get', 'get', 'get-config', 'edit-config', 'discard-changes', 'commit', 'get-config', 'edit-config', 'edit-config', 'edit-config', 'get-config', 'get', 'get-schema', 'get-schema', 'get', 'edit-config', 'get', 'close-session']);
    assert.deepEqual(result.errors, []);
    console.log('Full desktop flow passed: retrievals, edit staging, preview/execute, test-only, explicit commit/discard, candidate/running staleness, complete rpc-errors, draft lifecycle, explicit Disconnect.');
  } finally {
    if (desktop) await desktop.close();
    await rm(fixtureProfile, { recursive: true, force: true });
  }
}
