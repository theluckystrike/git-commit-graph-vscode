'use strict';
// Builds a webview page: strict CSP (default-src 'none', script by nonce, no remote source), theme colours from
// VS Code variables, the initial data as JSON in a non-executed script tag, and the support footer.
const crypto = require('crypto');

function nonce() { return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, ''); }

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function page({ vscode, context, webview, script, css, title, data, support, settings, body = '' }) {
  const n = nonce();
  const media = f => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
  const show = settings ? settings().showSupportLinks : true;
  const footer = support ? support.footerHtml('zovoGit', show !== false, '') : '';
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} blob: data:`,
    `style-src ${webview.cspSource} 'nonce-${n}'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join('; ');
  const json = JSON.stringify(data || {}).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${css ? `<link rel="stylesheet" href="${media(css)}">` : ''}
${footer && support.FOOTER_CSS ? `<style nonce="${n}">${support.FOOTER_CSS}</style>` : ''}
</head><body>
<div id="app">${body}</div>
${footer ? `<footer class="foot">${footer}</footer>` : ''}
<script type="application/json" id="data">${json}</script>
<script nonce="${n}" src="${media(script)}"></script>
</body></html>`;
}

module.exports = { page, esc, nonce };
