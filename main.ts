// main.ts is mend, the CLI SPEC.md specifies: it applies an edit that an AI model wrote to a tree of text
// files, in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
// format, and text-editor tool calls as JSON. Every file is changed or nothing is. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 (command line, output and exit codes, safe paths, format detection, JSON edits
// and the all-or-nothing write) are the kit starter's. Sections 5 to 8 (three-tier line matching, unified
// diffs, SEARCH/REPLACE blocks, V4A patches) are implemented below.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A move an edit made, for the `R <old> -> <new>` output line (SPEC.md section 2). */
interface Move {
  old: string;
  new: string;
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function matchAt(file: string[], o: string[], i: number, tier: number): boolean {
  for (let k = 0; k < o.length; k++) {
    const f = file[i + k]!;
    const p = o[k]!;
    if (tier === 0) {
      if (f !== p) return false;
    } else if (tier === 1) {
      if (trimEndWS(f) !== trimEndWS(p)) return false;
    } else if (trimWS(f) !== trimWS(p)) return false;
  }
  return true;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Occurrences of O in the file at the first tier where there is at least one, from position `from`. */
function occurrencesFrom(
  file: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: number; pos: number[] } | null {
  for (const t of tiers(strict)) {
    const pos: number[] = [];
    for (let i = from; i + o.length <= file.length; i++) {
      if (matchAt(file, o, i, t)) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function singleMatch(fileLine: string, anchor: string, tier: number): boolean {
  if (tier === 0) return fileLine === anchor;
  if (tier === 1) return trimEndWS(fileLine) === trimEndWS(anchor);
  return trimWS(fileLine) === trimWS(anchor);
}

/** First line at or after `from` equal to the anchor, at the first tier where one is (section 5). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  for (const t of tiers(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (singleMatch(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Build the replacement lines for a match of O at position `at`, at the given tier (section 5). */
function buildNew(
  o: string[],
  file: string[],
  at: number,
  tier: number,
  n: NewLine[],
): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const f = leadWS(file[at]!);
    const p = leadWS(o[0]!);
    for (const e of n) {
      if (e.ctx !== null) {
        out.push(file[at + e.ctx]!);
        continue;
      }
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
  } else {
    for (const e of n) {
      if (e.ctx !== null) out.push(file[at + e.ctx]!);
      else out.push(e.text);
    }
  }
  return out;
}

function replaceAt(lines: string[], at: number, k: number, ins: string[]): string[] {
  return [...lines.slice(0, at), ...ins, ...lines.slice(at + k)];
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4) and JSON edits (section 9)     */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` header line: after the first four characters, up to the first tab, trimmed. */
function patchPathOf(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A header path: `/dev/null` means no file, else the path with a leading `a/` or `b/` removed. */
function toPath(p: string): string | null {
  if (p === '/dev/null') return null;
  return stripAB(p);
}

/** O (context + `-` lines) and N (context + `+` lines) of a hunk, in body order. */
function hunkON(hunk: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const l of hunk.body) {
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: null });
    }
    // `\` lines refer to the body line before them; they carry no line of their own.
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6, final line break). */
function hunkNoEol(hunk: Hunk): boolean {
  const body = hunk.body;
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l.startsWith(' ') || l === '' || l.startsWith('+')) last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.startsWith('\\');
}

/** A section's header lines, before its first hunk: returns the index after them. `rename from` /
 * `rename to` name the paths only when no `---`/`+++` pair does (section 6), so they are applied
 * only while no pair (or lone `+++ ` line) has been seen; `pairSeen` starts true for a section that
 * itself began at a `--- ` / `+++ ` pair. */
function unifiedHeader(lines: string[], i: number, sec: Section, pairSeen: boolean): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.oldPath = toPath(patchPathOf(l));
        sec.newPath = toPath(patchPathOf(lines[i + 1]!));
        pairSeen = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      sec.newPath = toPath(patchPathOf(l));
      pairSeen = true;
      i++;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (!pairSeen) sec.oldPath = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!pairSeen) sec.newPath = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.isCreate = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.isDelete = true;
      i++;
      continue;
    }
    // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:`, any other line: ignored.
    i++;
  }
  return i;
}

/** A section's hunks: returns the index after them (at the next section or the end of the patch). */
function unifiedBody(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.hunks.push({ a, body });
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const n = lines.length;
  const sections: Section[] = [];
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      i++;
      i = unifiedHeader(lines, i, sec, false);
      i = unifiedBody(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = {
        oldPath: toPath(patchPathOf(l)),
        newPath: toPath(patchPathOf(lines[i + 1]!)),
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      i += 2;
      i = unifiedHeader(lines, i, sec, true);
      i = unifiedBody(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionToEdit(s, strict, moves));
}

function sectionToEdit(sec: Section, strict: boolean, moves: Move[]): Edit {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreate = sec.isCreate || oldP === null;
  const isDelete = !isCreate && (sec.isDelete || newP === null);
  if (isCreate) {
    const np = newP ?? '';
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const hunk of sec.hunks) {
        for (const l of hunk.body) if (l.startsWith('+')) plus.push(l.slice(1));
      }
      let noEol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi--) {
          if (body[bi]!.startsWith('+')) {
            noEol = body[bi + 1] !== undefined && body[bi + 1]!.startsWith('\\');
            break outer;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (isDelete) {
    const op = oldP ?? '';
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  const op = oldP ?? '';
  const np = newP ?? '';
  const isMove = op !== np;
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    let f = splitFile(cur);
    let d = 0;
    for (const hunk of sec.hunks) {
      const { o, n } = hunkON(hunk);
      if (o.length === 0) {
        const at = Math.max(0, Math.min(hunk.a + d, f.lines.length));
        const atEnd = at === f.lines.length;
        const ins = buildNew(o, f.lines, at, 0, n);
        f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
        if (atEnd) f.final = !hunkNoEol(hunk);
        d += n.length;
      } else {
        const occ = occurrencesFrom(f.lines, o, 0, strict);
        if (occ === null) throw new Fail('no-match', op);
        const target = hunk.a - 1 + d;
        let best = occ.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of occ.pos) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const runsToEnd = best + o.length === f.lines.length;
        const repl = buildNew(o, f.lines, best, occ.tier, n);
        f.lines = replaceAt(f.lines, best, o.length, repl);
        if (runsToEnd) f.final = !hunkNoEol(hunk);
        d += n.length - o.length;
      }
    }
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, joinFile(f));
      moves.push({ old: op, new: np });
    } else {
      tree.now.set(op, joinFile(f));
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const occ = occurrencesFrom(f.lines, oldLines, 0, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', path);
    const at = occ.pos[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const repl = buildNew(oldLines, f.lines, at, occ.tier, n);
    f.lines = replaceAt(f.lines, at, oldLines.length, repl);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean, _moves: Move[]): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let j = i + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======' && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') j++;
    if (j >= n || lines[j]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

const V4A_SECTION = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function addFileEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function deleteFileEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function updateFileEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const idx = findAnchor(f.lines, chunk.anchor, cursor, strict);
        if (idx === null) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        const ins = buildNew([], f.lines, at, 0, chunk.n);
        f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
        cursor = at + ins.length;
      } else {
        const occ = occurrencesFrom(f.lines, chunk.o, cursor, strict);
        if (occ === null) throw new Fail('no-match', path);
        let at: number | null = null;
        for (const pos of occ.pos) {
          if (chunk.eof && pos + chunk.o.length !== f.lines.length) continue;
          at = pos;
          break;
        }
        if (at === null) throw new Fail('no-match', path);
        const repl = buildNew(chunk.o, f.lines, at, occ.tier, chunk.n);
        f.lines = replaceAt(f.lines, at, chunk.o.length, repl);
        cursor = at + repl.length;
      }
    }
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, joinFile(f));
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, joinFile(f));
    }
  };
}

function parseV4a(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const raw: { text: string; line: number }[] = [];
      while (i < last && !V4A_SECTION(lines[i]!)) {
        raw.push({ text: lines[i]!, line: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.line}`);
      }
      edits.push(addFileEdit(path, fileLines));
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && !V4A_SECTION(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      edits.push(deleteFileEdit(path));
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      const raw: { text: string; line: number }[] = [];
      while (i < last && !V4A_SECTION(lines[i]!)) {
        raw.push({ text: lines[i]!, line: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let expectAnchor = false;
      for (; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const s = r.text;
        if (s === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.line}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          expectAnchor = true;
          continue;
        }
        if (s.startsWith('@@')) {
          const anchor = s.slice(2).trim();
          if (cur !== null) chunks.push(cur);
          cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
          expectAnchor = false;
          continue;
        }
        if (expectAnchor) throw new Exit2(`error: parse ${r.line}`);
        if (cur === null) cur = { anchor: null, o: [], n: [], eof: false };
        if (s.startsWith(' ')) {
          const t = s.slice(1);
          cur.o.push(t);
          cur.n.push({ text: t, ctx: cur.o.length - 1 });
        } else if (s.startsWith('-')) {
          cur.o.push(s.slice(1));
        } else if (s.startsWith('+')) {
          cur.n.push({ text: s.slice(1), ctx: null });
        } else if (s === '') {
          cur.o.push('');
          cur.n.push({ text: '', ctx: cur.o.length - 1 });
        } else {
          throw new Exit2(`error: parse ${r.line}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(updateFileEdit(path, moveTo, chunks, strict, moves));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running (SPEC.md sections 1, 2 and 10)                              */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict, moves);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output lines, in byte order of the paths (a move's line sorts by its new path).
  interface OutEntry {
    key: string;
    line: string;
  }
  const entries: OutEntry[] = [];
  const suppressed = new Set<string>();
  for (const mv of moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      entries.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      suppressed.add(`D:${mv.old}`);
      suppressed.add(`A:${mv.new}`);
    }
  }
  const wasMap = new Map<string, string | null>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    wasMap.set(p, was);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) {
      if (suppressed.has(`A:${p}`)) continue;
      entries.push({ key: p, line: `A ${p}` });
    } else if (now === null) {
      if (suppressed.has(`D:${p}`)) continue;
      entries.push({ key: p, line: `D ${p}` });
    } else {
      entries.push({ key: p, line: `M ${p}` });
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = wasMap.get(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
