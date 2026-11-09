'use strict';
// Every action that changes the repository: it asks for what it needs, shows the exact git command in a modal
// confirmation, runs it only after "Run", and refreshes the graph. Nothing runs without that click.
const { runGit, display, refArg: arg } = require('./git/runner');
const { refNameProblem } = require('./git/parse');
const rebase = require('./rebase');

const short = h => String(h || '').slice(0, 8);

/** Plans: pure functions from inputs to the git commands (tests check them). */
const plan = {
  checkout: (name) => [['checkout', arg(name), '--']],
  checkoutDetached: (hash) => [['checkout', '--detach', arg(hash)]],
  checkoutRemote: (local, remoteRef) => [['checkout', '-b', arg(local), '--track', arg(remoteRef)]],
  createBranch: (name, hash, checkout) => (checkout ? [['checkout', '-b', arg(name), arg(hash)]] : [['branch', arg(name), arg(hash)]]),
  deleteBranch: (name, force) => [['branch', force ? '-D' : '-d', arg(name)]],
  deleteRemoteBranch: (remote, branch) => [['push', arg(remote), '--delete', arg(branch)]],
  renameBranch: (from, to) => [['branch', '-m', arg(from), arg(to)]],
  createTag: (name, hash, message) => (message ? [['tag', '-a', arg(name), '-m', message, arg(hash)]] : [['tag', arg(name), arg(hash)]]),
  deleteTag: (name) => [['tag', '-d', arg(name)]],
  pushTag: (remote, name) => [['push', arg(remote), 'refs/tags/' + name]],
  merge: (ref, mode) => [['merge', ...(mode ? [mode] : []), arg(ref)]],
  rebaseOnto: (ref) => [['rebase', arg(ref)]],
  cherryPick: (hash, isMerge) => [['cherry-pick', ...(isMerge ? ['-m', '1'] : []), arg(hash)]],
  revert: (hash, isMerge) => [['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), arg(hash)]],
  reset: (hash, mode) => [['reset', '--' + mode, arg(hash)]],
  stashApply: (sel) => [['stash', 'apply', arg(sel)]],
  stashPop: (sel) => [['stash', 'pop', arg(sel)]],
  stashDrop: (sel) => [['stash', 'drop', arg(sel)]],
  stashPush: (message, untracked) => [['stash', 'push', ...(untracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])]],
  fetchAll: (prune) => [['fetch', '--all', ...(prune ? ['--prune'] : [])]],
  pull: () => [['pull', '--ff-only']],
  push: (remote, branch, setUpstream) => [['push', ...(setUpstream ? ['--set-upstream'] : []), arg(remote), arg(branch)]],
  forcePush: (remote, branch) => [['push', '--force-with-lease', arg(remote), arg(branch)]],
  abort: (op) => [[op === 'am' ? 'am' : op, '--abort']],
  cont: (op) => [[op === 'am' ? 'am' : op, '--continue']],
  skip: (op) => [[op === 'am' ? 'am' : op, '--skip']],
};

/** The part of git's error output a toast shows: the fatal/error line first (it names the file or ref), then the last lines. */
function failureText(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-3);
  const fatal = lines.find(l => /^(fatal|error):/.test(l));
  const parts = fatal && !tail.includes(fatal) ? [fatal, ...lines.slice(-2)] : tail;
  return parts.join(' ').slice(0, 400);
}

function commandText(cmds) { return cmds.map(c => display(c)).join('\n'); }

class Actions {
  constructor({ vscode, getGit, log, onChanged }) {
    this.vscode = vscode; this.getGit = getGit; this.log = log || (() => {}); this.onChanged = onChanged || (() => {});
  }

  async confirm(title, cmds, { warning = '', button = 'Run', extra = '' } = {}) {
    const detail = [`This runs:\n${typeof cmds === 'string' ? cmds : commandText(cmds)}`, extra, warning].filter(Boolean).join('\n\n');
    const pick = await this.vscode.window.showWarningMessage(title, { modal: true, detail }, button);
    return pick === button;
  }

  async run(repo, cmds, { title, network = false, quiet = false } = {}) {
    const vscode = this.vscode;
    const git = this.getGit();
    const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: title || commandText(cmds), cancellable: network }, async (_p, token) => {
      for (const c of cmds) {
        const args = Array.isArray(c) ? c : c.args;
        this.log('$ ' + display(args));
        try {
          const r = await runGit(git, args, { cwd: repo.root, write: true, timeoutMs: network ? 15 * 60000 : 5 * 60000, token, input: c.input, env: { GIT_EDITOR: 'true' }, lazyFetch: true });
          if (r.stderr.trim()) this.log(r.stderr.trim());
        } catch (e) {
          this.log((e.stderr || e.message).trim());
          return { ok: false, error: e, args };
        }
      }
      return { ok: true };
    });
    this.onChanged(repo);
    if (!res.ok) {
      const e = res.error;
      const text = (e.stderr || e.message || '').trim();
      const msg = `${display(res.args)} failed: ${failureText(text)}`;
      vscode.window.showErrorMessage(msg, 'Show Output').then(c => { if (c === 'Show Output') vscode.commands.executeCommand('zovoGit.showOutput'); });
      return false;
    }
    if (!quiet) vscode.window.setStatusBarMessage(`$(check) ${commandText(cmds).split('\n')[0]}`, 4000);
    return true;
  }

  async ask(cmds, repo, title, opts = {}) {
    if (!(await this.confirm(title, cmds, opts))) return false;
    return this.run(repo, cmds, { title, network: opts.network });
  }

  async inputName(prompt, value, kind = 'branch') {
    return this.vscode.window.showInputBox({ title: prompt, prompt, value, validateInput: v => refNameProblem(v) || null, ignoreFocusOut: true, placeHolder: kind === 'tag' ? 'v1.2.0' : 'feature/my-change' });
  }

  // ---- branch and commit actions -------------------------------------------------------------------------------
  checkoutBranch(repo, name) { return this.ask(plan.checkout(name), repo, `Check out branch "${name}"?`); }

  async checkoutRemote(repo, remoteName, branch, localExists) {
    if (localExists) return this.ask(plan.checkout(branch), repo, `Check out the local branch "${branch}"?`, { extra: `A local branch named ${branch} already exists, so it is checked out instead of a new one.` });
    const name = await this.inputName(`Name of the new local branch for ${remoteName}`, branch);
    if (!name) return false;
    return this.ask(plan.checkoutRemote(name, remoteName), repo, `Create "${name}" from ${remoteName} and check it out?`);
  }

  checkoutCommit(repo, hash) {
    return this.ask(plan.checkoutDetached(hash), repo, `Check out commit ${short(hash)}?`, { extra: 'You will be on a detached HEAD: new commits belong to no branch until you create one.' });
  }

  async createBranch(repo, hash) {
    const name = await this.inputName(`New branch at ${short(hash)}`, '');
    if (!name) return false;
    const choice = await this.vscode.window.showQuickPick([{ label: 'Create branch', id: false }, { label: 'Create and check out', id: true }], { title: `Branch "${name}" at ${short(hash)}` });
    if (!choice) return false;
    return this.ask(plan.createBranch(name, hash, choice.id), repo, `Create branch "${name}" at ${short(hash)}?`);
  }

  async deleteBranch(repo, name) {
    // git refuses to delete a branch that is not merged into HEAD with -d; ask for the forced delete up front then
    const merged = await runGit(this.getGit(), ['branch', '--merged', 'HEAD', '--format=%(refname:short)'], { cwd: repo.root })
      .then(r => r.stdout.split('\n').includes(name)).catch(() => true);
    if (merged) return this.ask(plan.deleteBranch(name, false), repo, `Delete branch "${name}"?`, { button: 'Delete' });
    return this.ask(plan.deleteBranch(name, true), repo, `"${name}" has commits that are not merged into the current branch. Delete it anyway?`, { button: 'Force Delete', warning: 'The commits only on this branch stay in the reflog for a while, then git removes them.' });
  }

  deleteRemoteBranch(repo, remote, branch) {
    return this.ask(plan.deleteRemoteBranch(remote, branch), repo, `Delete "${branch}" on the remote "${remote}"?`, { button: 'Delete on Remote', network: true, warning: 'This changes the remote for everyone who uses it. Your git contacts the remote with your own credentials.' });
  }

  async renameBranch(repo, name) {
    const to = await this.inputName(`Rename branch "${name}" to`, name);
    if (!to || to === name) return false;
    return this.ask(plan.renameBranch(name, to), repo, `Rename "${name}" to "${to}"?`);
  }

  async createTag(repo, hash) {
    const name = await this.inputName(`New tag at ${short(hash)}`, '', 'tag');
    if (!name) return false;
    const message = await this.vscode.window.showInputBox({ title: `Tag "${name}": message (leave empty for a lightweight tag)`, prompt: 'Message for an annotated tag, or empty', ignoreFocusOut: true });
    if (message === undefined) return false;
    return this.ask(plan.createTag(name, hash, message.trim()), repo, `Create tag "${name}" at ${short(hash)}?`);
  }

  deleteTag(repo, name) { return this.ask(plan.deleteTag(name), repo, `Delete tag "${name}"?`, { button: 'Delete', extra: 'Only the local tag is deleted.' }); }

  async pushTag(repo, name, remotes) {
    const remote = await this.pickRemote(remotes);
    if (!remote) return false;
    return this.ask(plan.pushTag(remote, name), repo, `Push tag "${name}" to "${remote}"?`, { button: 'Push', network: true, extra: 'Your git contacts the remote with your own credentials.' });
  }

  async merge(repo, ref, current) {
    const modes = [
      { label: 'Merge', description: 'git merge (fast-forward when possible)', mode: '' },
      { label: 'Merge with a merge commit', description: '--no-ff', mode: '--no-ff' },
      { label: 'Fast-forward only', description: '--ff-only', mode: '--ff-only' },
      { label: 'Squash merge', description: '--squash (stages the changes, you commit)', mode: '--squash' },
    ];
    const m = await this.vscode.window.showQuickPick(modes, { title: `Merge ${ref} into ${current || 'HEAD'}` });
    if (!m) return false;
    return this.ask(plan.merge(ref, m.mode), repo, `Merge "${ref}" into "${current || 'HEAD'}"?`, { button: 'Merge' });
  }

  rebaseOnto(repo, ref, current) {
    return this.ask(plan.rebaseOnto(ref), repo, `Rebase "${current || 'HEAD'}" onto "${ref}"?`, { button: 'Rebase', warning: 'Rebase rewrites the commits of the current branch. If they are already pushed, others who use them will have to rebase too. If git stops on a conflict, the graph shows Continue and Abort.' });
  }

  cherryPick(repo, hash, isMerge) { return this.ask(plan.cherryPick(hash, isMerge), repo, `Cherry-pick ${short(hash)} onto the current branch?`, { button: 'Cherry-pick', extra: isMerge ? 'This is a merge commit: its changes are taken relative to its first parent (-m 1).' : '' }); }

  revert(repo, hash, isMerge) { return this.ask(plan.revert(hash, isMerge), repo, `Revert ${short(hash)}?`, { button: 'Revert', extra: 'This adds a new commit that undoes the changes of the selected commit.' + (isMerge ? ' Merge commit: undone relative to its first parent (-m 1).' : '') }); }

  async reset(repo, hash, current) {
    const modes = [
      { label: 'Soft', description: 'keep all changes staged', mode: 'soft' },
      { label: 'Mixed', description: 'keep all changes, unstaged (default)', mode: 'mixed' },
      { label: 'Hard', description: 'discard all changes to tracked files', mode: 'hard' },
    ];
    const m = await this.vscode.window.showQuickPick(modes, { title: `Reset ${current || 'HEAD'} to ${short(hash)}` });
    if (!m) return false;
    const warning = m.mode === 'hard'
      ? 'WARNING: --hard throws away every uncommitted change to tracked files. It cannot be undone. Commits after this point are only kept in the reflog.'
      : 'Commits after this point leave the branch. They are kept in the reflog for a while.';
    return this.ask(plan.reset(hash, m.mode), repo, `Reset "${current || 'HEAD'}" to ${short(hash)} (${m.mode})?`, { button: m.mode === 'hard' ? 'Reset and Discard Changes' : 'Reset', warning });
  }

  // ---- squash --------------------------------------------------------------------------------------------------
  async squash(repo, a, b, operation) {
    const vscode = this.vscode;
    const git = this.getGit();
    const ins = await rebase.inspectSquash(git, repo.root, a, b, { operation });
    if (!ins.ok) { vscode.window.showWarningMessage('Squash: ' + ins.reason); return false; }
    const picked = ins.commits.slice(ins.from, ins.to + 1);
    const def = rebase.squashMessage(picked);
    const first = def.split('\n')[0];
    const subject = await vscode.window.showInputBox({ title: `Squash ${picked.length} commits into one: message`, prompt: 'First line of the new message. The full messages of the squashed commits follow as the body.', value: first, ignoreFocusOut: true, validateInput: v => (v.trim() ? null : 'Type a message.') });
    if (!subject) return false;
    const rest = picked.map(c => c.message).join('\n\n');
    const message = subject.trim() === first.trim() ? def : `${subject.trim()}\n\n${rest}`;
    const items = rebase.squashItems(ins.commits, ins.from, ins.to, message);
    const { lines } = rebase.todoLines(items, i => `<message file ${i + 1}>`);
    const after = ins.commits.length - ins.to - 1;
    const preview = [`Squash these ${picked.length} commits (oldest first):`, ...picked.map(c => `  ${short(c.hash)} ${c.subject}`), '',
      after ? `${after} later commit${after === 1 ? '' : 's'} on top ${after === 1 ? 'is' : 'are'} replayed unchanged.` : 'The range ends at HEAD.', '', 'New message:', message.split('\n').slice(0, 6).map(l => '  ' + l).join('\n')].join('\n');
    const ok = await this.confirm(`Squash ${picked.length} commits into one?`, rebase.describe(ins.base ? short(ins.base) : null, lines), { button: 'Squash', extra: preview, warning: 'This rewrites the commits of the current branch. The old commits stay in the reflog for a while.' });
    if (!ok) return false;
    return this.runPlan(repo, ins.base, items, `Squashing ${picked.length} commits`);
  }

  async runPlan(repo, base, items, title, expect) {
    const vscode = this.vscode;
    this.log(`$ ${rebase.describe(base, rebase.todoLines(items, i => `msg-${i}`).lines).replace(/\n/g, '\n  ')}`);
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => rebase.runRebase({ git: this.getGit(), cwd: repo.root, gitDir: repo.gitDir, base, items, expect }));
    if (r.output.trim()) this.log(r.output.trim());
    this.onChanged(repo);
    if (r.ok) { vscode.window.setStatusBarMessage('$(check) ' + title + ': done', 5000); return true; }
    if (r.stopped) vscode.window.showWarningMessage(`git stopped during the rebase: ${r.message}. Resolve it in Source Control, then use Continue or Abort in the graph.`);
    else vscode.window.showErrorMessage(`The rebase did not run: ${r.message}`, 'Show Output').then(c => { if (c) vscode.commands.executeCommand('zovoGit.showOutput'); });
    return false;
  }

  // ---- stash, remote, in-progress operations -------------------------------------------------------------------
  stashApply(repo, sel) { return this.ask(plan.stashApply(sel), repo, `Apply ${sel}?`, { button: 'Apply', extra: 'The stash stays in the list.' }); }
  stashPop(repo, sel) { return this.ask(plan.stashPop(sel), repo, `Pop ${sel}?`, { button: 'Pop', extra: 'The stash is applied and removed from the list when it applies cleanly.' }); }
  stashDrop(repo, sel) { return this.ask(plan.stashDrop(sel), repo, `Drop ${sel}?`, { button: 'Drop', warning: 'The stash is removed. It can only be found again with git fsck.' }); }
  async stashPush(repo) {
    const message = await this.vscode.window.showInputBox({ title: 'Stash uncommitted changes: message (optional)', ignoreFocusOut: true });
    if (message === undefined) return false;
    const u = await this.vscode.window.showQuickPick([{ label: 'Tracked files only', id: false }, { label: 'Include untracked files', id: true }], { title: 'What to stash' });
    if (!u) return false;
    return this.ask(plan.stashPush(message.trim(), u.id), repo, 'Stash the uncommitted changes?', { button: 'Stash' });
  }

  async pickRemote(remotes) {
    const list = [...new Set(remotes || [])];
    if (!list.length) { this.vscode.window.showWarningMessage('This repository has no remote.'); return null; }
    if (list.length === 1) return list[0];
    const p = await this.vscode.window.showQuickPick(list, { title: 'Remote' });
    return p || null;
  }

  gitFetch(repo, prune) { return this.ask(plan.fetchAll(prune), repo, 'Fetch from all remotes?', { button: 'Fetch', network: true, extra: 'Your git contacts the remotes with your own credentials. Commit Graph stores none.' }); }
  pull(repo, current) { return this.ask(plan.pull(), repo, `Pull into "${current}" (fast-forward only)?`, { button: 'Pull', network: true, extra: 'Your git contacts the remote with your own credentials.' }); }

  async push(repo, branch, upstream, remotes) {
    if (!branch) { this.vscode.window.showWarningMessage('Check out a branch first: HEAD is detached.'); return false; }
    let remote = upstream ? upstream.split('/')[0] : null;
    const setUp = !upstream;
    if (!remote) remote = await this.pickRemote(remotes);
    if (!remote) return false;
    return this.ask(plan.push(remote, branch, setUp), repo, `Push "${branch}" to "${remote}"?`, { button: 'Push', network: true, extra: 'Your git contacts the remote with your own credentials.' });
  }

  operation(repo, op, what) {
    const cmds = what === 'abort' ? plan.abort(op) : what === 'skip' ? plan.skip(op) : plan.cont(op);
    const warn = what === 'abort' ? `Abort puts the branch back where it was before the ${op}.` : what === 'skip' ? 'Skip leaves out the commit that stopped.' : 'Continue needs every conflict resolved and staged.';
    return this.ask(cmds, repo, `${what[0].toUpperCase() + what.slice(1)} the ${op}?`, { button: what === 'abort' ? 'Abort' : what === 'skip' ? 'Skip' : 'Continue', extra: warn });
  }
}

module.exports = { Actions, plan, commandText, failureText };
