'use strict';
// Lane layout for the commit graph, one commit at a time, children before parents (git log --date-order or
// --topo-order). Memory grows with the number of edges, not with rows x lanes: each row keeps only its own edges
// (lines into the dot and lines out to the parents) in one packed typed array, and the set of lanes that pass
// through is rebuilt for the visible window from a checkpoint taken every CHECKPOINT rows.
//
// Edge word: lane (bits 0-15) | color (bits 16-23) | kind (bits 24-25): 0 = into the dot, 1 = out to a parent on
// a new lane, 2 = out to a parent that another lane already waits for (join).

const CHECKPOINT = 128;
const IN = 0; const OUT_NEW = 1; const OUT_JOIN = 2;
const COLORS = 12;

class Grow {
  constructor(Type, n = 1024) { this.Type = Type; this.a = new Type(n); this.length = 0; }
  push(v) { if (this.length === this.a.length) { const b = new this.Type(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.length++] = v; }
  get(i) { return this.a[i]; }
  set(i, v) { this.a[i] = v; }
  bytes() { return this.a.byteLength; }
}

class Layout {
  constructor() {
    this.lanes = []; // lane -> { hash, color } or null
    this.expect = new Map(); // hash -> [lanes waiting for it]
    this.nextColor = 0;
    this.rows = 0;
    this.maxLane = 0;
    this.col = new Grow(Uint16Array);
    this.color = new Grow(Uint8Array);
    this.edgeStart = new Grow(Uint32Array);
    this.edges = new Grow(Uint32Array, 4096);
    this.checkpoints = []; // every CHECKPOINT rows: [lane, color, lane, color, ...] active at the top of that row
  }

  _free() {
    for (let i = 0; i < this.lanes.length; i++) if (!this.lanes[i]) return i;
    this.lanes.push(null);
    return this.lanes.length - 1;
  }

  _snapshot() {
    const s = [];
    for (let i = 0; i < this.lanes.length; i++) if (this.lanes[i]) s.push(i, this.lanes[i].color);
    return Int32Array.from(s);
  }

  /** Adds a commit (parents as hashes). Returns its row. */
  add(hash, parents) {
    const row = this.rows;
    if (row % CHECKPOINT === 0) this.checkpoints.push(this._snapshot());
    this.edgeStart.push(this.edges.length);
    const waiting = this.expect.get(hash);
    let col; let color;
    if (waiting && waiting.length) {
      col = Math.min(...waiting);
      color = this.lanes[col].color;
      for (const c of waiting) { this.edges.push(c | (this.lanes[c].color << 16) | (IN << 24)); this.lanes[c] = null; }
      this.expect.delete(hash);
    } else {
      col = this._free();
      color = this.nextColor++ % COLORS;
    }
    for (let j = 0; j < parents.length; j++) {
      const p = parents[j];
      const has = this.expect.get(p);
      if (j > 0 && has && has.length) {
        const k = Math.min(...has);
        this.edges.push(k | (this.lanes[k].color << 16) | (OUT_JOIN << 24));
        continue;
      }
      let lane; let lc;
      if (j === 0) { lane = col; lc = color; } else { lane = this._free(); lc = this.nextColor++ % COLORS; }
      this.lanes[lane] = { hash: p, color: lc };
      if (has) has.push(lane); else this.expect.set(p, [lane]);
      this.edges.push(lane | (lc << 16) | (OUT_NEW << 24));
      if (lane > this.maxLane) this.maxLane = lane;
    }
    if (col > this.maxLane) this.maxLane = col;
    this.col.push(col);
    this.color.push(color);
    this.rows++;
    return row;
  }

  /** Lanes still waiting for a commit that never came (history cut off or a parent outside the view). */
  openLanes() { return this.lanes.filter(Boolean).length; }

  _rowEdges(r) {
    const s = this.edgeStart.get(r);
    const e = r + 1 < this.rows ? this.edgeStart.get(r + 1) : this.edges.length;
    const out = [];
    for (let i = s; i < e; i++) { const w = this.edges.get(i); out.push({ lane: w & 0xffff, color: (w >> 16) & 0xff, kind: (w >> 24) & 3 }); }
    return out;
  }

  /**
   * Drawing data for rows [a, b): { col, color, pass: [[lane, color]], ins: [[lane, color]], outs: [[lane, color, join]] }.
   */
  window(a, b) {
    a = Math.max(0, a); b = Math.min(this.rows, b);
    if (a >= b) return [];
    const cp = Math.floor(a / CHECKPOINT);
    const snap = this.checkpoints[cp] || new Int32Array(0);
    const active = new Map();
    for (let i = 0; i < snap.length; i += 2) active.set(snap[i], snap[i + 1]);
    const out = [];
    for (let r = cp * CHECKPOINT; r < b; r++) {
      const edges = this._rowEdges(r);
      const ins = edges.filter(e => e.kind === IN);
      const inLanes = new Set(ins.map(e => e.lane));
      if (r >= a) {
        const pass = [];
        for (const [lane, color] of active) if (!inLanes.has(lane)) pass.push([lane, color]);
        pass.sort((x, y) => x[0] - y[0]);
        out.push({
          col: this.col.get(r), color: this.color.get(r), pass,
          ins: ins.map(e => [e.lane, e.color]),
          outs: edges.filter(e => e.kind !== IN).map(e => [e.lane, e.color, e.kind === OUT_JOIN ? 1 : 0]),
        });
      }
      for (const l of inLanes) active.delete(l);
      for (const e of edges) if (e.kind === OUT_NEW) active.set(e.lane, e.color);
    }
    return out;
  }

  /** Widest lane index in rows [a, b) (for the graph column width). */
  widthIn(a, b) {
    let m = 0;
    for (const w of this.window(a, b)) {
      m = Math.max(m, w.col);
      for (const p of w.pass) m = Math.max(m, p[0]);
      for (const o of w.outs) m = Math.max(m, o[0]);
      for (const i of w.ins) m = Math.max(m, i[0]);
    }
    return m + 1;
  }

  bytes() { return this.col.bytes() + this.color.bytes() + this.edgeStart.bytes() + this.edges.bytes() + this.checkpoints.reduce((s, c) => s + c.byteLength, 0); }
}

module.exports = { Layout, CHECKPOINT, COLORS };
