const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
global.window = {};
const { editCapabilities, emptyEdit, runtimeKeys, editable, afterEdit } = require('../frontend/src/features/edits/state.ts');
const { emptyRequest } = require('../frontend/src/features/requests/state.ts');
const { RequestBuilder } = require('../frontend/src/features/requests/RequestBuilder.tsx');
const cap = name => 'urn:ietf:params:netconf:capability:' + name;
test('edit target, validate and rollback capabilities; retrieval controls remain independent', () => {
  assert.deepEqual(editCapabilities([]).editableTargets, []);
  assert.deepEqual(editCapabilities([cap('startup:1.0')]).editableTargets, []);
  assert.deepEqual(editCapabilities([cap('candidate:1.0')]).editableTargets, ['candidate']);
  assert.deepEqual(editCapabilities([cap('writable-running:1.0')]).editableTargets, ['running']);
  assert.deepEqual(editCapabilities([cap('validate:1.0')]).supportedTestOptions, ['test-then-set', 'set']);
  assert.deepEqual(editCapabilities([cap('validate:1.1')]).supportedTestOptions, ['test-then-set', 'set', 'test-only']);
  const props = { intent: { ...emptyRequest(), withDefaults: 'trim' }, draft: emptyEdit(), editMode: true, roots: [], info: { state: 'connected', capabilities: [cap('candidate:1.0'), cap('with-defaults:1.0?basic-mode=trim')] } };
  const html = renderToStaticMarkup(React.createElement(RequestBuilder, props));
  assert.ok(!html.includes('aria-label="With defaults"'));
  assert.ok(!html.includes('rollback-on-error'));
  assert.ok(!html.includes('aria-label="Test option"'));
  assert.ok(html.includes('aria-label="Edit target"'));
  assert.equal(props.intent.withDefaults, 'trim');
  const disabled = renderToStaticMarkup(React.createElement(RequestBuilder, { ...props, info: { state: 'connected', capabilities: [] } }));
  assert.match(disabled, /value="edit-config" disabled/);
});
test('nested runtime keys come from parents, in order, without parsing instancePath', () => {
  const node = { id: 'outer', kind: 'list', schemaPath: '/outer', keyValues: { z: '01', a: 'two' }, children: [{ id: 'inner', kind: 'list', schemaPath: '/outer/inner', keyValues: { name: 'eth1/1' }, children: [{ id: 'leaf', kind: 'leaf', schemaPath: '/outer/inner/mtu', children: [] }] }] };
  assert.deepEqual(runtimeKeys([node], 'leaf'), [{ listSchemaPath: '/outer', values: { z: '01', a: 'two' } }, { listSchemaPath: '/outer/inner', values: { name: 'eth1/1' } }]);
  assert.equal(runtimeKeys([node], 'missing'), null);
  assert.equal(editable({ config: false, kind: 'leaf' }), false);
  assert.equal(editable({ config: true, kind: 'leaf', isKey: true }), false);
  assert.equal(editable({ config: true, kind: 'leaf-list' }), false);
});
test('staleness respects datastore and test-only; retrieval replacement starts fresh', () => {
  for (const operation of ['get', 'get-config']) for (const datastore of [null, 'running', 'candidate', 'startup']) for (const target of ['candidate', 'running']) {
    const prior = { operation, datastore, stale: false };
    const edit = { ...emptyEdit(), target };
    assert.equal(afterEdit(prior, edit).stale, operation === 'get' ? target === 'running' : datastore === target);
    assert.equal(afterEdit(prior, { ...edit, testOption: 'test-only' }).stale, false);
    const replaced = { operation, datastore, stale: false };
    assert.equal(replaced.stale, false);
  }
});

const { addSchema, addRuntime, toChanges, setValue, updateNode, removeNode, canAdd } = require('../frontend/src/features/edits/tree.ts');
const { DraftTree } = require('../frontend/src/features/edits/DraftTree.tsx');
const { spawnSync } = require('node:child_process');
function fixture() {
  const node = (name, kind, parent = '', props = {}) => ({ id: parent + '/' + name, path: parent + '/' + name, name: name.split(':').pop(), kind, module: 'test', namespace: 'urn:test', config: true, keys: [], isKey: false, children: [], type: kind === 'leaf' ? 'string' : null, ...props });
  const root = node('test:system', 'container');
  const list = node('interface', 'list', root.path, { keys: ['z', 'a'] });
  const child = (name, props = {}) => node(name, 'leaf', list.path, props);
  list.children = [child('a', { isKey: true }), child('z', { isKey: true }), child('mtu', { type: 'uint16' }), child('description', { namespace: 'urn:augment' }), child('enabled', { type: 'boolean' }), child('state', { config: false }), node('dns', 'leaf-list', list.path)];
  const inner = node('server', 'list', list.path, { keys: ['host'] });
  inner.children = [node('host', 'leaf', inner.path, { isKey: true }), node('port', 'leaf', inner.path)];
  list.children.push(inner);
  root.children = [list, node('service', 'container', root.path, { presence: true })];
  const runtime = { id: 'runtime', schemaPath: list.path, instancePath: '/opaque', kind: 'list', keyValues: { a: 'two', z: 'one' }, config: true, value: null, children: list.children.filter(c => c.kind === 'leaf').map(c => ({ id: c.path, schemaPath: c.path, instancePath: '/opaque/' + c.name, kind: 'leaf', value: c.name === 'mtu' ? '1500' : c.name === 'enabled' ? 'true' : 'original', keyValues: {}, config: c.config, children: [] })) };
  return { roots: [root], list, runtime, data: [runtime] };
}
const flatten = tree => tree.flatMap(n => [n, ...flatten(n.children)]);
const named = (tree, name) => flatten(tree).find(n => n.schema.name === name);
function build(roots, changes) {
  const run = spawnSync('backend/.venv/bin/python', ['-c', `import json,sys
from types import SimpleNamespace
from netconf_backend.edits import build_edit
from lxml import etree
p=json.load(sys.stdin)
try:
 _,config=build_edit(SimpleNamespace(context=True,tree={'roots':p['roots']}),p['intent'],['urn:ietf:params:netconf:capability:candidate:1.0'])
 print(etree.tostring(config,encoding='unicode'))
except Exception as e:
 print(str(e));sys.exit(1)`], { timeout: 10000, input: JSON.stringify({ roots, intent: { ...emptyEdit(), changes } }), encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'backend' } });
  return { status: run.status, xml: run.stdout, error: run.stderr || (run.status ? run.stdout : undefined) };
}
test('runtime leaf inherits immutable keys; repeat addition reuses branch and preserves inline edit', () => {
  const { roots, data, runtime } = fixture();
  const mtu = runtime.children.find(n => n.schemaPath.endsWith('/mtu'));
  let tree = addRuntime([], roots, data, mtu);
  tree = setValue(tree, named(tree, 'mtu').id, '9000');
  const id = named(tree, 'mtu').id;
  tree = addRuntime(tree, roots, data, mtu);
  assert.equal(named(tree, 'mtu').id, id);
  assert.equal(toChanges(tree).length, 1);
  assert.equal(toChanges(tree)[0].value, '9000');
  assert.deepEqual(toChanges(tree)[0].ancestorKeys[0].values, { z: 'one', a: 'two' });
  tree = setValue(tree, named(tree, 'z').id, 'rename');
  assert.equal(named(tree, 'z').value, 'one');
  const html = renderToStaticMarkup(React.createElement(DraftTree, { tree, roots }));
  assert.match(html, /aria-label="Key z" readOnly=""/);
  assert.match(html, /1500/);
  assert.match(html, /modified/);
});
test('existing instance displays untouched siblings but emits only modified or explicitly included values', () => {
  const { roots, data, runtime } = fixture();
  let tree = addRuntime([], roots, data, runtime);
  assert.equal(toChanges(tree).length, 0);
  const id = named(tree, 'mtu').id;
  tree = setValue(tree, id, '9000');
  assert.deepEqual(toChanges(tree).map(c => c.schemaPath), [named(tree, 'mtu').schema.path]);
  const result = build(roots, toChanges(tree));
  assert.equal(result.status, 0, result.error);
  assert.match(result.xml, />9000</);
  assert.doesNotMatch(result.xml, /description|enabled|state/);
  tree = setValue(tree, id, '1500');
  assert.equal(toChanges(tree).length, 0);
});
test('schema list creation, ordered required keys, multiple fields, namespaces and exact textual values reach backend', () => {
  const { roots, list } = fixture();
  let tree = addSchema([], roots, list.path);
  const instance = named(tree, 'interface');
  assert.deepEqual(instance.children.map(n => n.schema.name), ['z', 'a']);
  assert.equal(build(roots, toChanges(tree)).status, 1, 'unfinished keys rejected');
  for (const key of ['z', 'a']) tree = setValue(tree, named(tree, key).id, key + '1');
  for (const [field, value] of [['mtu', '18446744073709551615'], ['description', 'uplink <&>'], ['enabled', 'false']]) {
    tree = addSchema(tree, roots, list.path + '/' + field, instance.id);
    tree = setValue(tree, named(tree, field).id, value);
  }
  const changes = toChanges(tree);
  assert.equal(changes.length, 4);
  assert.equal(changes[0].operation, 'create');
  const result = build(roots, changes);
  assert.equal(result.status, 0, result.error);
  assert.equal((result.xml.match(/<interface /g) || []).length, 1);
  assert.match(result.xml, /urn:augment/);
  assert.match(result.xml, /uplink &lt;&amp;&gt;/);
  assert.match(result.xml, /18446744073709551615/);
  assert.deepEqual(toChanges(structuredClone(tree)), changes);
  const second = addSchema(tree, roots, list.path);
  const instances = flatten(second).filter(n => n.schema.kind === 'list');
  assert.equal(instances.length, 2);
  let two = second;
  for (const key of instances[1].children) two = setValue(two, key.id, key.schema.name + '2');
  const both = build(roots, toChanges(two));
  assert.equal(both.status, 0, both.error);
  assert.equal((both.xml.match(/<interface /g) || []).length, 2);
  assert.equal(named(two, 'interface').id, instance.id);
});
test('nested schema addition shows keys at each list; presence container stays empty', () => {
  const { roots, list } = fixture();
  let tree = addSchema([], roots, list.path + '/server/port');
  for (const name of ['z', 'a', 'host', 'port']) tree = setValue(tree, named(tree, name).id, name === 'port' ? '830' : name);
  const change = toChanges(tree).find(c => c.schemaPath.endsWith('/port'));
  assert.deepEqual(change.ancestorKeys.map(k => Object.keys(k.values)), [['z', 'a'], ['host']]);
  assert.equal(build(roots, toChanges(tree)).status, 0);
  tree = addSchema([], roots, roots[0].path + '/service');
  assert.equal(named(tree, 'service').children.length, 0);
  assert.equal(toChanges(tree).length, 1);
  assert.equal(build(roots, toChanges(tree)).status, 0);
});
test('state, keys, keyless lists and leaf-list cannot be added; deletion and removal preserve identity', () => {
  const { roots, list, data, runtime } = fixture();
  for (const name of ['state', 'z', 'dns']) assert.deepEqual(addSchema([], roots, list.path + '/' + name), []);
  assert.equal(canAdd(roots, { ...list, keys: [], kind: 'leaf-list' }), false);
  for (const operation of ['delete', 'remove']) {
    const tree = addRuntime([], roots, data, runtime, operation);
    const changes = toChanges(tree);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].operation, operation);
    assert.deepEqual(changes[0].ancestorKeys[0].values, { z: 'one', a: 'two' });
    assert.match(build(roots, changes).xml, new RegExp(`operation="${operation}"`));
    assert.equal(removeNode(tree, tree[0].id).length, 0);
  }
});
test('operations affect only the selected row; backend still rejects destructive conflicts and duplicate concrete instances', () => {
  const { roots, data, runtime, list } = fixture();
  let tree = addRuntime([], roots, data, runtime);
  tree = setValue(tree, named(tree, 'mtu').id, '9000');
  tree = updateNode(tree, named(tree, 'interface').id, n => ({ ...n, included: true, operation: 'replace' }));
  assert.deepEqual(toChanges(tree).map(c => c.operation), ['replace', 'merge']);
  assert.equal(build(roots, toChanges(tree)).status, 1);
  tree = addSchema([], roots, list.path);
  tree = addSchema(tree, roots, list.path);
  for (const n of flatten(tree).filter(n => n.schema.isKey)) tree = setValue(tree, n.id, 'same');
  assert.equal(build(roots, toChanges(tree)).status, 1);
});
test('boolean and empty inputs use schema metadata; empty presence sends no text, and keyless ancestors stay read-only', () => {
  const { roots, list } = fixture();
  const empty = { ...list.children.find(n => n.name === 'mtu'), id: list.path + '/active', path: list.path + '/active', name: 'active', type: 'empty' };
  list.children.push(empty);
  let tree = addSchema([], roots, list.path);
  const parent = named(tree, 'interface').id;
  for (const key of ['z', 'a']) tree = setValue(tree, named(tree, key).id, 'key');
  tree = addSchema(tree, roots, empty.path, parent);
  tree = addSchema(tree, roots, list.path + '/enabled', parent);
  tree = setValue(tree, named(tree, 'enabled').id, 'false');
  const html = renderToStaticMarkup(React.createElement(DraftTree, { tree, roots }));
  assert.match(html, /select aria-label="Value enabled"/);
  assert.match(html, /type="checkbox" aria-label="Present active"/);
  assert.equal(toChanges(tree).find(c => c.schemaPath === empty.path).value, null);
  assert.match(build(roots, toChanges(tree)).xml, /<active[^>]*\/>/);
  tree = updateNode(tree, named(tree, 'active').id, n => ({ ...n, included: false }));
  assert.ok(!toChanges(tree).some(c => c.schemaPath === empty.path));
  list.keys = [];
  assert.equal(canAdd(roots, list), false);
  assert.deepEqual(addSchema([], roots, list.path + '/enabled'), []);
});

const { afterCandidate } = require('../frontend/src/features/edits/state.ts');
test('candidate actions conservatively stale only affected snapshots, preserving existing stale flags', () => {
  assert.equal(afterCandidate(null, 'commit'), null);
  for (const action of ['commit', 'discard']) for (const operation of ['get', 'get-config']) for (const datastore of [null, 'candidate', 'running', 'startup']) {
    const affected = operation === 'get' ? action === 'commit' : datastore === 'candidate' || action === 'commit' && datastore === 'running';
    assert.equal(afterCandidate({ operation, datastore, stale: false }, action).stale, affected);
    assert.equal(afterCandidate({ operation, datastore, stale: true }, action).stale, true);
  }
});
test('candidate toolbar requires connected candidate capability and target, but no valid edit draft or schema', () => {
  const props = { intent: emptyRequest(), draft: emptyEdit(), editMode: true, roots: [], info: { state: 'connected', capabilities: [cap('candidate:1.0?x=1')] } };
  const render = patch => renderToStaticMarkup(React.createElement(RequestBuilder, { ...props, ...patch }));
  const html = render({ candidateModified: true });
  assert.match(html, />Commit<\/button>/);
  assert.match(html, />Discard changes<\/button>/);
  assert.match(html, /This session modified candidate/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Commit/);
  for (const patch of [{ editMode: false }, { draft: { ...emptyEdit(), target: 'running' } }, { info: { state: 'disconnected', capabilities: [cap('candidate:1.0')] } }, { info: { state: 'connected', capabilities: [cap('writable-running:1.0')] } }]) {
    assert.doesNotMatch(render(patch), />Commit<|>Discard changes</);
  }
  assert.match(render({ busy: true }), /disabled=""[^>]*>Commit/);
  assert.doesNotMatch(render({}), /This session modified candidate/);
});
