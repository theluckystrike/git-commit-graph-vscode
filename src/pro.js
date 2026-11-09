'use strict';
// Zovo Pro switch. PRO_ENABLED = false ships every feature free: no "Pro" label, no prompt, no license code runs.
// When the owner turns it on, these features ask for Zovo Pro (one-time, all Zovo tools) after FREE_TRIES uses:
//   the branch comparison report, the visual interactive rebase editor and saved graph filters.
// The graph, search, commit details, diffs, file and line history, squash and every other action stay free for good.
const PRO_ENABLED = false;
const SKU = 'git-graph-pro';
const FREE_TRIES = 3;
const PRO_FEATURES = ['Branch comparison report', 'Interactive rebase editor', 'Saved graph filters'];

function createPro({ vscode, context, enabled = PRO_ENABLED, license }) {
  vscode.commands.executeCommand('setContext', 'zovoGit.proEnabled', !!enabled);
  let lic = null;
  if (enabled) {
    lic = license || require('./license').createLicense({ vscode, context, sku: SKU, name: 'Commit Graph', commandPrefix: 'zovoGit' });
  } else {
    // The license commands are listed in package.json but hidden while Pro is off. Called anyway, they say so.
    const free = () => vscode.window.showInformationMessage('Every Commit Graph feature is free in this version. Nothing to unlock.');
    for (const c of ['unlockWithSponsors', 'enterLicenseKey', 'getPro', 'removeLicense']) context.subscriptions.push(vscode.commands.registerCommand('zovoGit.' + c, free));
  }
  const KEY = 'zovoGit.proTries';
  return {
    enabled: !!enabled,
    /** Labels for views: empty while Pro is off, so no "Pro" mark shows anywhere. */
    labels() { return enabled && lic && !lic.isPro(SKU) ? PRO_FEATURES : []; },
    /** True when the feature may run. Free while Pro is off; else licensed, or one of the first FREE_TRIES uses. */
    async allow(feature, detail) {
      if (!enabled) return true;
      await lic.ready;
      if (lic.isPro(SKU)) { if (lic.refresh) lic.refresh(); return true; }
      const tries = context.globalState.get(KEY, {});
      const used = tries[feature] || 0;
      if (used < FREE_TRIES) { tries[feature] = used + 1; await context.globalState.update(KEY, tries); return true; }
      return lic.requirePro(feature, detail);
    },
  };
}

module.exports = { createPro, PRO_ENABLED, SKU, FREE_TRIES, PRO_FEATURES };
