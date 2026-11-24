// A fast drop-in for makefun-site 1.0.0: builds the same output tree, byte for byte,
// from the same input, but without the reference's per-character work. Written from
// the behaviour stated in makefun-site's README and verified against its answers;
// no line is copied from the reference implementation.
//
// The speed comes from five choices:
//   1. Markdown is lexed and rendered in one fused pass over line spans (no token
//      objects, no per-line regular expressions), dispatched on each line's first
//      character, and inline markup is rendered by scanning for the next
//      interesting character instead of escaping one character at a time.
//   2. Templates render into one shared string array per page (joined once),
//      instead of building a fresh string at every node.
//   3. Slugs are cached per case and take a pure-ASCII fast path (NFKD is the
//      identity on ASCII, so the normaliser is skipped there entirely).
//   4. Front matter is parsed by scanning the raw text, never by splitting the
//      whole file into lines and joining the body back together.
//   5. Work that repeats is done once per case: a body's word count, and the
//      resolution of each relative link target from each directory.
//
// Nothing here reads a clock, the environment, randomness or a file, and every
// iteration order is fixed by the input, so two runs are byte-identical.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ text

const ESC_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** Append `s` to `out` with & < > " ' escaped. */
function pushEscaped(s, out) {
  ESC_RE.lastIndex = 0;
  let pos = 0;
  let m;
  while ((m = ESC_RE.exec(s)) !== null) {
    if (m.index > pos) out.push(s.slice(pos, m.index));
    out.push(ESC_HTML[m[0]]);
    pos = m.index + 1;
  }
  if (pos < s.length) out.push(s.slice(pos));
}

/** The characters a backslash escapes in inline Markdown. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const hasOwn = Object.hasOwn;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII input never reaches the normaliser: NFKD is the identity on it.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

/** Whether code unit `c` is JavaScript whitespace (the \s class). */
function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
    (c >= 8192 && c <= 8202) || c === 5760 || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
      (c >= 8192 && c <= 8202) || c === 5760 || c === 8232 || c === 8233 || c === 8239 ||
      c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are scanned by offset,
 * never split into an array.
 */
function parseFrontMatter(text) {
  // The opening line must be exactly "---".
  if (text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45 ||
      (text.length > 3 && text.charCodeAt(3) !== 10)) {
    return { error: 'no front matter' };
  }
  // Find the closing line, tracking the line number (1 at the opening "---").
  let pos = 4; // just past "---\n"
  let lineNo = 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = end;
      break;
    }
    lineNo++;
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Walk the lines between the fences.
  pos = 4;
  let n = 2; // line number of the first line after the opening "---"
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? closeStart : Math.min(nl, closeStart);
    const line = text.slice(pos, end);
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) { // '#' is a comment
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${n} is not "key: value"` };
      const key = m[1];
      let raw = m[2] ?? '';
      let r = raw.length;
      while (r > 0) {
        const c = raw.charCodeAt(r - 1);
        if (c !== 32 && c !== 9) break;
        r--;
      }
      raw = raw.slice(0, r);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = keyValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    n++;
    pos = nl === -1 ? closeStart : nl + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = closeEnd === text.length ? text.length : closeEnd + 1;
  return { data, body: text.slice(bodyStart) };
}

// --------------------------------------------------------------- markdown

/** Strip spaces and tabs at both ends of a line. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether a line is blank (spaces and tabs only). A line opening on anything else is not blank. */
function isBlank(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null: ``` plus a language, then blanks. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  const langEnd = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return line.slice(3, langEnd);
}

/** Whether a line closes a fence: ``` then blanks only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let b = line.length;
  while (b > h + 1 && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  const text = line.slice(h + 1, b);
  if (text === '') return null;
  return { depth: h, text };
}

/** Whether a line is a thematic break: --- or *** then blanks only. */
function isHr(line) {
  const dash = line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const star = line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!dash && !star) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether a line ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** A bullet line's item text, or null: "- " or "* " then the rest. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered line's start number and item text, or null: digits ". " then rest. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isWs(line.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const SPECIAL = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline, appended to `out`. `env.link(target)` resolves a link's
 * href. The scan jumps from one interesting character to the next, so plain
 * text is copied in whole slices and never escaped a character at a time.
 */
function inlineTo(s, env, out) {
  let pos = 0;
  SPECIAL.lastIndex = 0;
  let m;
  while ((m = SPECIAL.exec(s)) !== null) {
    const i = m.index;
    if (i > pos) out.push(s.slice(pos, i));
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
        pos = i + 2;
      } else {
        out.push('\\');
        pos = i + 1;
      }
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push('<code>');
        pushEscaped(s.slice(i + 1, j), out);
        out.push('</code>');
        pos = j + 1;
      } else {
        out.push('`');
        pos = i + 1;
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push('<strong>');
          inlineTo(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          pos = j + 2;
        } else {
          out.push('**');
          pos = i + 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out.push('<em>');
          inlineTo(s.slice(i + 1, j), env, out);
          out.push('</em>');
          pos = j + 1;
        } else {
          out.push('*');
          pos = i + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        pushEscaped(env.link(target), out);
        out.push('">');
        inlineTo(s.slice(i + 1, k), env, out);
        out.push('</a>');
        pos = mm + 1;
      } else {
        out.push('[');
        pos = i + 1;
      }
    } else {
      out.push(ESC_HTML[c]);
      pos = i + 1;
    }
    SPECIAL.lastIndex = pos;
  }
  if (pos < s.length) out.push(s.slice(pos));
}

/** A list starting at `pos` in `src`: its items rendered into `out`; the offset after the list. */
function renderList(src, env, pos, isOrdered, start, firstText) {
  const items = [[trimLine(firstText)]];
  const n = src.length;
  let p = pos;
  while (p < n) {
    const nl2 = src.indexOf('\n', p);
    const end2 = nl2 === -1 ? n : nl2;
    const l2 = src.slice(p, end2);
    const np = nl2 === -1 ? n : nl2 + 1;
    let itemText = null;
    if (isOrdered) {
      const o = orderedOf(l2);
      if (o !== null) itemText = o.text;
    } else itemText = bulletOf(l2);
    if (itemText !== null) {
      items.push([trimLine(itemText)]);
      p = np;
    } else if (isContinued(l2)) {
      items[items.length - 1].push(trimLine(l2));
      p = np;
    } else break;
  }
  return { items, pos: p };
}

/** `src` rendered: its HTML, table of contents and excerpt (first paragraph). */
function renderMarkdown(src, env, slugCache) {
  const out = [];
  const toc = [];
  let excerpt = '';
  const ids = new Set();
  let pos = 0;
  const n = src.length;
  while (pos < n) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    const line = src.slice(pos, end);
    const next = nl === -1 ? n : nl + 1;
    // One dispatch on the line's first character: a line can only be the
    // block its first character allows, so the classifiers run once each.
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) { pos = next; continue; }
      // An indented, non-blank line is paragraph text; fall through.
    } else if (c0 === 96) { // '`': a fence, or paragraph text.
      const lang = fenceLang(line);
      if (lang !== null) {
        out.push('<pre><code');
        if (lang !== '') { out.push(' class="language-'); pushEscaped(lang, out); out.push('"'); }
        out.push('>');
        pos = next;
        let closed = false;
        while (pos < n) {
          const nl2 = src.indexOf('\n', pos);
          const end2 = nl2 === -1 ? n : nl2;
          const bodyLine = src.slice(pos, end2);
          if (isFenceClose(bodyLine)) { pos = nl2 === -1 ? n : nl2 + 1; closed = true; break; }
          pushEscaped(bodyLine, out);
          out.push('\n');
          pos = nl2 === -1 ? n : nl2 + 1;
        }
        // An unclosed fence whose body ends on a newline takes one more empty
        // line, the one a line split leaves after the last newline.
        if (!closed && n > 0 && src.charCodeAt(n - 1) === 10) out.push('\n');
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) { // '#': a heading, or paragraph text.
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        out.push(`<h${heading.depth} id="${id}">`);
        if (heading.depth === 2 || heading.depth === 3) {
          const inner = [];
          inlineTo(heading.text, env, inner);
          const html = inner.join('');
          out.push(html);
          toc.push({ level: heading.depth, id, html });
        } else inlineTo(heading.text, env, out);
        out.push(`</h${heading.depth}>\n`);
        pos = next;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*': a break, a bullet list, or paragraph text.
      if (isHr(line)) {
        out.push('<hr>\n');
        pos = next;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const r = renderList(src, env, next, false, 1, b);
        out.push('<ul>\n');
        for (const item of r.items) {
          out.push('<li>');
          inlineTo(item.join('\n'), env, out);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        pos = r.pos;
        continue;
      }
    } else if (c0 === 62) { // '>': a blockquote.
      const lines = [];
      let p = pos;
      while (p < n) {
        const nl2 = src.indexOf('\n', p);
        const end2 = nl2 === -1 ? n : nl2;
        const l2 = src.slice(p, end2);
        if (l2.charCodeAt(0) !== 62) break;
        lines.push(l2.charCodeAt(1) === 32 ? l2.slice(2) : l2.slice(1));
        p = nl2 === -1 ? n : nl2 + 1;
      }
      const kept = [];
      for (const l of lines) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineTo(kept.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      pos = p;
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // a digit: an ordered list, or paragraph text.
      const o = orderedOf(line);
      if (o !== null) {
        const r = renderList(src, env, next, true, o.start, o.text);
        if (o.start !== 1) out.push(`<ol start="${o.start}">\n`);
        else out.push('<ol>\n');
        for (const item of r.items) {
          out.push('<li>');
          inlineTo(item.join('\n'), env, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        pos = r.pos;
        continue;
      }
    }
    // A paragraph: this line and the lines after it, up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    let p = next;
    while (p < n) {
      const nl2 = src.indexOf('\n', p);
      const end2 = nl2 === -1 ? n : nl2;
      const l2 = src.slice(p, end2);
      if (endsParagraph(l2)) break;
      body.push(trimLine(l2));
      p = nl2 === -1 ? n : nl2 + 1;
    }
    const joined = body.join('\n');
    if (excerpt === '') {
      const inner = [];
      inlineTo(joined, env, inner);
      const html = inner.join('');
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineTo(joined, env, out);
      out.push('</p>\n');
    }
    pos = p;
  }
  return { html: out.join(''), toc, excerpt };
}

// --------------------------------------------------------------- templates

class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain, or undefined. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string, number in JavaScript's digits, true/false, array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out`, in `scope` ({ vars, parent }). `ctx` holds the
 * parsed templates and the include depth (at most 8 deep renders something).
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        pushEscaped(textOf(lookup(scope, n.path)), out);
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// -------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true; // ':'
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  const templateNames = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of templateNames) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, reserved directory, post without a
  //    date, layout that parses, draft. The first failure is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files.
  //    Relative targets resolve the same way from the same directory over and
  //    over, so resolved paths are cached per case.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolvedPaths = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        if (rel === '') {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        const cacheKey = dir + '\n' + rel;
        let path;
        if (resolvedPaths.has(cacheKey)) path = resolvedPaths.get(cacheKey);
        else {
          path = resolvePath(dir, rel);
          resolvedPaths.set(cacheKey, path);
        }
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // A body's word count is read twice for a post (its card and its page),
    // so it is counted once here and kept on the source.
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index and tag pages.
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported above and each broken link, sorted,
  //    then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
