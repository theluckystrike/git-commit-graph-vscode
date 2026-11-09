// README screenshot: the Express repository, dark theme, a merge commit selected with its changed files.
// usage: node scripts/shots.mjs <work> <port> <repo> <out.png> <vsix> [theme]
import { launch, sleep, installVsix } from './vsc.mjs';
import { spawnSync } from 'node:child_process';
const [work, port, repo, out, vsix, theme = 'Default Dark Modern'] = process.argv.slice(2);
const inst = installVsix(work, vsix); if (inst.code !== 0) throw new Error(inst.out);
const vs = await launch(work, Number(port), repo, { 'workbench.colorTheme': theme, 'git.enabled': false, 'zovoGit.askForRating': false, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left' });
try {
  await sleep(2500);
  spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${vs.child.pid}) to true`]);
  await vs.command('View: Close Primary Side Bar'); await sleep(500);
  await vs.command('Commit Graph: Show Commit Graph');
  let wv = null;
  for (let i = 0; i < 60 && !wv; i++) { await sleep(300); for (const w of await vs.webviews()) if (await vs.wvEval(w, `!!document.body.dataset.loaded`).catch(() => false)) wv = w; }
  if (!wv) throw new Error('no graph');
  await sleep(800);
  // jump to a merge of the 4.x and 5.0 lines with the search box, then open its details
  await vs.wvClick(wv, `document.querySelector('.search input')`);
  await vs.type("Merge branch 'master' into 5-merge"); await vs.key('Enter', 'Enter');
  await vs.waitFor(() => vs.wvEval(wv, `!!document.querySelector('#rows .row.sel')`), 15000, 200);
  await sleep(600);
  await vs.wvClick(wv, `document.querySelector('#rows .row.sel')`);
  await vs.waitFor(() => vs.wvEval(wv, `document.querySelectorAll('#dfiles .file').length`), 10000, 100);
  await sleep(1200);
  await vs.shot(out);
  console.log('saved', out);
} finally { await vs.close(); }
