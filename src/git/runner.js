'use strict';
// Runs git without a shell. Read commands run with repository hooks and fsmonitor off, no external diff, no textconv
// filter, no pager, no optional locks and no lazy fetch of missing objects, so opening the graph never runs a
// program from the repository and never touches the network. Write commands (checkout, merge, rebase, ...) run
// only after the user confirmed them and behave like the same command typed in a terminal (hooks included).
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// A hooks folder that does not exist: git finds no hooks in it.
const NO_HOOKS = path.join(os.tmpdir(), 'zovo-git-no-hooks-' + crypto.randomBytes(8).toString('hex'));

const READ_CONFIG = [
  '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.untrackedCache=false',
  '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'color.ui=false', '-c', 'log.showSignature=false',
  '-c', 'core.quotePath=false', '-c', 'i18n.logOutputEncoding=UTF-8', '-c', 'log.decorate=false',
  '-c', 'diff.renames=true', '-c', 'core.sshCommand=false', '-c', 'protocol.allow=never',
  '--no-optional-locks',
];
// Write commands keep the user's hooks (as in a terminal) but never start fsmonitor or a pager.
const WRITE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'color.ui=false'];

class GitError extends Error {
  constructor(message, { code, stderr, args, timedOut, cancelled } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr || '';
    this.args = args || [];
    this.timedOut = !!timedOut;
    this.cancelled = !!cancelled;
  }
}

function baseEnv(extra, { lazyFetch = false } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', LC_MESSAGES: 'C', LANGUAGE: 'en' };
  if (!lazyFetch) env.GIT_NO_LAZY_FETCH = '1';
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE; delete env.GIT_ASKPASS_SET;
  return { ...env, ...(extra || {}) };
}

/** Full argv for a read command. */
function readArgs(args) { return [...READ_CONFIG, ...args]; }
function writeArgs(args) { return [...WRITE_CONFIG, ...args]; }

/**
 * Run git and collect its output. opts: cwd, write (bool), timeoutMs, maxBytes, input, env, token (cancellation),
 * encoding ('utf8' | 'buffer'), lazyFetch, okCodes (exit codes that are not errors).
 */
function runGit(git, args, opts = {}) {
  const full = opts.write ? writeArgs(args) : readArgs(args);
  const maxBytes = opts.maxBytes || 64 * 1024 * 1024;
  const okCodes = opts.okCodes || [0];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(git, full, { cwd: opts.cwd, env: baseEnv(opts.env, opts), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { reject(new GitError(e.message, { args })); return; }
    const out = []; const err = []; let outLen = 0; let errLen = 0; let done = false; let timedOut = false; let cancelled = false; let tooBig = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); if (sub) sub.dispose(); fn(); };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, opts.timeoutMs) : null;
    const sub = opts.token && opts.token.onCancellationRequested ? opts.token.onCancellationRequested(() => { cancelled = true; try { child.kill('SIGKILL'); } catch (_) {} }) : null;
    child.stdout.on('data', (d) => {
      if (tooBig) return;
      outLen += d.length;
      if (outLen > maxBytes) { tooBig = true; try { child.kill('SIGKILL'); } catch (_) {} return; }
      out.push(d);
    });
    child.stderr.on('data', (d) => { if (errLen < 256 * 1024) { err.push(d); errLen += d.length; } });
    child.on('error', (e) => finish(() => reject(new GitError(e.code === 'ENOENT' ? `git was not found (${git})` : e.message, { args, code: e.code }))));
    child.on('close', (code) => finish(() => {
      const stderr = Buffer.concat(err).toString('utf8');
      const buf = Buffer.concat(out);
      const stdout = opts.encoding === 'buffer' ? buf : buf.toString('utf8');
      if (tooBig) return reject(new GitError(`git output is larger than ${Math.round(maxBytes / 1048576)} MB`, { args, code, stderr }));
      if (timedOut) return reject(new GitError(`git ${args[0]} did not finish in ${Math.round(opts.timeoutMs / 1000)} s`, { args, code, stderr, timedOut: true }));
      if (cancelled) return reject(new GitError('Cancelled', { args, code, stderr, cancelled: true }));
      if (!okCodes.includes(code)) return reject(new GitError(firstLine(stderr) || `git ${args[0]} failed with exit code ${code}`, { args, code, stderr }));
      resolve({ stdout, stderr, code });
    }));
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/**
 * Stream git stdout. onChunk(buffer) is called per chunk; returns { promise, kill }.
 */
function streamGit(git, args, opts = {}) {
  const full = opts.write ? writeArgs(args) : readArgs(args);
  let child;
  let killed = false;
  const promise = new Promise((resolve, reject) => {
    try {
      child = spawn(git, full, { cwd: opts.cwd, env: baseEnv(opts.env, opts), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(new GitError(e.message, { args })); return; }
    const err = []; let errLen = 0;
    child.stdout.on('data', (d) => { if (!killed) opts.onChunk(d, child); });
    child.stderr.on('data', (d) => { if (errLen < 256 * 1024) { err.push(d); errLen += d.length; } });
    child.on('error', (e) => reject(new GitError(e.code === 'ENOENT' ? `git was not found (${git})` : e.message, { args, code: e.code })));
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (killed) return resolve({ code, stderr, killed: true });
      if (code !== 0) return reject(new GitError(firstLine(stderr) || `git ${args[0]} failed with exit code ${code}`, { args, code, stderr }));
      resolve({ code, stderr });
    });
  });
  return { promise, kill() { killed = true; try { child && child.kill('SIGKILL'); } catch (_) {} }, pause() { try { child.stdout.pause(); } catch (_) {} }, resume() { try { child.stdout.resume(); } catch (_) {} } };
}

function firstLine(s) {
  const lines = String(s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const fatal = lines.find(l => /^(fatal|error):/.test(l));
  return (fatal || lines[0] || '').slice(0, 500);
}

/** Version string of a git binary, or null. */
function gitVersion(git) {
  return new Promise((resolve) => {
    execFile(git, ['--version'], { timeout: 10000, windowsHide: true, env: baseEnv() }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /git version (\d+\.\d+(?:\.\d+)?)/.exec(String(stdout));
      resolve(m ? m[1] : null);
    });
  });
}

function versionAtLeast(v, major, minor) {
  const [a, b] = String(v || '0.0').split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

/** Finds git: the setting, then VS Code's own git path, then PATH and the usual places. */
async function findGit(configured, fromVsCode) {
  const tries = [];
  if (configured) tries.push(configured);
  if (fromVsCode) tries.push(fromVsCode);
  tries.push('git');
  if (process.platform === 'win32') tries.push('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe');
  else tries.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git');
  for (const t of tries) {
    if (t !== 'git' && path.isAbsolute(t) && !fs.existsSync(t)) continue;
    const v = await gitVersion(t);
    if (v) return { path: t, version: v };
  }
  return null;
}

/** The command line as the user would type it (without our safety options). */
function display(args) {
  return 'git ' + args.map(quoteArg).join(' ');
}
function quoteArg(a) {
  a = String(a);
  return /^[\w@%+=:,./^~{}-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

module.exports = { runGit, streamGit, findGit, gitVersion, versionAtLeast, display, quoteArg, GitError, READ_CONFIG, WRITE_CONFIG, NO_HOOKS, baseEnv, readArgs, firstLine };
