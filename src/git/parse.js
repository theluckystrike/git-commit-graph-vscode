'use strict';
// Pure parsers for git output. Every record is checked (hash shape, field count), so a commit message that
// contains our separator bytes cannot make up a commit.

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FS = '\x1f';

// git log -z --format=LOG_FORMAT: one NUL-terminated record per commit, the subject last.
const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s';

/** One log record (string without the NUL) to a commit, or null when it is not a valid record. */
function parseLogRecord(rec) {
  if (!rec) return null;
  if (rec.charCodeAt(0) === 10) rec = rec.slice(1); // git puts a newline between -z records with some formats
  const parts = rec.split(FS);
  if (parts.length < 7) return null;
  const [hash, parents, author, email, at, ct] = parts;
  const subject = parts.slice(6).join(' ');
  if (!HASH.test(hash)) return null;
  const ps = parents ? parents.split(' ').filter(Boolean) : [];
  if (!ps.every(p => HASH.test(p))) return null;
  return { hash, parents: ps, author, email, date: Number(at) || 0, cdate: Number(ct) || 0, subject: subject.replace(/[\r\n]+/g, ' ') };
}

/**
 * Splits a byte stream into NUL-terminated records. Returns a feeder: feed(buf) -> array of complete records
 * (decoded as UTF-8), and rest() for the tail.
 */
function nulSplitter() {
  let pending = null;
  const dec = new TextDecoder('utf-8');
  return {
    feed(buf) {
      const out = [];
      let start = 0;
      let data = buf;
      if (pending) { data = Buffer.concat([pending, buf]); pending = null; }
      for (;;) {
        const i = data.indexOf(0, start);
        if (i < 0) break;
        out.push(dec.decode(data.subarray(start, i)));
        start = i + 1;
      }
      if (start < data.length) pending = Buffer.from(data.subarray(start));
      return out;
    },
    rest() { const r = pending ? dec.decode(pending) : ''; pending = null; return r; },
  };
}

// git for-each-ref --format=REF_FORMAT
const REF_FORMAT = '%(objectname)%1f%(refname)%1f%(*objectname)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)';

/** Refs by kind. Annotated tags point at their commit (peeled). */
function parseRefs(text) {
  const out = { heads: [], remotes: [], tags: [], head: null };
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const [obj, ref, peeled, isHead, upstream, track] = line.split(FS);
    if (!HASH.test(obj || '')) continue;
    const hash = peeled && HASH.test(peeled) ? peeled : obj;
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice(11);
      out.heads.push({ name, hash, current: isHead === '*', upstream: upstream || '', track: track || '' });
      if (isHead === '*') out.head = name;
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13);
      if (/\/HEAD$/.test(name)) continue;
      const slash = name.indexOf('/');
      out.remotes.push({ name, hash, remote: slash > 0 ? name.slice(0, slash) : name, branch: slash > 0 ? name.slice(slash + 1) : name });
    } else if (ref.startsWith('refs/tags/')) {
      out.tags.push({ name: ref.slice(10), hash, annotated: !!(peeled && HASH.test(peeled)) });
    }
  }
  return out;
}

// git stash list -z --format=STASH_FORMAT
const STASH_FORMAT = '%H%x1f%P%x1f%gd%x1f%at%x1f%an%x1f%s';
function parseStashes(text) {
  const out = [];
  for (const rec of String(text).split('\0')) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const p = r.split(FS);
    if (p.length < 6 || !HASH.test(p[0])) continue;
    const parents = p[1].split(' ').filter(h => HASH.test(h));
    if (!parents.length) continue;
    out.push({ hash: p[0], base: parents[0], selector: p[2], date: Number(p[3]) || 0, author: p[4], subject: p.slice(5).join(' ') });
  }
  return out;
}

/** git status --porcelain=v1 -z: counts and entries. Renames carry the old path in the next field. */
function parseStatus(text) {
  const parts = String(text).split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0]; const y = e[1]; const file = e.slice(3);
    let orig = '';
    if (x === 'R' || x === 'C') { orig = parts[i + 1] || ''; i++; }
    entries.push({ x, y, path: file, orig });
  }
  return entries;
}

/**
 * git diff-tree / diff --name-status -z output: STATUS\0path\0 (R and C: STATUS\0old\0new\0).
 * Returns [{status, path, oldPath}].
 */
function parseNameStatus(text) {
  const p = String(text).split('\0');
  const out = [];
  for (let i = 0; i < p.length;) {
    const st = p[i];
    if (!st) { i++; continue; }
    if (!/^[ACDMRTUXB]\d*$/.test(st)) { i++; continue; }
    const code = st[0];
    if (code === 'R' || code === 'C') {
      const oldPath = p[i + 1]; const newPath = p[i + 2];
      if (oldPath === undefined || newPath === undefined) break;
      out.push({ status: code, score: Number(st.slice(1)) || 0, path: newPath, oldPath });
      i += 3;
    } else {
      const file = p[i + 1];
      if (file === undefined) break;
      out.push({ status: code, path: file, oldPath: file });
      i += 2;
    }
  }
  return out;
}

/** git diff --numstat -z: added\tdeleted\tpath\0 (renames: added\tdeleted\t\0old\0new\0). Returns Map path -> {add, del}. */
function parseNumstat(text) {
  const p = String(text).split('\0');
  const out = new Map();
  for (let i = 0; i < p.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p[i]);
    if (!m) continue;
    let file = m[3];
    if (file === '') { file = p[i + 2]; i += 2; }
    if (file === undefined) break;
    out.set(file, { add: m[1] === '-' ? -1 : Number(m[1]), del: m[2] === '-' ? -1 : Number(m[2]) });
  }
  return out;
}

/** Commits from git log -L output (format with a NUL-led header), each with its patch text. */
function parseLineLog(text) {
  const out = [];
  for (const chunk of String(text).split('\x1e')) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const head = nl < 0 ? chunk : chunk.slice(0, nl);
    const c = parseLogRecord(head);
    if (!c) continue;
    c.patch = nl < 0 ? '' : chunk.slice(nl + 1).replace(/^\n+/, '').replace(/\s+$/, '');
    out.push(c);
  }
  return out;
}

/** Checks a branch or tag name the way git check-ref-format would for the common cases (git has the last word). */
function refNameProblem(name) {
  const n = String(name || '');
  if (!n.trim()) return 'Type a name.';
  if (/\s/.test(n)) return 'Names cannot contain spaces.';
  if (/[\x00-\x1f\x7f~^:?*\[\\]/.test(n)) return 'Names cannot contain ~ ^ : ? * [ \\ or control characters.';
  if (/\.\.|@\{|\/\/|^\/|\/$|^\.|\/\.|\.lock$|\.lock\/|\.$|^-|^@$/.test(n)) return 'That is not a valid git ref name.';
  return '';
}

/** In-progress operation from the files in the git dir. */
function operationFrom(exists) {
  if (exists('rebase-merge') || exists('rebase-apply')) return exists('rebase-apply/applying') ? 'am' : 'rebase';
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  if (exists('BISECT_LOG')) return 'bisect';
  return '';
}

module.exports = { HASH, LOG_FORMAT, REF_FORMAT, STASH_FORMAT, parseLogRecord, nulSplitter, parseRefs, parseStashes, parseStatus, parseNameStatus, parseNumstat, parseLineLog, refNameProblem, operationFrom };
