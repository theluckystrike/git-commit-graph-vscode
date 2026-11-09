'use strict';
// Read-only file contents at a commit, for diffs and "Open File at This Commit". Uses git cat-file (no filters, no
// textconv). Files over the size limit and binary files show a short note instead of their bytes.
const path = require('path');
const { runGit } = require('./git/runner');

const SCHEME = 'zovo-git';
const EMPTY = '__empty__';

function toUri(vscode, root, ref, file) {
  const q = JSON.stringify({ root, ref: ref || EMPTY, path: file });
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + file.split(path.sep).join('/'), query: q });
}

function parseUri(uri) {
  try { const q = JSON.parse(uri.query); if (q && typeof q.root === 'string' && typeof q.path === 'string') return q; } catch (_) { /* bad uri */ }
  return null;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function createContentProvider({ vscode, getGit, settings, log }) {
  const onDidChange = new vscode.EventEmitter();
  return {
    onDidChange: onDidChange.event,
    async provideTextDocumentContent(uri) {
      const q = parseUri(uri);
      if (!q) return '';
      if (q.ref === EMPTY) return '';
      const git = getGit();
      const spec = `${q.ref}:${q.path.split(path.sep).join('/')}`;
      const max = settings().maxFileMB * 1024 * 1024;
      try {
        const size = Number((await runGit(git, ['cat-file', '-s', spec], { cwd: q.root, timeoutMs: 20000 })).stdout.trim());
        if (size > max) return `This file is ${(size / 1048576).toFixed(1)} MB at ${q.ref.slice(0, 12)}, over the ${settings().maxFileMB} MB limit (setting zovoGit.maxFileMB).\nIt is not loaded, so VS Code stays responsive. Raise the limit to see it.`;
        const r = await runGit(git, ['cat-file', 'blob', spec], { cwd: q.root, encoding: 'buffer', maxBytes: max + 1024, timeoutMs: 60000 });
        if (looksBinary(r.stdout)) return `Binary file, ${size.toLocaleString('en-US')} bytes at ${q.ref.slice(0, 12)}.`;
        return r.stdout.toString('utf8');
      } catch (e) {
        log && log(`cat-file ${spec}: ${e.message}`);
        if (/does not exist|exists on disk, but not in|invalid object name|Not a valid object name/i.test(e.stderr || e.message)) return '';
        if (/promisor|lazy fetch|missing/i.test(e.stderr || e.message)) return `This object is not in the local repository (partial clone). Commit Graph never downloads anything. To get it, run git show ${q.ref.slice(0, 12)}:${q.path} in a terminal, which lets git fetch it from your remote.\n\n${e.message}`;
        return `Could not read ${q.path} at ${q.ref.slice(0, 12)}: ${e.message}`;
      }
    },
    dispose() { onDidChange.dispose(); },
  };
}

module.exports = { SCHEME, EMPTY, toUri, parseUri, createContentProvider, looksBinary };
