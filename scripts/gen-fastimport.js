#!/usr/bin/env node
// git fast-import stream for a large test repository: N commits on L long-lived lanes (branches lane-0 .. lane-L-1,
// lane-0 is also main), a merge from another lane every 97 commits, a tag every 1,000 commits. Each commit changes
// one small file. usage: node gen-fastimport.js 200000 30 | git fast-import
'use strict';
const N = Number(process.argv[2] || 200000);
const L = Number(process.argv[3] || 30);
const out = [];
let mark = 0;
const tips = new Array(L).fill(0); // mark of the last commit on each lane
let t = 1500000000;
const flush = () => { if (out.length) { process.stdout.write(out.join('')); out.length = 0; } };
for (let i = 1; i <= N; i++) {
  const lane = i <= L ? i - 1 : (i * 7919) % L;
  const content = `lane ${lane} commit ${i}\n`;
  const blob = ++mark;
  out.push(`blob\nmark :${blob}\ndata ${Buffer.byteLength(content)}\n${content}\n`);
  const cm = ++mark;
  t += 37;
  const msg = `commit ${String(i).padStart(6, '0')} on lane ${lane}${i % 97 === 0 ? ' (merge)' : ''}\n`;
  out.push(`commit refs/heads/lane-${lane}\nmark :${cm}\nauthor Dev ${lane} <dev${lane}@example.com> ${t} +0000\ncommitter Dev ${lane} <dev${lane}@example.com> ${t} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}`);
  if (tips[lane]) out.push(`from :${tips[lane]}\n`);
  else if (tips[0]) out.push(`from :${tips[0]}\n`); // every lane branches off main
  if (i % 97 === 0) { const other = (lane + 1 + (i % (L - 1))) % L; if (other !== lane && tips[other]) out.push(`merge :${tips[other]}\n`); }
  out.push(`M 100644 :${blob} lane-${lane}/file.txt\n\n`);
  tips[lane] = cm;
  if (i % 1000 === 0) out.push(`tag v${i / 1000}.0\nfrom :${cm}\ntagger Dev <dev@example.com> ${t} +0000\ndata 8\nrelease\n\n`);
  if (out.length > 2000) flush();
}
out.push(`reset refs/heads/main\nfrom :${tips[0]}\n\n`);
flush();
