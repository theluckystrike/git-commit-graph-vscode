'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const mock = require('./helpers/vscode');
const P = require('../src/pro');

test('Pro ships switched off: every feature free, no labels, license commands say nothing to unlock', async () => {
  assert.equal(P.PRO_ENABLED, false);
  const m = mock.install();
  try {
    const ctx = mock.context(path.join(require('os').tmpdir(), 'zgit-pro-' + process.pid));
    const pro = P.createPro({ vscode: m.vscode, context: ctx });
    assert.deepEqual(pro.labels(), []);
    for (const f of P.PRO_FEATURES) assert.equal(await pro.allow(f), true);
    await m.state.commands.get('zovoGit.getPro')();
    assert.match(m.state.messages.pop()[1], /free in this version/);
    assert.equal(m.state.contexts['zovoGit.proEnabled'], false);
  } finally { m.uninstall(); }
});

test('Pro switched on: free tries, then the license asks; graph features are not in the list', async () => {
  const m = mock.install();
  try {
    const ctx = mock.context(path.join(require('os').tmpdir(), 'zgit-pro2-' + process.pid));
    let asked = 0;
    const license = { ready: Promise.resolve(), isPro: () => false, requirePro: async () => { asked++; return false; } };
    const pro = P.createPro({ vscode: m.vscode, context: ctx, enabled: true, license });
    for (let i = 0; i < P.FREE_TRIES; i++) assert.equal(await pro.allow('Saved graph filters'), true);
    assert.equal(await pro.allow('Saved graph filters'), false);
    assert.equal(asked, 1);
    assert.deepEqual(pro.labels(), P.PRO_FEATURES);
    for (const f of P.PRO_FEATURES) assert.ok(!/graph view|search|squash|diff/i.test(f.replace('graph filters', '')), f);
  } finally { m.uninstall(); }
});
