// Real VS Code gate for Commit Graph. Installs the .vsix into an isolated profile, opens each fixture repository
// (scripts/make-fixtures.sh), drives the graph webview, the command palette, quick picks and modal dialogs with real
// key and mouse events over CDP, and checks every write action with the git command line.
// usage: node scripts/gate-vscode.mjs <work> <port> <vsix> <fixtureRoot> <shotDir> <outJson> [phase,...]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const [work0, port0, vsix, fx0, shotDir, outJson, only = ''] = process.argv.slice(2);
let work = path.resolve(work0); const FX = path.resolve(fx0); const port = Number(port0);
const R = fs.existsSync(outJson) && only ? JSON.parse(fs.readFileSync(outJson, 'utf8')) : { install: null, steps: [], console: [], started: new Date().toISOString() };
const want = p => !only || only.split(',').includes(p);
if (only) R.steps = R.steps.filter(s => !only.split(',').includes(s.phase));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(FX, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: gitEnv, maxBuffer: 64 * 1024 * 1024 }).trim();

if (!only || only.includes('install')) {
  fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
  fs.rmSync(path.join(work, 'ext'), { recursive: true, force: true });
  R.install = installVsix(work, vsix);
  console.log('install:', R.install.code, R.install.out.trim().split('\n').pop());
}

const base = {
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'git.enabled': false,
  'workbench.editor.enablePreview': false, 'window.titleBarStyle': 'custom', 'window.dialogStyle': 'custom', 'files.simpleDialog.enable': true,
  'zovoGit.askForRating': false,
};

let vs; let phase = '';
const shot = async name => { const f = path.join(shotDir, `${phase}-${name}.png`); await vs.shot(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ phase, name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log(v === false ? 'FAIL' : 'PASS', phase, name, v === undefined ? '' : JSON.stringify(v).slice(0, 300)); }
  catch (e) { R.steps.push({ phase, name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', phase, name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const W = expr => vs.wbEval(expr);
const dialogText = () => W(`(document.querySelector('.monaco-dialog-box') || {}).innerText || ''`);
const dialogButton = async (label) => {
  const b = await vs.waitFor(async () => JSON.parse(await W(`(() => { const a = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!a) return 'null'; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`)), 15000, 200);
  if (!b) throw new Error('no dialog button ' + label + ': ' + await dialogText());
  await vs.click(b.x, b.y);
};
const quickPick = async (text) => {
  const ok = await vs.waitFor(() => W(`!!document.querySelector('.quick-input-widget') && document.querySelector('.quick-input-widget').style.display !== 'none'`), 10000, 150);
  if (!ok) throw new Error('quick pick not shown');
  if (text) await vs.type(text);
  await sleep(400); await vs.key('Enter', 'Enter'); await sleep(400);
};
const notes = () => vs.notifications();

let launchedAt = 0;
async function open(folder, settings = {}, env = {}) {
  if (vs) { R.console.push(...vs.console.map(c => ({ phase: R._lastPhase, ...c }))); await vs.close(); vs = null; }
  const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  // never drive another lane's VS Code: the port must be free before we launch
  try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }); throw new Error(`port ${port} already answers: another program owns it`); } catch (e) { if (/already answers/.test(e.message)) throw e; }
  launchedAt = Date.now();
  vs = await launch(work, port, folder, { ...base, ...settings });
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  R._lastPhase = phase;
  await sleep(2500);
}
async function focusWindow() {
  // other lanes' windows take the focus; bring this VS Code (by pid) to the front, as the rating gate does
  spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${vs.child.pid}) to true`], { timeout: 10000 });
  await sleep(300);
}
async function graph() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await focusWindow();
    await vs.command('Commit Graph: Show Commit Graph');
    const wv = await vs.waitFor(async () => { const list = await vs.webviews(); for (const w of list) { const t = await vs.wvEval(w, `document.querySelector('.toolbar') ? 1 : 0`).catch(() => 0); if (t) return w; } return null; }, 12000, 300);
    if (wv) return wv;
  }
  throw new Error('graph webview not found');
}
const loaded = (wv, ms = 60000) => vs.waitFor(() => vs.wvEval(wv, `document.body.dataset.loaded ? Number(document.body.dataset.loaded) : (document.querySelector('.empty') && document.querySelector('.empty').style.display !== 'none' && /no commits|could not/.test(document.querySelector('.empty').textContent) ? -1 : 0)`), ms, 100);
const rowTexts = (wv) => vs.wvEval(wv, `[...document.querySelectorAll('#rows .row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
const clickRowBySubject = async (wv, subj, opts = {}) => vs.wvClick(wv, `[...document.querySelectorAll('#rows .row')].find(r => (r.querySelector('.subj') || {}).textContent === ${JSON.stringify(subj)})`, opts);

try {
  // ---------------------------------------------------------------------------------------------- big repository
  if (want('big')) {
    phase = 'big';
    const repo = path.join(FX, 'big200k');
    await open(repo);
    let wv;
    await step('graph opens', async () => { wv = await graph(); return true; });
    await step('first rows on screen under 2 s', async () => {
      const ms = await vs.waitFor(() => vs.wvEval(wv, `Number(document.body.dataset.firstPaintMs || 0)`), 20000, 50);
      return ms > 0 && ms < 2000 ? { firstPaintMs: ms } : false;
    });
    await step('all 200,000+ commits read', async () => { const n = await loaded(wv, 120000); const ms = await vs.wvEval(wv, `Number(document.body.dataset.loadMs)`); return n >= 200000 ? { rows: n, loadMs: ms } : false; });
    await shot('top');
    await step('scrolls without dropped frames (2,400 rows in 120 frames)', async () => {
      const r = JSON.parse(await vs.wvEval(wv, `new Promise(res => { const s = document.getElementById('scroller'); const t = []; let n = 0; let last = performance.now(); const go = () => { const now = performance.now(); t.push(now - last); last = now; s.scrollTop += 20 * 24; if (++n < 120) requestAnimationFrame(go); else res(JSON.stringify({ frames: t.length, over50: t.filter(x => x > 50).length, max: Math.round(Math.max(...t.slice(1))), avg: Math.round(t.slice(1).reduce((a, b) => a + b, 0) / (t.length - 1) * 10) / 10 })); }; requestAnimationFrame(go); })`));
      await sleep(600);
      const blank = await vs.wvEval(wv, `[...document.querySelectorAll('#rows .row .subj')].filter(x => x.textContent === '…').length`);
      return r.over50 <= 2 && blank === 0 ? { ...r, placeholdersAfter: blank } : { ...r, placeholdersAfter: blank, fail: true } && false;
    });
    await step('jump to the end draws the oldest commits', async () => {
      await vs.wvEval(wv, `document.getElementById('scroller').scrollTop = 1e9; 1`);
      const ok = await vs.waitFor(async () => (await rowTexts(wv)).some(t => /commit 000001 on lane 0/.test(t)), 5000, 100);
      await shot('bottom');
      return !!ok;
    });
    await step('search finds a commit far below the screen (full history)', async () => {
      await vs.wvEval(wv, `document.getElementById('scroller').scrollTop = 0; 1`); await sleep(300);
      await vs.wvClick(wv, `document.querySelector('.search input')`);
      await vs.type('commit 001234 on'); await vs.key('Enter', 'Enter');
      const n = await vs.waitFor(() => vs.wvEval(wv, `document.body.dataset.searchMatches || ''`), 60000, 100);
      await sleep(800);
      const sel = await vs.wvEval(wv, `(() => { const r = document.querySelector('#rows .row.sel'); return r ? { i: Number(r.dataset.i), text: r.innerText.replace(/\\s+/g, ' ') } : null; })()`);
      await shot('search');
      return n === '1' && sel && sel.i > 150000 && /commit 001234/.test(sel.text) ? { matches: n, row: sel.i } : false;
    });
    await step('details of a commit open; a file opens the VS Code diff', async () => {
      await vs.wvClick(wv, `document.querySelector('#rows .row.sel')`);
      const files = await vs.waitFor(() => vs.wvEval(wv, `document.querySelectorAll('#dfiles .file').length`), 10000, 100);
      await vs.wvClick(wv, `document.querySelector('#dfiles .file .st')`);
      const tab = await vs.waitFor(() => W(`[...document.querySelectorAll('.tab .label-name, .tab .monaco-icon-label')].map(t => t.textContent).find(t => t.includes('↔')) || ''`), 10000, 200);
      await shot('diff');
      return files >= 1 && tab ? { files, tab } : false;
    });
    await step('memory: graph worker about the size of the data', async () => {
      const out = extLog();
      const m = /graph big200k: (\d+) rows in (\d+) ms.*about (\d+) MB/.exec(out);
      const f = /first rows on screen (\d+) ms after load start/.exec(out);
      return m ? { rows: Number(m[1]), ms: Number(m[2]), MB: Number(m[3]), firstRowsLogMs: f ? Number(f[1]) : null } : false;
    });
  }

  // ---------------------------------------------------------------------------------------------- real repository
  if (want('express')) {
    phase = 'express';
    const repo = path.join(FX, 'express');
    await open(repo);
    let wv;
    await step('graph opens on a real repository', async () => { wv = await graph(); const n = await loaded(wv); return n > 1000 ? { rows: n } : false; });
    await shot('dark');
    const searchFor = async (mode, text) => {
      await vs.wvEval(wv, `(() => { const q = document.querySelector('.search input'); q.value = ''; q.dispatchEvent(new Event('input')); const s = document.querySelector('.search select'); s.value = ${JSON.stringify(mode)}; s.dispatchEvent(new Event('change')); return 1; })()`);
      await vs.wvClick(wv, `document.querySelector('.search input')`); await vs.type(text); await vs.key('Enter', 'Enter');
      const key = mode + ':' + text;
      await vs.waitFor(() => vs.wvEval(wv, `document.body.dataset.searchQuery === ${JSON.stringify(key)}`), 60000, 150);
      return Number(await vs.wvEval(wv, `document.body.dataset.searchMatches`));
    };
    await step('path search over the full history', async () => {
      const n = await searchFor('path', 'History.md');
      const cli = git(repo, 'log', '--branches', '--remotes', '--tags', 'HEAD', '--format=%H', '--', ':(glob,icase)**/*History.md*', ':(glob,icase)**/*History.md*/**').split('\n').filter(Boolean).length;
      return n === cli && cli > 100 ? { matches: n, cli } : false;
    });
    await step('changed-text search (-S)', async () => {
      const n = await searchFor('content', 'etag');
      const cli = git(repo, 'log', '--branches', '--remotes', '--tags', 'HEAD', '--format=%H', '-Setag', '--regexp-ignore-case', '--').split('\n').filter(Boolean).length;
      await sleep(500); await shot('search-S');
      return n === cli && cli > 0 ? { matches: n, cli } : { n, cli } && false;
    });
    await step('file history and line history', async () => {
      vs.open(path.join(repo, 'lib', 'response.js')); await sleep(2000);
      await vs.command('Commit Graph: Show File History');
      const fh = await vs.waitFor(async () => { for (const w of await vs.webviews()) { const c = await vs.wvEval(w, `document.body.dataset.count || ''`).catch(() => ''); if (c && c !== 'error') return Number(c); } return 0; }, 30000, 300);
      const cli = git(repo, 'log', '--follow', '--format=%H', 'HEAD', '--', 'lib/response.js').split('\n').filter(Boolean).length;
      await shot('file-history');
      return fh === cli && fh > 10 ? { fileHistory: fh, cli } : { fh, cli } && false;
    });
    await step('support footer: Rate, More free viewers, Sponsor, PayPal, Hide', async () => {
      const wv2 = (await vs.webviews()).find(Boolean);
      const t = await vs.wvEval(wv2 || wv, `(document.getElementById('zovo-support') || {}).innerText || ''`);
      return /Rate/.test(t) && /More free/.test(t) && /Sponsor/.test(t) && /PayPal/.test(t) && /Hide/.test(t) ? t.replace(/\s+/g, ' ') : false;
    });
  }

  if (want('light')) {
    phase = 'light';
    await open(path.join(FX, 'express'), { 'workbench.colorTheme': 'Default Light Modern' });
    await step('light theme: graph and details use the theme colours', async () => {
      const wv = await graph(); await loaded(wv);
      await vs.wvClick(wv, `[...document.querySelectorAll('#rows .row')][3]`);
      await vs.waitFor(() => vs.wvEval(wv, `document.querySelectorAll('#dfiles .file').length`), 10000, 100);
      await sleep(600);
      const bg = await vs.wvEval(wv, `getComputedStyle(document.body).backgroundColor`);
      await shot('graph');
      return /255, 255, 255|rgb\(2[45]\d, 2[45]\d, 2[45]\d\)/.test(bg) ? { body: bg } : { body: bg } && false;
    });
  }

  // ---------------------------------------------------------------------------------------------- write actions
  if (want('actions')) {
    phase = 'actions';
    const repo = path.join(FX, 'actions'); const cli = path.join(FX, 'actions-cli');
    await open(repo);
    let wv;
    await step('graph opens', async () => { wv = await graph(); return (await loaded(wv)) > 0; });
    await step('squash: preview shows the command and asks; Cancel changes nothing', async () => {
      const before = git(repo, 'rev-parse', 'HEAD');
      await clickRowBySubject(wv, 'step 7'); await sleep(300);
      await clickRowBySubject(wv, 'step 5', { modifiers: 8 }); await sleep(300);
      await vs.wvClick(wv, `[...document.querySelectorAll('#dmeta button')].find(b => /Squash These/.test(b.textContent))`);
      await quickPick('');
      const txt = await vs.waitFor(dialogText, 10000, 200);
      await shot('squash-confirm');
      await dialogButton('Cancel'); await sleep(800);
      return /git rebase -i --no-autosquash/.test(txt) && /fixup/.test(txt) && git(repo, 'rev-parse', 'HEAD') === before ? { dialog: txt.split('\n').slice(0, 12).join(' | ') } : false;
    });
    await step('squash runs and matches git rebase -i on the command line', async () => {
      await clickRowBySubject(wv, 'step 7'); await sleep(300);
      await clickRowBySubject(wv, 'step 5', { modifiers: 8 }); await sleep(300);
      await vs.wvClick(wv, `[...document.querySelectorAll('#dmeta button')].find(b => /Squash These/.test(b.textContent))`);
      await quickPick('');
      await vs.waitFor(dialogText, 10000, 200);
      await dialogButton('Squash');
      await vs.waitFor(() => git(repo, 'rev-list', '--count', 'HEAD') === '6', 20000, 300);
      // CLI: the same squash with git rebase -i
      const base = git(cli, 'rev-parse', 'HEAD~4');
      const ed = path.join(FX, 'seq-gate.sh');
      fs.writeFileSync(ed, '#!/bin/sh\nsed -i.bak -e "2,3s/^pick/fixup/" "$1"\n', { mode: 0o755 });
      execFileSync('git', ['rebase', '-i', base], { cwd: cli, env: { ...gitEnv, GIT_SEQUENCE_EDITOR: ed }, stdio: 'pipe' });
      const trees = ['HEAD', 'HEAD~1', 'HEAD~2', 'HEAD~3'].map(r => [git(repo, 'rev-parse', r + '^{tree}'), git(cli, 'rev-parse', r + '^{tree}')]);
      const authors = [git(repo, 'log', '-1', '--format=%an %at', 'HEAD~1'), git(cli, 'log', '-1', '--format=%an %at', 'HEAD~1')];
      await sleep(1500); await shot('squash-done');
      return trees.every(([a, b]) => a === b) && authors[0] === authors[1] && git(repo, 'rev-list', '--count', 'HEAD') === git(cli, 'rev-list', '--count', 'HEAD') ? { count: git(repo, 'rev-list', '--count', 'HEAD'), sameTrees: 4, author: authors[0] } : { trees, authors } && false;
    });
    await step('rebase: shows git rebase <branch>, asks, result matches the CLI', async () => {
      await sleep(1500);
      wv = await graph();
      await loaded(wv);
      await vs.wvEval(wv, `(() => { const r = [...document.querySelectorAll('.ref.head')].find(x => x.textContent === 'topic'); const e = new MouseEvent('contextmenu', { bubbles: true, clientX: r.getBoundingClientRect().x + 5, clientY: r.getBoundingClientRect().y + 5 }); r.dispatchEvent(e); return 1; })()`);
      await sleep(300);
      await vs.wvClick(wv, `[...document.querySelectorAll('#menu .mi')].find(m => /^Rebase main onto topic/.test(m.textContent))`);
      const txt = await vs.waitFor(dialogText, 10000, 200);
      await shot('rebase-confirm');
      await dialogButton('Rebase');
      await vs.waitFor(() => { try { return git(repo, 'merge-base', '--is-ancestor', 'topic', 'main') === ''; } catch { return false; } }, 20000, 300);
      execFileSync('git', ['rebase', 'topic'], { cwd: cli, env: gitEnv, stdio: 'pipe' });
      const same = git(repo, 'rev-parse', 'HEAD^{tree}') === git(cli, 'rev-parse', 'HEAD^{tree}') && git(repo, 'rev-list', '--count', 'HEAD') === git(cli, 'rev-list', '--count', 'HEAD');
      return /git rebase topic/.test(txt) && same ? { dialog: txt.split('\n').slice(0, 4).join(' | '), count: git(repo, 'rev-list', '--count', 'HEAD') } : { txt, same } && false;
    });
    await step('reset --hard: warning in the dialog, result matches the CLI', async () => {
      await sleep(1500);
      wv = await graph(); await loaded(wv);
      fs.appendFileSync(path.join(repo, 'f1.txt'), 'uncommitted\n');
      const target = git(repo, 'rev-parse', 'HEAD~2');
      const subj = git(repo, 'log', '-1', '--format=%s', target);
      await vs.wvEval(wv, `(() => { const r = [...document.querySelectorAll('#rows .row')].find(x => (x.querySelector('.subj') || {}).textContent === ${JSON.stringify(subj)}); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: r.getBoundingClientRect().y + 5 })); return 1; })()`);
      await sleep(300);
      await vs.wvClick(wv, `[...document.querySelectorAll('#menu .mi')].find(m => /^Reset main to Here/.test(m.textContent))`);
      await quickPick('Hard');
      const txt = await vs.waitFor(dialogText, 10000, 200);
      await shot('reset-confirm');
      await dialogButton('Reset and Discard Changes');
      await vs.waitFor(() => git(repo, 'rev-parse', 'HEAD') === target, 20000, 300);
      execFileSync('git', ['reset', '--hard', git(cli, 'rev-parse', 'HEAD~2')], { cwd: cli, env: gitEnv, stdio: 'pipe' });
      const clean = git(repo, 'status', '--porcelain') === '';
      return /git reset --hard/.test(txt) && /cannot be undone/.test(txt) && clean && git(repo, 'rev-parse', 'HEAD^{tree}') === git(cli, 'rev-parse', 'HEAD^{tree}') ? { dialog: txt.split('\n').slice(0, 5).join(' | ') } : false;
    });
  }

  // ---------------------------------------------------------------------------------------------- hostile + odd repos
  if (want('hostile')) {
    phase = 'hostile';
    const repo = path.join(FX, 'hostile-hooks');
    fs.rmSync(path.join(FX, 'PWNED'), { force: true });
    await open(repo);
    let wv;
    await step('hooks, fsmonitor, textconv, external diff and pager do not run on read commands', async () => {
      wv = await graph(); await loaded(wv);
      await vs.wvClick(wv, `document.querySelector('#rows .row')`);
      await vs.waitFor(() => vs.wvEval(wv, `document.querySelectorAll('#dfiles .file').length`), 10000, 100);
      await vs.wvClick(wv, `document.querySelector('#dfiles .file .st')`); await sleep(1500);
      await vs.wvClick(wv, `[...document.querySelectorAll('#rows .row')][1]`); await sleep(800);
      await vs.wvClick(wv, `document.querySelector('#dfiles .file .st')`); await sleep(1500);
      await vs.wvEval(wv, `(() => { const s = document.querySelector('.search select'); s.value = 'content'; s.dispatchEvent(new Event('change')); return 1; })()`);
      await vs.wvClick(wv, `document.querySelector('.search input')`); await vs.type('two'); await vs.key('Enter', 'Enter'); await sleep(2500);
      await shot('graph');
      return fs.existsSync(path.join(FX, 'PWNED')) ? false : { marker: 'absent' };
    });
    for (const [name, check] of [
      ['mid-rebase', async (w) => { const t = await vs.waitFor(() => vs.wvEval(w, `document.getElementById('banner').innerText`), 10000, 200); return /rebase is in progress/.test(t) && /Continue/.test(t) && /Abort/.test(t) ? t.split('\n')[0] : false; }],
      ['corrupt-pack', async (w) => { const t = await vs.waitFor(() => vs.wvEval(w, `document.getElementById('banner').innerText`), 20000, 200); return /damaged|could not read/i.test(t) ? t.split('\n')[0] : false; }],
      ['unicode-branches', async (w) => { await loaded(w); const t = await vs.wvEval(w, `[...document.querySelectorAll('.ref')].map(r => r.textContent).join(' ')`); return /feature\/ü-ñ\/日本語/.test(t) && /fix\/emoji-✨/.test(t) ? t : false; }],
      ['octopus', async (w) => { await loaded(w); const r = await vs.wvEval(w, `JSON.stringify(document.querySelector('#graph').width > 0)`); const t = await rowTexts(w); return t.some(x => /Octopus merge of 9 legs/.test(x)) && r ? { rows: t.length } : false; }],
      ['signed', async (w) => { const n = await loaded(w); return n === 4 ? { rows: n } : false; }],
      ['detached', async (w) => { await loaded(w); const t = await vs.wvEval(w, `[...document.querySelectorAll('.ref.detached')].length`); return t === 1 ? 'HEAD label shown' : false; }],
      ['with-submodules', async (w) => { await loaded(w); const o = await vs.wvEval(w, `[...document.querySelectorAll('.toolbar select')][0].innerText`); return /submodule/.test(o) ? o.replace(/\n/g, ' | ') : false; }],
      ['monorepo', async (w) => { const n = await loaded(w); const refs = await vs.wvEval(w, `document.querySelectorAll('.ref').length`); return n > 200 ? { rows: n, refsOnScreen: refs } : false; }],
      ['express-shallow', async (w) => { const n = await loaded(w); const t = await vs.wvEval(w, `document.querySelector('.status').innerText`); return n === 50 && /Shallow/.test(t) ? { rows: n } : false; }],
      ['empty', async (w) => { await loaded(w); const t = await vs.wvEval(w, `document.querySelector('.empty').textContent`); return /no commits yet/.test(t) ? t : false; }],
    ]) {
      phase = name;
      if (!fs.existsSync(path.join(FX, name))) { R.steps.push({ phase, name: 'fixture missing', ok: false }); continue; }
      await open(path.join(FX, name));
      await step('graph: ' + name, async () => { const w = await graph(); const r = await check(w); await shot('graph'); return r; });
    }
  }

  // ---------------------------------------------------------------------------------------------- rating ask v2.1
  if (want('rating')) {
    phase = 'rating';
    const repo = path.join(FX, 'signed');
    // a fresh profile: earlier phases opened a damaged repository on purpose, and the ask stays quiet 24 h after a failure
    if (vs) { R.console.push(...vs.console.map(c => ({ phase: R._lastPhase, ...c }))); await vs.close(); vs = null; }
    work = work + '-rating';
    fs.rmSync(work, { recursive: true, force: true });
    const inst = installVsix(work, vsix);
    if (inst.code !== 0) throw new Error('install for the rating profile failed');
    await open(repo, { 'zovoGit.askForRating': true });
    await step('session 1: graph works, no ask', async () => { const w = await graph(); await loaded(w); await sleep(4500); const n = await notes(); return n.some(x => /useful/.test(x)) ? false : { notes: n.length }; });
    await open(path.join(FX, 'octopus'), { 'zovoGit.askForRating': true }, { ZOVO_RATING_CLOCK_OFFSET_HOURS: '5' });
    await step('session 2, 5 hours later: the ask appears after a success', async () => {
      const w = await graph(); await loaded(w);
      // the ask needs window focus at the moment of a successful load; other lanes' windows take it, so bring
      // this window to the front and load again with Refresh (each load is a success)
      let n = null; const focus = [];
      for (let i = 0; i < 4 && !n; i++) {
        await focusWindow(); focus.push(await vs.wbEval('document.hasFocus()').catch(() => null));
        await vs.wvClick(w, `[...document.querySelectorAll('.toolbar button')].find(b => b.textContent === 'Refresh')`);
        n = await vs.waitFor(async () => (await notes()).find(x => /Is Commit Graph useful/.test(x)), 6000, 300);
      }
      R.ratingFocus = focus;
      await shot('ask');
      return n ? n.slice(0, 120) : false;
    });
  }
} finally {
  if (vs) { R.console.push(...vs.console.map(c => ({ phase: R._lastPhase, ...c }))); await vs.close(); }
  R.finished = new Date().toISOString();
  const ours = R.console.filter(c => /zovo|commit graph|graph\.js|history\.js|rebase\.js/i.test(c.where + ' ' + c.text) && c.type !== 'warning');
  R.consoleErrorsFromExtension = ours;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  const pass = R.steps.filter(s => s.ok).length; const fail = R.steps.filter(s => !s.ok).length;
  console.log(`\n${pass} pass, ${fail} fail, ${ours.length} console errors from the extension`);
}

function extLog() {
  const files = vs.extHostLogs().filter(f => /Commit Graph\.log$/.test(f) || /zovo\.zovo-git-commit-graph/.test(f));
  return files.filter(f => fs.statSync(f).mtimeMs >= launchedAt - 1000).map(f => fs.readFileSync(f, 'utf8')).join('\n');
}
