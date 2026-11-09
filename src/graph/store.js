'use strict';
// Compact row store for the graph: one entry per row (commit, stash or the uncommitted-changes row). Authors and
// emails are interned, dates are 32-bit seconds, parents are one flat list. The hash index is a Map.
const { Layout } = require('./layout');

const KIND = { commit: 0, stash: 1, wip: 2 };
const KIND_NAME = ['commit', 'stash', 'wip'];
const SUBJECT_MAX = 300;

class Interner {
  constructor() { this.list = []; this.map = new Map(); }
  id(s) { let i = this.map.get(s); if (i === undefined) { i = this.list.length; this.list.push(s); this.map.set(s, i); } return i; }
  get(i) { return this.list[i]; }
}

class Store {
  constructor() {
    this.layout = new Layout();
    this.hashes = [];
    this.subjects = [];
    this.authors = new Interner();
    this.emails = new Interner();
    this.author = [];
    this.email = [];
    this.date = [];
    this.kind = [];
    this.parentStart = [];
    this.parentList = [];
    this.index = new Map();
    this.extra = new Map(); // row -> { selector, count } for stash and wip rows
  }

  get rows() { return this.hashes.length; }

  add(c, kind = 'commit', extra) {
    const row = this.layout.add(c.hash, c.parents);
    this.hashes.push(c.hash);
    this.subjects.push(c.subject.length > SUBJECT_MAX ? c.subject.slice(0, SUBJECT_MAX) + '…' : c.subject);
    this.author.push(this.authors.id(c.author || ''));
    this.email.push(this.emails.id(c.email || ''));
    this.date.push(c.date >>> 0);
    this.kind.push(KIND[kind] || 0);
    this.parentStart.push(this.parentList.length);
    for (const p of c.parents) this.parentList.push(p);
    if (kind === 'commit' && !this.index.has(c.hash)) this.index.set(c.hash, row);
    if (extra) this.extra.set(row, extra);
    return row;
  }

  parentsOf(r) {
    const s = this.parentStart[r];
    const e = r + 1 < this.rows ? this.parentStart[r + 1] : this.parentList.length;
    return this.parentList.slice(s, e);
  }

  /** Row index of a full hash or a unique prefix (4+ hex chars), else -1. */
  find(h) {
    h = String(h || '').toLowerCase();
    if (this.index.has(h)) return this.index.get(h);
    if (!/^[0-9a-f]{4,64}$/.test(h)) return -1;
    let found = -1;
    for (let r = 0; r < this.rows; r++) {
      if (this.kind[r] === 0 && this.hashes[r].startsWith(h)) { if (found >= 0) return found; found = r; }
    }
    return found;
  }

  /** Rows [a, b) for the webview, with refs from refsByHash (Map hash -> [ref]). */
  slice(a, b, refsByHash) {
    a = Math.max(0, a); b = Math.min(this.rows, b);
    const lay = this.layout.window(a, b);
    const out = [];
    for (let r = a; r < b; r++) {
      const h = this.hashes[r];
      const kind = KIND_NAME[this.kind[r]];
      out.push({
        i: r, hash: h, kind, parents: this.parentsOf(r), subject: this.subjects[r],
        author: this.authors.get(this.author[r]), email: this.emails.get(this.email[r]), date: this.date[r],
        refs: kind === 'commit' ? (refsByHash.get(h) || []) : [], extra: this.extra.get(r) || null,
        g: lay[r - a],
      });
    }
    return out;
  }

  /**
   * Text search over every loaded row: subject, author, email and hash prefix. Returns matching rows (ascending).
   * q: { text, caseSensitive, regex }
   */
  search(q, limit = 100000) {
    const text = String(q.text || '');
    if (!text) return [];
    let test;
    if (q.regex) {
      let re;
      try { re = new RegExp(text, q.caseSensitive ? '' : 'i'); } catch (e) { throw new Error('That regular expression is not valid: ' + e.message); }
      test = s => re.test(s);
    } else if (q.caseSensitive) test = s => s.includes(text);
    else { const t = text.toLowerCase(); test = s => s.toLowerCase().includes(t); }
    const hashQ = /^[0-9a-f]{4,64}$/i.test(text) ? text.toLowerCase() : null;
    const authorHit = new Uint8Array(this.authors.list.length);
    this.authors.list.forEach((a, i) => { if (test(a)) authorHit[i] = 1; });
    const emailHit = new Uint8Array(this.emails.list.length);
    this.emails.list.forEach((a, i) => { if (test(a)) emailHit[i] = 1; });
    const out = [];
    for (let r = 0; r < this.rows && out.length < limit; r++) {
      if (this.kind[r] === 2) continue;
      if ((hashQ && this.hashes[r].startsWith(hashQ)) || authorHit[this.author[r]] || emailHit[this.email[r]] || test(this.subjects[r])) out.push(r);
    }
    return out;
  }

  bytes() {
    let s = this.layout.bytes();
    for (const x of this.subjects) s += 2 * x.length + 16;
    s += this.hashes.length * (2 * 40 + 16) + this.parentList.length * (2 * 40 + 16) + this.rows * 8 * 5;
    return s;
  }
}

module.exports = { Store, KIND };
