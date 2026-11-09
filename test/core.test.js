'use strict';
// Pure parts: parsers, the lane layout (window rebuild = full replay), the todo rewrite and the action plans.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/git/parse');
const { Layout, CHECKPOINT } = require('../src/graph/layout');
const { Store } = require('../src/graph/store');
const { rewrite } = require('../src/seqedit');
const rebase = require('../src/rebase');
const { plan, commandText } = require('../src/actions');
const { display, quoteArg } = require('../src/git/runner');

const H = i => i.toString(16).padStart(40, '0');

test('log records: valid, unicode, and a subject with our separator bytes cannot make up fields', () => {
  const rec = [H(1), `${H(2)} ${H(3)}`, 'Zoë Ünïcode', 'z@e.st', '1700000000', '1700000001', 'Merge branch "feat/ü"'].join('\x1f');
  const c = P.parseLogRecord(rec);
  assert.equal(c.hash, H(1));
  assert.deepEqual(c.parents, [H(2), H(3)]);
  assert.equal(c.author, 'Zoë Ünïcode');
  assert.equal(c.subject, 'Merge branch "feat/ü"');
  const evil = [H(1), '', 'a', 'b', '1', '1', `x\x1f${H(9)}\x1fmore`].join('\x1f');
  const e = P.parseLogRecord(evil);
  assert.equal(e.hash, H(1));
  assert.deepEqual(e.parents, []);
  assert.ok(e.subject.includes('more'));
  assert.equal(P.parseLogRecord('nothash\x1f\x1fa\x1fb\x1f1\x1f1\x1fs'), null);
  assert.equal(P.parseLogRecord(`${H(1)}\x1fbad-parent\x1fa\x1fb\x1f1\x1f1\x1fs`), null);
  // SHA-256 repositories
  assert.ok(P.parseLogRecord(['a'.repeat(64), '', 'a', 'b', '1', '1', 's'].join('\x1f')));
});

test('NUL splitter keeps multi-byte characters whole across chunk borders', () => {
  const s = P.nulSplitter();
  const buf = Buffer.from('héllo\0wörld\0tail', 'utf8');
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(...s.feed(buf.subarray(i, i + 1)));
  assert.deepEqual(out, ['héllo', 'wörld']);
  assert.equal(s.rest(), 'tail');
});

test('refs, stashes, status and name-status parsers', () => {
  const refs = P.parseRefs([
    [H(1), 'refs/heads/main', '', '*', 'origin/main', '[ahead 1]'].join('\x1f'),
    [H(2), 'refs/heads/feature/ü-ñ', '', ' ', '', ''].join('\x1f'),
    [H(3), 'refs/remotes/origin/HEAD', '', '', '', ''].join('\x1f'),
    [H(1), 'refs/remotes/origin/main', '', '', '', ''].join('\x1f'),
    [H(4), 'refs/tags/v1', H(1), '', '', ''].join('\x1f'),
  ].join('\n'));
  assert.equal(refs.head, 'main');
  assert.equal(refs.heads[1].name, 'feature/ü-ñ');
  assert.equal(refs.remotes.length, 1);
  assert.equal(refs.remotes[0].remote, 'origin');
  assert.equal(refs.tags[0].hash, H(1), 'annotated tag points at its commit');
  const st = P.parseStashes(`${[H(5), `${H(1)} ${H(6)}`, 'stash@{0}', '1700', 'me', 'WIP on main'].join('\x1f')}\0`);
  assert.equal(st[0].base, H(1));
  assert.equal(st[0].selector, 'stash@{0}');
  const status = P.parseStatus(' M a.txt\0R  new.txt\0old.txt\0?? u.txt\0');
  assert.deepEqual(status.map(s => s.path), ['a.txt', 'new.txt', 'u.txt']);
  assert.equal(status[1].orig, 'old.txt');
  const ns = P.parseNameStatus('M\0a b.txt\0R087\0old\0new\0D\0gone\0');
  assert.deepEqual(ns.map(f => [f.status, f.path, f.oldPath]), [['M', 'a b.txt', 'a b.txt'], ['R', 'new', 'old'], ['D', 'gone', 'gone']]);
  const num = P.parseNumstat('3\t1\ta b.txt\0-\t-\tbin\0' + '2\t0\t\0old\0new\0');
  assert.deepEqual(num.get('a b.txt'), { add: 3, del: 1 });
  assert.deepEqual(num.get('bin'), { add: -1, del: -1 });
  assert.deepEqual(num.get('new'), { add: 2, del: 0 });
});

test('ref name checks', () => {
  for (const ok of ['main', 'feature/x', 'fix-1.2', 'ünïcode/ß']) assert.equal(P.refNameProblem(ok), '', ok);
  for (const bad of ['', 'a b', 'a..b', '-x', 'x.lock', 'a~b', 'a^', 'a:b', '/x', 'x/', '@', 'a@{b']) assert.ok(P.refNameProblem(bad), bad);
});

test('operation detection', () => {
  const has = s => f => s.includes(f);
  assert.equal(P.operationFrom(has(['rebase-merge'])), 'rebase');
  assert.equal(P.operationFrom(has(['MERGE_HEAD'])), 'merge');
  assert.equal(P.operationFrom(has(['CHERRY_PICK_HEAD'])), 'cherry-pick');
  assert.equal(P.operationFrom(has([])), '');
});

// Reference: lanes active at the top of each row by full replay of the edges.
function fullReplay(lay) {
  const active = new Map(); const out = [];
  for (let r = 0; r < lay.rows; r++) {
    const edges = lay._rowEdges(r);
    const ins = new Set(edges.filter(e => e.kind === 0).map(e => e.lane));
    out.push([...active].filter(([l]) => !ins.has(l)).sort((a, b) => a[0] - b[0]));
    for (const l of ins) active.delete(l);
    for (const e of edges) if (e.kind === 1) active.set(e.lane, e.color);
  }
  return out;
}

function randomDag(n, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  // commits created oldest first; output newest first (children before parents)
  const commits = [];
  const tips = [];
  for (let i = 0; i < n; i++) {
    const parents = [];
    if (i > 0) {
      if (tips.length && rnd() < 0.7) parents.push(tips.splice(Math.floor(rnd() * tips.length), 1)[0]); else parents.push(Math.floor(rnd() * i));
      if (rnd() < 0.15 && i > 2) { const p = Math.floor(rnd() * i); if (!parents.includes(p)) parents.push(p); }
      if (rnd() < 0.02 && i > 10) for (let k = 0; k < 7; k++) { const p = Math.floor(rnd() * i); if (!parents.includes(p)) parents.push(p); }
    }
    commits.push({ hash: H(i + 1), parents: parents.map(p => H(p + 1)) });
    tips.push(i);
  }
  return commits.reverse();
}

test('layout: every window rebuilt from a checkpoint equals the full replay (random DAGs with octopus merges)', () => {
  for (const seed of [1, 7, 42]) {
    const lay = new Layout();
    const dag = randomDag(1500, seed);
    for (const c of dag) lay.add(c.hash, c.parents);
    const ref = fullReplay(lay);
    for (const [a, b] of [[0, 50], [CHECKPOINT - 3, CHECKPOINT + 40], [700, 777], [1400, 1500], [1499, 1500]]) {
      const w = lay.window(a, b);
      assert.equal(w.length, b - a);
      w.forEach((row, k) => assert.deepEqual(row.pass, ref[a + k], `seed ${seed} row ${a + k}`));
    }
    // each dot is drawn on its lane: the lanes that end in a row include the dot's lane when any lane was waiting
    for (let r = 0; r < lay.rows; r++) {
      const e = lay._rowEdges(r);
      const ins = e.filter(x => x.kind === 0).map(x => x.lane);
      if (ins.length) assert.ok(ins.includes(lay.col.get(r)));
    }
  }
});

test('layout: straight line, branch and merge, and octopus with 8 parents', () => {
  const lay = new Layout();
  // M merges B into A; A and B come from R
  lay.add(H(10), [H(1), H(2)]); // M
  lay.add(H(1), [H(0)]); // A
  lay.add(H(2), [H(0)]); // B
  lay.add(H(0), []); // R
  const w = lay.window(0, 4);
  assert.equal(w[0].col, 0);
  assert.deepEqual(w[0].outs.map(o => o[0]), [0, 1]);
  assert.equal(w[2].col, 1);
  assert.deepEqual(w[3].ins.map(i => i[0]).sort(), [0, 1]);
  assert.equal(lay.openLanes(), 0);
  const oct = new Layout();
  oct.add(H(100), [1, 2, 3, 4, 5, 6, 7, 8].map(H));
  for (let i = 1; i <= 8; i++) oct.add(H(i), [H(0)]);
  oct.add(H(0), []);
  assert.equal(oct.window(0, 1)[0].outs.length, 8);
  assert.equal(oct.window(9, 10)[0].ins.length, 8);
  assert.equal(oct.openLanes(), 0);
});

test('layout memory grows with edges: 200,000 commits on 30 branches stay small', () => {
  const lay = new Layout();
  const n = 200000;
  const t0 = Date.now();
  // 30 long-lived lanes, merged every 50 commits
  for (let i = n; i > 0; i--) {
    const lane = i % 30;
    const parents = [H(i > 30 ? i - 30 : 0)];
    if (lane === 0 && i % 50 === 0 && i > 60) parents.push(H(i - 31));
    lay.add(H(i), i > 30 ? parents : []);
  }
  const ms = Date.now() - t0;
  assert.ok(lay.bytes() < 40 * 1024 * 1024, `layout bytes ${lay.bytes()}`);
  assert.ok(ms < 8000, `layout took ${ms} ms`);
  const w = lay.window(150000, 150040);
  assert.equal(w.length, 40);
  assert.ok(w[0].pass.length >= 20);
});

test('store: search by subject, author, email and hash prefix; find by unique prefix', () => {
  const s = new Store();
  s.add({ hash: 'a'.repeat(40), parents: ['b'.repeat(40)], author: 'Ada', email: 'ada@x', date: 1, subject: 'Fix the parser' });
  s.add({ hash: 'b'.repeat(40), parents: [], author: 'Bob', email: 'bob@x', date: 1, subject: 'Initial commit' });
  assert.deepEqual(s.search({ text: 'parser' }), [0]);
  assert.deepEqual(s.search({ text: 'BOB' }), [1]);
  assert.deepEqual(s.search({ text: 'BOB', caseSensitive: true }), []);
  assert.deepEqual(s.search({ text: 'bbbb' }), [1]);
  assert.deepEqual(s.search({ text: '^Init', regex: true }), [1]);
  assert.throws(() => s.search({ text: '(', regex: true }), /not valid/);
  assert.equal(s.find('aaaa'), 0);
  assert.equal(s.find('zz'), -1);
  const rows = s.slice(0, 2, new Map([['a'.repeat(40), [{ type: 'head', name: 'main' }]]]));
  assert.equal(rows[0].refs[0].name, 'main');
  assert.equal(rows[1].g.col, 0);
});

const D = i => (['a1b2c3d', 'e4f5a6b', 'c7d8e9f'][i - 1] + '0'.repeat(33));
test('sequence editor: replaces the todo only when git listed exactly the preview commits', () => {
  const plan1 = { expect: [D(1), D(2), D(3)], lines: [`pick ${D(1)}`, `fixup ${D(2)}`, `pick ${D(3)}`] };
  const todo = `pick ${D(1).slice(0, 7)} one\npick ${D(2).slice(0, 7)} two\npick ${D(3).slice(0, 7)} three\n\n# Rebase ...\n# Commands:\n`;
  const ok = rewrite(todo, plan1);
  assert.equal(ok.ok, true);
  assert.equal(ok.text, plan1.lines.join('\n') + '\n');
  assert.equal(rewrite(`pick ${D(1).slice(0, 7)} one\npick ${D(3).slice(0, 7)} three\n`, plan1).ok, false);
  assert.equal(rewrite(`pick ${D(2).slice(0, 7)} two\npick ${D(1).slice(0, 7)} one\npick ${D(3).slice(0, 7)} three\n`, plan1).ok, false);
  assert.equal(rewrite(`pick ${D(1).slice(0, 7)}\nexec rm -rf /\npick ${D(2).slice(0, 7)}\npick ${D(3).slice(0, 7)}\n`, plan1).ok, false);
});

test('todo lines: squash groups, fixup, drop, reword and errors', () => {
  const c = [1, 2, 3, 4].map(i => ({ hash: H(i), message: 'm' + i }));
  const f = i => `/tmp/msg-${i}`;
  const sq = rebase.todoLines(rebase.squashItems(c, 1, 2, 'joined'), f);
  assert.deepEqual(sq.lines, [`pick ${H(1)}`, `pick ${H(2)}`, `fixup ${H(3)}`, 'exec git commit --amend --only --allow-empty --no-verify -F /tmp/msg-0', `pick ${H(4)}`]);
  assert.equal(sq.files[0].text, 'joined');
  const mixed = rebase.todoLines([
    { hash: H(1), action: 'pick', message: 'a' }, { hash: H(2), action: 'squash', message: 'b' }, { hash: H(3), action: 'drop', message: 'c' },
    { hash: H(4), action: 'reword', message: 'd', newMessage: 'D!' }], f);
  assert.deepEqual(mixed.lines, [`pick ${H(1)}`, `fixup ${H(2)}`, 'exec git commit --amend --only --allow-empty --no-verify -F /tmp/msg-0', `drop ${H(3)}`, `pick ${H(4)}`, 'exec git commit --amend --only --allow-empty --no-verify -F /tmp/msg-1']);
  assert.equal(mixed.files[0].text, 'a\n\nb');
  assert.equal(mixed.files[1].text, 'D!');
  assert.throws(() => rebase.todoLines([{ hash: H(1), action: 'squash', message: 'x' }], f), /first kept/);
  assert.throws(() => rebase.todoLines([{ hash: H(1), action: 'edit', message: 'x' }], f), /Unknown/);
  assert.match(rebase.describe('abc123', sq.lines), /^git rebase -i --no-autosquash abc123/);
});

test('action plans are the git commands a user would type, with -- where a name could look like a path', () => {
  assert.deepEqual(plan.checkout('main'), [['checkout', 'main', '--']]);
  assert.deepEqual(plan.checkoutRemote('feat', 'origin/feat'), [['checkout', '-b', 'feat', '--track', 'origin/feat']]);
  assert.deepEqual(plan.reset('abc', 'hard'), [['reset', '--hard', 'abc']]);
  assert.deepEqual(plan.cherryPick('abc', true), [['cherry-pick', '-m', '1', 'abc']]);
  assert.deepEqual(plan.revert('abc', false), [['revert', '--no-edit', 'abc']]);
  assert.deepEqual(plan.createTag('v1', 'abc', 'Release'), [['tag', '-a', 'v1', '-m', 'Release', 'abc']]);
  assert.deepEqual(plan.merge('feat', '--no-ff'), [['merge', '--no-ff', 'feat']]);
  assert.deepEqual(plan.deleteRemoteBranch('origin', 'x'), [['push', 'origin', '--delete', 'x']]);
  assert.equal(commandText(plan.createTag('v1', 'abc', "it's done")), "git tag -a v1 -m 'it'\\''s done' abc");
  assert.equal(display(['log', 'a b']), "git log 'a b'");
  assert.equal(quoteArg('feature/ü'), "'feature/ü'");
});
