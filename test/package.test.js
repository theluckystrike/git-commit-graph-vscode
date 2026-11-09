'use strict';
// package.json and the code agree: every command is registered, every menu names a real command, the engine floor
// works in Cursor and Windsurf, nothing outside the Sponsors rail can reach the network, and webviews are strict.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mock = require('./helpers/vscode');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('every package.json command is registered at activation, and only those', async () => {
  const m = mock.install();
  try {
    m.vscode.workspace.workspaceFolders = [];
    delete require.cache[require.resolve('../src/extension')];
    const ext = require('../src/extension');
    ext.activate(mock.context(path.join(require('os').tmpdir(), 'zgit-pkg-' + process.pid)));
    await new Promise(r => setTimeout(r, 300));
    const listed = new Set(pkg.contributes.commands.map(c => c.command));
    const registered = new Set(m.state.commands.keys());
    for (const c of listed) assert.ok(registered.has(c), 'not registered: ' + c);
    for (const c of registered) assert.ok(listed.has(c), 'not in package.json: ' + c);
    for (const [where, items] of Object.entries(pkg.contributes.menus)) for (const it of items) assert.ok(listed.has(it.command), `${where}: ${it.command}`);
    assert.equal(m.state.contexts['zovoGit.proEnabled'], false);
    ext.deactivate();
  } finally { m.uninstall(); }
});

test('engine floor, types, name, phrases and the files that ship', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.name, 'zovo-git-commit-graph');
  for (const w of ['Git', 'Commit', 'Graph', 'History', 'Log']) assert.ok(pkg.displayName.includes(w), w);
  assert.ok(!/Git Graph|Git History|Git Log\b|GitLens/.test(pkg.displayName), 'does not contain another listing\'s name');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'no runtime dependencies');
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  for (const p of ['test/**', 'scripts/**']) assert.ok(ignore.includes(p), p);
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(pkg.contributes.configuration.properties['zovoGit.path'].scope, 'machine');
  assert.ok(pkg.contributes.walkthroughs[0].steps.length >= 4);
  for (const s of pkg.contributes.walkthroughs[0].steps) if (s.media.markdown) assert.ok(fs.existsSync(path.join(root, s.media.markdown)), s.media.markdown);
});

test('no network code outside the GitHub Sponsors rail', () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p); } };
  walk(path.join(root, 'src')); walk(path.join(root, 'media'));
  for (const f of files) {
    if (f.includes(path.join('src', 'license'))) continue;
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram)['"]\)|\bfetch\(|XMLHttpRequest|WebSocket\(/.test(s), path.relative(root, f));
  }
});

test('read commands run with hooks, fsmonitor, pager, external diff and lazy fetch off', () => {
  const r = require('../src/git/runner');
  const a = r.readArgs(['log']);
  for (const want of ['core.fsmonitor=false', 'diff.external=', 'core.pager=cat', 'protocol.allow=never']) assert.ok(a.includes(want), want);
  assert.ok(a.some(x => x.startsWith('core.hooksPath=')));
  assert.ok(a.includes('--no-optional-locks'));
  assert.equal(r.baseEnv().GIT_NO_LAZY_FETCH, '1');
  assert.equal(r.baseEnv().GIT_TERMINAL_PROMPT, '0');
  // every log/show/diff in the code turns textconv off
  for (const f of ['src/graph/worker.js', 'src/views/history.js', 'src/compareReport.js', 'src/rebase.js', 'src/details.js']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of s.matchAll(/\[\s*'(log|show|diff|diff-tree)'[^\]]*\]/g)) if (!/base\.slice|\.\.\.base/.test(m[0])) assert.ok(/no-textconv/.test(m[0]) || /'diff-tree'|'diff'/.test(m[1]) && /no-textconv/.test(s), `${f}: ${m[0].slice(0, 60)}`);
  }
});

test('webviews: strict CSP, nonce scripts, no remote source, text set with textContent', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'views', 'html.js'), 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-\$\{n\}'/);
  assert.match(html, /img-src \$\{webview\.cspSource\} blob: data:/);
  for (const f of ['graph.js', 'history.js', 'rebase.js']) {
    const s = fs.readFileSync(path.join(root, 'media', f), 'utf8');
    assert.ok(!/innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|https?:\/\//.test(s), f);
  }
});
