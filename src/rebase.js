'use strict';
// Squash and interactive rebase, done with git's own `git rebase -i`. The todo list is written by seqedit.js, which
// first checks that git listed exactly the commits of the preview. New messages go through
// `exec git commit --amend -F <file>` lines, so no editor ever opens.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runGit, WRITE_CONFIG, baseEnv, quoteArg, display, firstLine } = require('./git/runner');
const { HASH } = require('./git/parse');

const ACTIONS = ['pick', 'reword', 'squash', 'fixup', 'drop'];

/** Commits from base (exclusive) to HEAD, oldest first: [{hash, parents, subject, message, author}]. */
async function commitsSince(git, cwd, base) {
  const range = base ? [`${base}..HEAD`] : ['HEAD'];
  const r = await runGit(git, ['log', '--no-textconv', '--no-ext-diff', '--reverse', '--topo-order', '-z', '--format=%H%x1f%P%x1f%an%x1f%s%x1f%B', ...range, '--'], { cwd, timeoutMs: 60000, maxBytes: 64 * 1024 * 1024 });
  const out = [];
  for (const rec of r.stdout.split('\0')) {
    const p = rec.replace(/^\n/, '').split('\x1f');
    if (p.length < 5 || !HASH.test(p[0])) continue;
    out.push({ hash: p[0], parents: p[1].split(' ').filter(Boolean), author: p[2], subject: p[3], message: p.slice(4).join('\x1f').replace(/\s+$/, '') });
  }
  return out;
}

async function isAncestor(git, cwd, a, b) {
  const r = await runGit(git, ['merge-base', '--is-ancestor', a, b], { cwd, okCodes: [0, 1], timeoutMs: 60000 });
  return r.code === 0;
}

async function cleanTree(git, cwd) {
  const r = await runGit(git, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=all'], { cwd, timeoutMs: 60000 });
  return r.stdout.replace(/\0/g, '').trim() === '';
}

/**
 * Checks a squash of the commits from `oldest` to `newest` (inclusive) on the current branch.
 * Returns { ok, reason } or { ok: true, base, root, commits (base..HEAD), from, to, mode: 'rebase' | 'reset' }.
 */
async function inspectSquash(git, cwd, a, b, { operation } = {}) {
  if (operation) return { ok: false, reason: `A ${operation} is in progress. Finish or abort it first.` };
  const head = (await runGit(git, ['rev-parse', '--verify', '-q', 'HEAD'], { cwd, okCodes: [0, 1, 128] })).stdout.trim();
  if (!HASH.test(head)) return { ok: false, reason: 'This repository has no commits yet.' };
  let oldest = a; let newest = b;
  if (await isAncestor(git, cwd, b, a) && a !== b) { oldest = b; newest = a; }
  if (oldest === newest) return { ok: false, reason: 'Select two different commits (click one, then Shift+click the other).' };
  if (!(await isAncestor(git, cwd, newest, 'HEAD'))) return { ok: false, reason: 'Both commits must be on the checked-out branch (in the history of HEAD).' };
  if (!(await isAncestor(git, cwd, oldest, newest))) return { ok: false, reason: 'The two commits are not on one line of history.' };
  if (!(await cleanTree(git, cwd))) return { ok: false, reason: 'You have uncommitted changes to tracked files. Commit or stash them first.' };
  const parentsOut = (await runGit(git, ['rev-list', '--parents', '-n', '1', oldest], { cwd })).stdout.trim().split(' ');
  const oldestParents = parentsOut.slice(1);
  if (oldestParents.length > 1) return { ok: false, reason: 'The oldest selected commit is a merge commit. Squash works on a straight line of commits.' };
  const base = oldestParents[0] || null;
  const commits = await commitsSince(git, cwd, base);
  const from = commits.findIndex(c => c.hash === oldest);
  const to = commits.findIndex(c => c.hash === newest);
  if (from < 0 || to < 0) return { ok: false, reason: 'The selected commits are not on the first-parent line of HEAD.' };
  const inRange = commits.slice(from, to + 1);
  if (inRange.some(c => c.parents.length > 1)) return { ok: false, reason: 'The range has a merge commit. Squash works on a straight line of commits.' };
  // Every commit between oldest and newest must be in the chain (no side branch commits).
  for (let i = from + 1; i <= to; i++) if (commits[i].parents[0] !== commits[i - 1].hash) return { ok: false, reason: 'The range is not a straight line of commits.' };
  if (commits.some(c => c.parents.length > 1)) return { ok: false, reason: 'There are merge commits between the range and HEAD. A rebase would flatten them, so this squash is not offered.' };
  return { ok: true, head, base, root: !base, commits, from, to };
}

/** Default message for a squash: every message, oldest first, separated by a blank line. */
function squashMessage(commits) { return commits.map(c => c.message).join('\n\n'); }

/**
 * Todo lines for a plan: items [{hash, action, message}] oldest first. Squash groups end with an exec that sets the
 * message; reword is a pick followed by such an exec. msgFile(i) returns the path for the i-th message file.
 */
function todoLines(items, msgFile) {
  const lines = []; const files = [];
  const addMsg = (text) => { const f = msgFile(files.length); files.push({ file: f, text }); lines.push(`exec git commit --amend --only --allow-empty --no-verify -F ${quoteArg(f)}`); };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!ACTIONS.includes(it.action)) throw new Error('Unknown action: ' + it.action);
    if (it.action === 'drop') { lines.push(`drop ${it.hash}`); continue; }
    if ((it.action === 'squash' || it.action === 'fixup')) {
      const prevKept = items.slice(0, i).some(x => x.action !== 'drop');
      if (!prevKept) throw new Error('The first kept commit cannot be squash or fixup: there is no commit before it to join.');
      lines.push(`fixup ${it.hash}`);
    } else lines.push(`pick ${it.hash}`);
    const next = items.slice(i + 1).find(x => x.action !== 'drop');
    const groupEnds = !next || (next.action !== 'squash' && next.action !== 'fixup');
    if (groupEnds) {
      // find the group start (the pick or reword this group folds into)
      let s = i; while (s > 0 && (items[s].action === 'squash' || items[s].action === 'fixup' || items[s].action === 'drop')) s--;
      const group = items.slice(s, i + 1).filter(x => x.action !== 'drop');
      const hasSquash = group.some(x => x.action === 'squash');
      const lead = group[0];
      if (lead.action === 'reword' || hasSquash || lead.newMessage != null) {
        const text = lead.newMessage != null ? lead.newMessage : group.filter(x => x === lead || x.action === 'squash').map(x => x.message).join('\n\n');
        addMsg(text);
      }
    }
  }
  return { lines, files };
}

/** Items for squashing commits[from..to] into one with `message`. */
function squashItems(commits, from, to, message) {
  return commits.map((c, i) => ({ hash: c.hash, message: c.message, action: i > from && i <= to ? 'fixup' : 'pick', newMessage: i === from ? message : undefined }));
}

function workDir(gitDir) {
  const d = path.join(gitDir, 'zovo-commit-graph');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** The text shown in the confirmation: the command and the todo list git will get. */
function describe(base, lines) {
  return [display(['rebase', '-i', '--no-autosquash', base || '--root']), '', 'with this todo list:', ...lines.map(l => '  ' + l)].join('\n');
}

/**
 * Runs git rebase -i with the plan. Returns { ok, stopped, output }. Never throws for a git failure.
 */
function runRebase({ git, cwd, gitDir, base, items, expect, nodePath, token }) {
  const dir = workDir(gitDir);
  const stamp = Date.now().toString(36);
  const { lines, files } = todoLines(items, i => path.join(dir, `msg-${stamp}-${i}.txt`));
  for (const f of files) fs.writeFileSync(f.file, f.text.replace(/\s*$/, '') + '\n');
  const planFile = path.join(dir, `plan-${stamp}.json`);
  fs.writeFileSync(planFile, JSON.stringify({ expect: expect || items.map(i => i.hash), lines }));
  const node = nodePath || process.execPath;
  const seq = `${quoteArg(node)} ${quoteArg(path.join(__dirname, 'seqedit.js'))} ${quoteArg(planFile)}`;
  const args = [...WRITE_CONFIG, '-c', 'rebase.updateRefs=false', '-c', 'rebase.abbreviateCommands=false', '-c', 'rebase.missingCommitsCheck=ignore',
    '-c', 'rebase.instructionFormat=%s', '-c', 'rebase.autoStash=false', '-c', 'core.editor=true',
    'rebase', '-i', '--no-autosquash', base || '--root'];
  const env = baseEnv({ GIT_SEQUENCE_EDITOR: seq, GIT_EDITOR: 'true', ELECTRON_RUN_AS_NODE: '1' }, { lazyFetch: true });
  return new Promise((resolve) => {
    const child = spawn(git, args, { cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const sub = token && token.onCancellationRequested ? token.onCancellationRequested(() => { try { child.kill('SIGTERM'); } catch (_) {} }) : null;
    const done = (ok, extra) => {
      if (sub) sub.dispose();
      try { fs.rmSync(planFile, { force: true }); } catch (_) {}
      const stopped = fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
      if (!stopped) for (const f of files) { try { fs.rmSync(f.file, { force: true }); } catch (_) {} }
      resolve({ ok, stopped, output: out + (extra || ''), message: ok ? '' : firstLine(out) || 'git rebase failed' });
    };
    child.on('error', e => done(false, e.message));
    child.on('close', code => done(code === 0));
  });
}

module.exports = { inspectSquash, commitsSince, squashMessage, todoLines, squashItems, runRebase, describe, cleanTree, isAncestor, ACTIONS };
