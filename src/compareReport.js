'use strict';
// Branch comparison report (Pro candidate): ahead and behind counts, the merge base, the commits on each side, the
// changed files and the authors, as a Markdown document. Read-only git commands.
const { runGit, refArg } = require('./git/runner');
const P = require('./git/parse');

const MAX_COMMITS = 500;

async function logSide(git, cwd, range) {
  const r = await runGit(git, ['log', '--no-textconv', '--no-ext-diff', '-z', '--format=' + P.LOG_FORMAT, `--max-count=${MAX_COMMITS}`, range, '--'], { cwd, timeoutMs: 120000 });
  return r.stdout.split('\0').map(P.parseLogRecord).filter(Boolean);
}

async function compareBranches(git, cwd, a, b) {
  refArg(a); refArg(b);
  const [base, counts, left, right, ns, short] = await Promise.all([
    runGit(git, ['merge-base', a, b], { cwd, okCodes: [0, 1] }).then(r => r.stdout.trim()),
    runGit(git, ['rev-list', '--left-right', '--count', `${a}...${b}`, '--'], { cwd, timeoutMs: 120000 }).then(r => r.stdout.trim().split(/\s+/).map(Number)),
    logSide(git, cwd, `${b}..${a}`),
    logSide(git, cwd, `${a}..${b}`),
    runGit(git, ['diff', '-z', '-M', '--name-status', '--no-ext-diff', '--no-textconv', `${a}...${b}`, '--'], { cwd, timeoutMs: 120000, maxBytes: 64 * 1024 * 1024 }).then(r => P.parseNameStatus(r.stdout)),
    runGit(git, ['diff', '--shortstat', '-M', '--no-ext-diff', '--no-textconv', `${a}...${b}`, '--'], { cwd, timeoutMs: 120000 }).then(r => r.stdout.trim()),
  ]);
  return { a, b, base, behind: counts[0] || 0, ahead: counts[1] || 0, left, right, files: ns, shortstat: short };
}

const md = s => String(s).replace(/([\\`*_[\]<>|#])/g, '\\$1');

function reportMarkdown(r, now = new Date()) {
  const lines = [];
  lines.push(`# ${md(r.b)} compared with ${md(r.a)}`, '');
  lines.push(`Made by Commit Graph on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC from the local repository.`, '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Commits on ${md(r.b)} only | ${r.ahead} |`);
  lines.push(`| Commits on ${md(r.a)} only | ${r.behind} |`);
  lines.push(`| Merge base | ${r.base ? '`' + r.base.slice(0, 12) + '`' : 'none (unrelated histories)'} |`);
  lines.push(`| Files changed on ${md(r.b)} since the merge base | ${r.files.length}${r.shortstat ? ` (${md(r.shortstat)})` : ''} |`, '');
  const authors = new Map();
  for (const c of r.right) authors.set(c.author, (authors.get(c.author) || 0) + 1);
  if (authors.size) {
    lines.push(`## Authors on ${md(r.b)}`, '');
    for (const [name, n] of [...authors].sort((x, y) => y[1] - x[1])) lines.push(`- ${md(name)}: ${n}`);
    lines.push('');
  }
  const side = (title, list, total) => {
    lines.push(`## ${title} (${total})`, '');
    if (!list.length) { lines.push('None.', ''); return; }
    for (const c of list) lines.push(`- \`${c.hash.slice(0, 8)}\` ${md(c.subject)} (${md(c.author)}, ${new Date(c.date * 1000).toISOString().slice(0, 10)})`);
    if (total > list.length) lines.push(`- … and ${total - list.length} more`);
    lines.push('');
  };
  side(`Commits on ${md(r.b)} only`, r.right, r.ahead);
  side(`Commits on ${md(r.a)} only`, r.left, r.behind);
  lines.push(`## Files changed on ${md(r.b)} since the merge base`, '');
  const names = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type changed' };
  if (!r.files.length) lines.push('None.');
  for (const f of r.files.slice(0, 2000)) lines.push(`- ${names[f.status] || f.status}: \`${f.path.replace(/`/g, "'")}\`${f.oldPath && f.oldPath !== f.path ? ` (from \`${f.oldPath.replace(/`/g, "'")}\`)` : ''}`);
  if (r.files.length > 2000) lines.push(`- … and ${r.files.length - 2000} more`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { compareBranches, reportMarkdown };
