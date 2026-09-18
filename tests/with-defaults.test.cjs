const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Load renderer modules through the same TypeScript compiler without a browser.
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    });
    module._compile(output.outputText, filename);
  };
}
global.window = {};
const { supportedWithDefaults, emptyRequest } = require('../frontend/src/features/requests/state.ts');
const { RequestBuilder } = require('../frontend/src/features/requests/RequestBuilder.tsx');
const cap = 'urn:ietf:params:netconf:capability:with-defaults:1.0';
for (const [suffix, expected] of [
  [null, null],
  ['?basic-mode=explicit', ['explicit']],
  ['?basic-mode=explicit&also-supported=trim,report-all', ['explicit', 'trim', 'report-all']],
  ['?basic-mode=trim&also-supported=report-all-tagged', ['trim', 'report-all-tagged']],
]) {
  test('capability-driven selector: ' + suffix, () => {
    const capabilities = suffix === null ? [] : [cap + suffix];
    assert.deepEqual(supportedWithDefaults(capabilities), expected);
    const html = renderToStaticMarkup(React.createElement(RequestBuilder, {
      intent: emptyRequest(), setIntent() {}, roots: [],
      info: { state: 'connected', capabilities }, busy: false, run() {},
    }));
    assert.equal(html.includes('aria-label="With defaults"'), expected !== null);
    if (expected !== null) {
      assert.match(html, /value="" selected="">Server default/);
      for (const mode of ['explicit', 'trim', 'report-all', 'report-all-tagged']) {
        assert.equal(html.includes('value="' + mode + '"'), expected.includes(mode));
      }
    }
    assert.equal(emptyRequest().withDefaults, null);
  });
}
