'use strict';
// A small stand-in for the `vscode` module, enough for the extension host code to run under node --test.
// install() makes require('vscode') return it. Message boxes answer from `answers` (a queue per kind).
const Module = require('module');
const path = require('path');
const nodeUrl = require('url');

class Uri {
  constructor(scheme, p, query = '', fragment = '') { this.scheme = scheme; this.path = p; this.query = query; this.fragment = fragment; this.authority = ''; }
  static file(p) { return new Uri('file', path.resolve(p).split(path.sep).join('/')); }
  static parse(s) { const u = new nodeUrl.URL(s); return new Uri(u.protocol.replace(':', ''), decodeURIComponent(u.pathname), u.search.replace(/^\?/, '')); }
  static from(o) { return new Uri(o.scheme, o.path || '', o.query || '', o.fragment || ''); }
  static joinPath(u, ...parts) { return new Uri(u.scheme, path.posix.join(u.path, ...parts), u.query); }
  get fsPath() { return this.path.split('/').join(path.sep); }
  with(c) { return new Uri(c.scheme ?? this.scheme, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment); }
  toString() { return `${this.scheme}://${this.path}${this.query ? '?' + this.query : ''}`; }
}

class EventEmitter {
  constructor() { this.listeners = []; this.event = (l) => { this.listeners.push(l); return { dispose: () => { this.listeners = this.listeners.filter(x => x !== l); } }; }; }
  fire(v) { for (const l of [...this.listeners]) l(v); }
  dispose() { this.listeners = []; }
}

function create() {
  const state = {
    commands: new Map(), contexts: {}, messages: [], answers: { info: [], warn: [], error: [], quickPick: [], input: [] },
    executed: [], sourceControls: [], watchers: [], config: {}, panels: [], opened: [], decorationsSet: [],
  };
  const take = (kind, items) => {
    const q = state.answers[kind];
    if (!q.length) return undefined;
    const a = q.shift();
    return typeof a === 'function' ? a(items) : a;
  };
  const vscode = {
    Uri, EventEmitter,
    ThemeColor: class { constructor(id) { this.id = id; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; if (typeof a === 'object') { this.start = a; this.end = b; } } },
    MarkdownString: class { constructor(v = '') { this.value = v; } appendMarkdown(s) { this.value += s; return this; } },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    DataTransferItem: class { constructor(v) { this.v = v; } asString() { return Promise.resolve(this.v); } },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    QuickPickItemKind: { Separator: -1 },
    FileType: { File: 1, Directory: 2 },
    env: { clipboard: { text: '', writeText(t) { this.text = t; return Promise.resolve(); } }, openExternal: (u) => { state.executed.push(['openExternal', String(u)]); return Promise.resolve(true); } },
    commands: {
      registerCommand(id, fn) { if (state.commands.has(id)) throw new Error('command registered twice: ' + id); state.commands.set(id, fn); return { dispose: () => state.commands.delete(id) }; },
      executeCommand(id, ...args) {
        state.executed.push([id, ...args]);
        if (id === 'setContext') { state.contexts[args[0]] = args[1]; return Promise.resolve(); }
        const fn = state.commands.get(id);
        return Promise.resolve(fn ? fn(...args) : undefined);
      },
    },
    window: {
      showInformationMessage: (m, ...items) => { state.messages.push(['info', m]); return Promise.resolve(take('info', items.filter(i => typeof i === 'string'))); },
      showWarningMessage: (m, ...items) => { state.messages.push(['warn', m, items[0] && items[0].detail]); return Promise.resolve(take('warn', items.filter(i => typeof i === 'string'))); },
      showErrorMessage: (m, ...items) => { state.messages.push(['error', m]); return Promise.resolve(take('error', items)); },
      showQuickPick: (items, opts) => Promise.resolve(Promise.resolve(items).then(it => { state.messages.push(['pick', opts && (opts.title || opts.placeHolder)]); return take('quickPick', it); })),
      showInputBox: (opts) => { state.messages.push(['input', opts && (opts.title || opts.prompt)]); return Promise.resolve(take('input', opts)); },
      setStatusBarMessage: () => ({ dispose() {} }),
      withProgress: (_o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      createOutputChannel: () => ({ lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }),
      createTerminal: () => ({ show() {}, sendText() {} }),
      createTextEditorDecorationType: () => ({ dispose() {} }),
      registerFileDecorationProvider: () => ({ dispose() {} }),
      createTreeView: (id, o) => ({ id, o, dispose() {} }),
      createWebviewPanel: (type, title) => {
        const listeners = [];
        const p = { type, title, posted: [], webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage(m) { p.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: l => { listeners.push(l); return { dispose() {} }; } },
          send: m => Promise.all(listeners.map(l => l(m))), reveal() {}, onDidDispose() { return { dispose() {} }; }, dispose() {}, iconPath: null };
        state.panels.push(p); return p;
      },
      onDidChangeTextEditorSelection: () => ({ dispose() {} }),
      onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      showTextDocument: (d) => { state.opened.push(d); return Promise.resolve({}); },
      activeTextEditor: undefined,
      visibleTextEditors: [],
    },
    workspace: {
      workspaceFolders: [],
      isTrusted: true,
      textDocuments: [],
      getConfiguration: (section) => ({ get: (k, d) => { const v = state.config[`${section}.${k}`]; return v === undefined ? d : v; } }),
      createFileSystemWatcher: (pattern) => {
        const w = { pattern, change: new EventEmitter(), create: new EventEmitter(), del: new EventEmitter(), dispose() {} };
        w.onDidChange = w.change.event; w.onDidCreate = w.create.event; w.onDidDelete = w.del.event;
        state.watchers.push(w); return w;
      },
      registerTextDocumentContentProvider: (scheme, p) => { state.contentProvider = p; return { dispose() {} }; },
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidSaveTextDocument: () => ({ dispose() {} }),
      onDidCloseTextDocument: () => ({ dispose() {} }),
      openTextDocument: (x) => Promise.resolve({ uri: x, x }),
      fs: { delete: (u) => { require('fs').rmSync(u.fsPath, { recursive: true, force: true }); return Promise.resolve(); } },
    },
    scm: {
      createSourceControl(id, label, rootUri) {
        const sc = { id, label, rootUri, inputBox: { value: '', placeholder: '' }, count: 0, groups: [], statusBarCommands: [], disposed: false,
          createResourceGroup(gid, glabel) { const g = { id: gid, label: glabel, resourceStates: [], hideWhenEmpty: false, disposed: false, dispose() { this.disposed = true; sc.groups = sc.groups.filter(x => x !== g); } }; sc.groups.push(g); return g; },
          dispose() { this.disposed = true; } };
        state.sourceControls.push(sc); return sc;
      },
    },
    extensions: { getExtension: () => undefined },
    authentication: { getSession: () => Promise.resolve(undefined) },
  };
  return { vscode, state };
}

function install() {
  const { vscode, state } = create();
  const orig = Module._load;
  Module._load = function (request, parent, isMain) { if (request === 'vscode') return vscode; return orig.call(this, request, parent, isMain); };
  return { vscode, state, uninstall() { Module._load = orig; } };
}

function context(dir) {
  const store = new Map();
  return {
    subscriptions: [],
    extensionUri: Uri.file(path.join(__dirname, '..', '..')),
    globalStorageUri: Uri.file(path.join(dir, 'storage')),
    storageUri: Uri.file(path.join(dir, 'wsstorage')),
    globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: (k, v) => { store.set(k, v); return Promise.resolve(); }, keys: () => [...store.keys()], setKeysForSync() {} },
    workspaceState: { get: (k, d) => d, update: () => Promise.resolve() },
    secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve(), onDidChange: () => ({ dispose() {} }) },
  };
}

module.exports = { install, create, context, Uri, EventEmitter };
