'use strict';
// Sequence editor for `git rebase -i`, run by git as: <node> seqedit.js <plan.json> <git-rebase-todo>.
// It replaces the todo list only when git listed exactly the commits the user saw in the preview, in the same order.
// Anything else (a new commit, autosquash, a different base) stops the rebase before it changes anything.
const fs = require('fs');

function verbOf(line) {
  const m = /^\s*(pick|p)\s+([0-9a-f]{4,64})\b/.exec(line);
  return m ? m[2] : null;
}

/** Returns { ok, text, error } for the todo text git wrote and the plan. Pure, for tests. */
function rewrite(todo, plan) {
  const lines = String(todo).split(/\r?\n/);
  const picks = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^(noop)\b/.test(t)) continue;
    const h = verbOf(t);
    if (!h) return { ok: false, error: 'git wrote an unexpected line in the todo list: ' + t.slice(0, 80) };
    picks.push(h);
  }
  const expect = plan.expect || [];
  if (picks.length !== expect.length) return { ok: false, error: `git listed ${picks.length} commits, the preview had ${expect.length}. Nothing was changed.` };
  for (let i = 0; i < picks.length; i++) {
    if (!expect[i].startsWith(picks[i]) && !picks[i].startsWith(expect[i])) return { ok: false, error: `Commit ${i + 1} in git's list (${picks[i]}) is not the one in the preview (${expect[i].slice(0, 12)}). Nothing was changed.` };
  }
  return { ok: true, text: plan.lines.join('\n') + '\n' };
}

if (require.main === module) {
  const [planFile, target] = process.argv.slice(2);
  try {
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const r = rewrite(fs.readFileSync(target, 'utf8'), plan);
    if (!r.ok) { process.stderr.write('Commit Graph: ' + r.error + '\n'); process.exit(1); }
    fs.writeFileSync(target, r.text);
  } catch (e) {
    process.stderr.write('Commit Graph: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { rewrite };
