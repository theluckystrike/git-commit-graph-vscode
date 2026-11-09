'use strict';
// Small real git repositories for tests, in the temp folder (each well under 1 MB). The user's git config is not
// read: GIT_CONFIG_GLOBAL points at an empty file and GIT_CONFIG_NOSYSTEM is set for this process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zgit-test-'));
const GLOBAL = path.join(ROOT, 'gitconfig');
fs.writeFileSync(GLOBAL, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
process.env.GIT_CONFIG_GLOBAL = GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '';
delete process.env.GIT_AUTHOR_DATE; delete process.env.GIT_COMMITTER_DATE;

let n = 0;
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: process.env.T_DATE || '', GIT_COMMITTER_DATE: process.env.T_DATE || '' }, stdio: ['pipe', 'pipe', 'pipe'] });
}

let clock = 1700000000;
function commit(cwd, file, text, msg) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', '--', file);
  clock += 60;
  process.env.T_DATE = `${clock} +0000`;
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

function repo(name) {
  const dir = path.join(ROOT, `${name}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

function cleanup() { fs.rmSync(ROOT, { recursive: true, force: true }); }

module.exports = { ROOT, git, commit, repo, cleanup };
