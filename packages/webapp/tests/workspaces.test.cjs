const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const exportsObject = {};
const source = readFileSync(
  resolve(__dirname, '../src/ee/workspaces/utils.ts'),
  'utf8',
);
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
  { exports: exportsObject },
);

const { canSwitchWorkspace } = exportsObject;
const ready = {
  organizationId: 'other',
  isReady: true,
  isActive: true,
  isBuildRunning: false,
  isDeleting: false,
};

test('a ready active company can be selected', () => {
  assert.equal(canSwitchWorkspace(ready, 'current'), true);
});

test('selecting the current company does not initiate another switch', () => {
  assert.equal(canSwitchWorkspace(ready, 'other'), false);
});

for (const state of [
  { isReady: false },
  { isActive: false },
  { isBuildRunning: true },
  { isDeleting: true },
]) {
  test(`a company with ${JSON.stringify(state)} cannot be switched into`, () => {
    assert.equal(canSwitchWorkspace({ ...ready, ...state }, 'current'), false);
  });
}
