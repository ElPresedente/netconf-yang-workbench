const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
global.window = {};
const { initial } = require('../frontend/src/features/rpcs/RpcWorkbench.tsx');
const { afterRpc } = require('../frontend/src/features/rpcs/state.ts');
const node = (name, props = {}) => ({ name, path: '/rpc/input/' + name, kind: 'leaf', type: 'string', children: [], ...props });
test('RPC initial input includes only required structure; scalar presence is not invented', () => {
  const schema = [node('optional'), node('mandatory', { mandatory: true }), node('conditional', { mandatory: true, conditional: true }), node('empty', { mandatory: true, type: 'empty' }), node('nested', { kind: 'container', children: [node('child', { mandatory: true })] }), node('present', { kind: 'container', presence: true, children: [node('hidden', { mandatory: true })] }), node('entries', { kind: 'list', minElements: 2, children: [node('key', { isKey: true })] })];
  const result = initial(schema);
  assert.deepEqual(result.map(n => n.schemaPath), ['mandatory', 'empty', 'nested', 'entries', 'entries'].map(n => '/rpc/input/' + n));
  assert.equal(result[0].value, undefined);
  assert.equal(result[1].value, null);
  assert.equal(result[2].children[0].schemaPath, '/rpc/input/child');
  assert.equal(new Set(result.flatMap(n => [n.id, ...n.children.map(c => c.id)])).size, 8);
});
test('custom RPC stales every retained retrieval without mutating it or claiming datastore changes', () => {
  assert.equal(afterRpc(null), null);
  for (const datastore of [null, 'running', 'candidate', 'startup']) {
    const old = { operation: datastore ? 'get-config' : 'get', datastore, stale: false };
    assert.deepEqual(afterRpc(old), { ...old, stale: true });
    assert.equal(old.stale, false);
  }
});
