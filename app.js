'use strict';
// Kiertotie: a diagram board for an assistant that can only chat (Copilot, Claude).
// The loop: the starter text teaches the assistant to answer with an "Open in Kiertotie" link,
// the link opens the board, the user edits, Done copies the diagram and closes the tab,
// and the user pastes it back into the chat. A text readout serves the Edge sidebar Copilot.

// While the board floats (Document Picture-in-Picture), its elements live in the floating window's document.
let pipWin = null;
const doc = () => pipWin ? pipWin.document : document;
const $ = s => doc().querySelector(s) || document.querySelector(s);
// Document-level listeners, attached to this page and again to the floating window when it opens.
const docListeners = [];
function onDoc(type, fn) { docListeners.push([type, fn]); document.addEventListener(type, fn); }
const FONT = getComputedStyle(document.body).fontFamily;
const STORE_KEY = 'kiertotie.v1';
const BASE = location.origin + location.pathname;

const state = { dir: 'LR', nodes: new Map(), groups: new Map(), edges: [], pos: new Map(), classDefs: new Map(), theme: null, ink: [], comments: [] };
// Shapes Mermaid lacks, written as a class on a plain box (n1["…"]:::sticky); their content lives in canvas lines.
const CLASS_SHAPES = new Set(['sticky', 'table', 'doc', 'phone', 'browser', 'image', 'uiTopbar', 'uiHeading', 'uiText', 'uiInput', 'uiButton', 'uiLink',
  'uiCheckbox', 'uiImage', 'uiList', 'uiTable', 'uiTabbar', 'uiSidebar']);
// Canvas-line payloads are percent-encoded, since a line also ends at ;
const enc = s => encodeURIComponent(s), dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
let boxes = new Map();       // node id -> {x, y, w, h, shape} (centre)
let groupBoxes = new Map();  // group id -> {x, y, w, h}
let view = { x: 0, y: 0, k: 1 };
let sel = null;              // {type: 'node'|'group', id} | {type: 'edge', i}
let markMode = false;
let flash = new Map();       // id -> 'add' | 'change'
const undoStack = [];

// ---------- Mermaid flowchart subset ----------

const SHAPES = [
  ['([', '])', 'stadium'], ['[(', ')]', 'cylinder'], ['((', '))', 'circle'], ['[[', ']]', 'subroutine'],
  ['{{', '}}', 'hexagon'], ['[/', '/]', 'box'], ['[\\', '\\]', 'box'], ['[', ']', 'box'],
  ['(', ')', 'round'], ['{', '}', 'diamond'], ['>', ']', 'flag'],
];
const WRAP = { box: ['[', ']'], round: ['(', ')'], stadium: ['([', '])'], cylinder: ['[(', ')]'], circle: ['((', '))'],
  subroutine: ['[[', ']]'], hexagon: ['{{', '}}'], diamond: ['{', '}'], flag: ['>', ']'] };
const ID_RE = /^[\wÀ-￿]+(?:-(?![-.>])[\wÀ-￿]+)*/;
const EDGE_PLAIN = /^\s*(<)?(-\.+->|-\.+-|={2,}>|={3,}|-{2,}>|-{3,})\s*(?:\|([^|]*)\|)?\s*/;
const EDGE_TEXT = /^\s*(<)?(--|==|-\.)\s+(.+?)\s+(-{2,}>|={2,}>|\.->|-{3,}|={3,}|\.-)\s*/;

const cleanLabel = s => s.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^`|`$/g, '').replace(/<br\s*\/?>|\\n/gi, '\n').replace(/#quot;/g, '"');

function readShape(s, i) {
  for (const [open, close, shape] of SHAPES) {
    if (!s.startsWith(open, i)) continue;
    const j = i + open.length;
    const q = s.slice(j).match(/^\s*"/);
    if (q) {
      const qs = j + q[0].length, qe = s.indexOf('"', qs);
      if (qe < 0) continue;
      const gap = s.slice(qe + 1).match(/^\s*/)[0].length;
      if (!s.startsWith(close, qe + 1 + gap)) continue;
      return { shape, label: cleanLabel(s.slice(qs, qe)), end: qe + 1 + gap + close.length };
    }
    const ce = s.indexOf(close, j);
    if (ce < 0) continue;
    return { shape, label: cleanLabel(s.slice(j, ce)), end: ce + close.length };
  }
  // A shape that runs to the end of the line without its closing bracket: chat apps often
  // cut the last ] or ) off a link because they read it as punctuation.
  if (!/[-=]{2}|-\./.test(s.slice(i))) {
    for (const [open, , shape] of SHAPES) {
      if (!s.startsWith(open, i)) continue;
      const label = cleanLabel(s.slice(i + open.length).replace(/[\])}>/\\]+\s*$/, ''));
      if (label) return { shape, label, end: s.length };
    }
  }
  return null;
}

// Mermaid's newer shape names (id@{ shape: cyl }), plus sticky notes, which Mermaid itself lacks.
const NAMED_SHAPES = { rect: 'box', box: 'box', rounded: 'round', round: 'round', stadium: 'stadium', pill: 'stadium',
  cyl: 'cylinder', cylinder: 'cylinder', db: 'cylinder', database: 'cylinder', circle: 'circle', circ: 'circle',
  diam: 'diamond', diamond: 'diamond', decision: 'diamond', hex: 'hexagon', hexagon: 'hexagon', subproc: 'subroutine',
  subroutine: 'subroutine', odd: 'flag', text: 'text', sticky: 'sticky', note: 'sticky' };

// id@{ icon: "azure:key-vaults", label: "Secrets" } or id@{ shape: text, label: "..." }
function readAttrs(s, i) {
  if (!s.startsWith('@{', i)) return null;
  let j = i + 2, inQ = false;
  for (; j < s.length; j++) { if (s[j] === '"') inQ = !inQ; else if (s[j] === '}' && !inQ) break; }
  if (j >= s.length) return null;
  const attrs = {};
  for (const m of s.slice(i + 2, j).matchAll(/(\w+)\s*:\s*(?:"([^"]*)"|([^,]+))/g)) attrs[m[1].toLowerCase()] = (m[2] ?? m[3]).trim();
  const out = { end: j + 1 };
  if (attrs.icon) { out.shape = 'icon'; out.icon = attrs.icon; }
  else out.shape = NAMED_SHAPES[(attrs.shape || '').toLowerCase()] || 'box';
  if (attrs.label != null) out.label = cleanLabel(attrs.label);
  return out;
}

function readNode(s, i) {
  i += s.slice(i).match(/^\s*/)[0].length;
  const m = s.slice(i).match(ID_RE);
  if (!m) return null;
  const node = { id: m[0], end: i + m[0].length };
  const sh = readAttrs(s, node.end) || readShape(s, node.end);
  if (sh) Object.assign(node, sh);
  const cls = s.slice(node.end).match(/^:::([\w-]+)/);
  if (cls) { node.cls = cls[1]; node.end += cls[0].length; }
  return node;
}

function readNodeList(s, i) {
  const first = readNode(s, i);
  if (!first) return null;
  const list = [first];
  let end = first.end, m;
  while ((m = s.slice(end).match(/^\s*&\s*/))) {
    const n = readNode(s, end + m[0].length);
    if (!n) break;
    list.push(n); end = n.end;
  }
  return { list, end };
}

function readEdge(s, i) {
  const rest = s.slice(i);
  let m = rest.match(EDGE_PLAIN);
  if (m) return { tok: m[2], label: m[3] ? cleanLabel(m[3]) : '', back: !!m[1], end: i + m[0].length };
  m = rest.match(EDGE_TEXT);
  if (m) return { tok: m[2] + m[4], label: cleanLabel(m[3]), back: !!m[1], end: i + m[0].length };
  return null;
}

const edgeStyle = tok => tok.includes('.') ? 'dotted' : tok.includes('=') ? 'thick' : 'solid';
const slug = s => s.trim().replace(/[^\wÀ-￿]+/g, '_').replace(/^_|_$/g, '') || 'group';
const splitIds = s => s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);

// Colours: the fill, stroke and text colour parts of Mermaid's style and classDef lines.
const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([^)]*\))$/i;
function styleProps(text) {
  const st = {};
  for (const part of text.replace(/;$/, '').split(',')) {
    const [k, v] = part.split(':').map(x => x && x.trim());
    if (['fill', 'stroke', 'color'].includes(k) && v && COLOR_RE.test(v)) st[k] = v;
  }
  return st;
}
const propsText = st => Object.entries(st).map(([k, v]) => `${k}:${v}`).join(',');
function colorsOf(item) { return { ...(item.cls && state.classDefs.get(item.cls)), ...item.style }; }

// Dark or light text, whichever reads better on the fill.
function textOn(fill) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000'; c.fillStyle = fill; const hex = c.fillStyle;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1d2330' : '#ffffff';
}
// accent: the board style's colour for this frame, used where the item has no colour of its own.
function colorVars(item, accent = null) {
  const c = colorsOf(item), v = [];
  if (c.fill) v.push(`--nf:${c.fill}`); else if (accent?.fill) v.push(`--nf:${accent.fill}`);
  if (c.stroke) v.push(`--ns:${c.stroke}`); else if (accent?.stroke) v.push(`--ns:${accent.stroke}`);
  const t = c.color || (c.fill && textOn(c.fill));
  if (t) v.push(`--nt:${t}`);
  return v.length ? ` style="${esc(v.join(';'))}"` : '';
}

// Parses text into the current state. replace: start from an empty diagram (manual positions are kept).
// keep: a diagram that replaces this one keeps the line routes the user picked, like their positions.
// Undo and loading pass keep: false, since their text carries its own routes.
function parseInto(text, { replace, keep = true }) {
  const keptRoutes = new Map(keep ? state.edges.filter(e => e.route || e.color).map(e => [`${e.from}>${e.to}`, { route: e.route, color: e.color }]) : []);
  // What the user added that Mermaid can't carry stays too: zones, table cells, doc text, images.
  const keptExtra = new Map(keep ? [...state.nodes.values(), ...state.groups.values()].filter(x => x.table || x.body || x.src || x.zone || x.dev).map(x => [x.id, { table: x.table, body: x.body, src: x.src, zone: x.zone, dev: x.dev }]) : []);
  if (replace && !keep) { state.theme = null; state.ink = []; state.comments = []; }
  if (replace) { state.nodes = new Map(); state.groups = new Map(); state.edges = []; state.classDefs = new Map(); }
  const warnings = [];
  const stack = [];
  const fresh = new Set();
  const lines = text.split(/\n|;/);
  const pendPos = new Map();

  const touch = spec => {
    let n = state.nodes.get(spec.id);
    if (!n) { n = { id: spec.id, label: spec.id, shape: 'box', group: null, marked: false, implicit: true }; state.nodes.set(spec.id, n); fresh.add(spec.id); }
    if (spec.shape) {
      if (spec.label) n.label = spec.label; else if (n.implicit) n.label = spec.id;
      n.shape = spec.shape; n.icon = spec.icon || null; n.implicit = false;
    }
    const g = stack[stack.length - 1] || null;
    if (g && (fresh.has(spec.id) || spec.shape || !n.group)) n.group = g;
    if (spec.cls === 'marked') n.marked = true;
    else if (CLASS_SHAPES.has(spec.cls)) n.shape = spec.cls;
    else if (spec.cls) n.cls = spec.cls;
  };
  const pendRoute = new Map(), pendColor = new Map(), pendExtra = new Map();
  const extra = (id, k, v) => (pendExtra.get(id) || pendExtra.set(id, {}).get(id))[k] = v;
  const addEdge = (from, to, label, style, arrow) => {
    const e = state.edges.find(x => x.from === from && x.to === to);
    if (e) Object.assign(e, { label, style, arrow });
    else state.edges.push({ from, to, label, style, arrow });
  };

  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^%%\s*@pos\s+(\S+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+([\d.]+)\s+([\d.]+))?\s*$/))) {
      pendPos.set(m[1], m[4] ? { x: +m[2], y: +m[3], w: +m[4], h: +m[5] } : { x: +m[2], y: +m[3] });
      continue;
    }
    if ((m = line.match(/^%%\s*@theme\s+(\w+)\s*$/))) { state.theme = BOARD_STYLES[m[1]] && m[1] !== 'classic' ? m[1] : null; continue; }
    // Mermaid front matter (---, title: …) carries nothing the board uses.
    if (line === '---' || /^title:\s/.test(line)) continue;
    if ((m = line.match(/^%%\s*@route\s+(\S+)\s+(\S+)\s+(curved|elbow|straight)\s*$/))) { pendRoute.set(`${m[1]}>${m[2]}`, m[3]); continue; }
    if ((m = line.match(/^%%\s*@zone\s+(\S+)\s+(\w+)\s*$/))) { extra(m[1], 'zone', m[2]); continue; }
    if ((m = line.match(/^%%\s*@device\s+(\S+)\s+(\w+)\s*$/))) { if (DEVICE_ALIAS[m[2].toLowerCase()]) extra(m[1], 'dev', DEVICE_ALIAS[m[2].toLowerCase()]); continue; }
    if ((m = line.match(/^%%\s*@(table|doc|image)\s+(\S+)\s+(\S+)\s*$/))) {
      const v = dec(m[3]);
      if (m[1] === 'table') { try { extra(m[2], 'table', JSON.parse(v)); } catch { /* unreadable table */ } }
      else extra(m[2], m[1] === 'doc' ? 'body' : 'src', v);
      continue;
    }
    if ((m = line.match(/^%%\s*@ink\s+(\S+)\s+(pen|hl|arrow)\s+(#[0-9a-f]{3,8})\s+(.+)$/i))) {
      const pts = m[4].trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(q => q.length === 2 && q.every(Number.isFinite));
      state.ink = state.ink.filter(x => x.id !== m[1]);
      if (pts.length > 1) state.ink.push({ id: m[1], kind: m[2], color: m[3], pts });
      continue;
    }
    if ((m = line.match(/^%%\s*@comment\s+(\S+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\S*)\s*$/))) {
      state.comments = state.comments.filter(x => x.id !== m[1]);
      state.comments.push({ id: m[1], x: +m[2], y: +m[3], text: dec(m[4]) });
      continue;
    }
    if (!line || line.startsWith('%%')) continue;
    if ((m = line.match(/^(?:flowchart|graph)\s*(LR|RL|TD|TB|BT)?\s*$/i))) { state.dir = (m[1] || 'TD').toUpperCase().replace('TB', 'TD'); continue; }
    if ((m = line.match(/^classDef\s+([\w-]+)\s+(.+)$/))) { if (m[1] !== 'marked' && !CLASS_SHAPES.has(m[1]) && !DEVICE_ALIAS[m[1].toLowerCase()]) state.classDefs.set(m[1], styleProps(m[2])); continue; }
    if ((m = line.match(/^linkStyle\s+([\d\s,]+?)\s+(.+)$/))) {
      const st = styleProps(m[2]);
      if (st.stroke) for (const i of m[1].split(',')) pendColor.set(+i, st.stroke);
      continue;
    }
    if ((m = line.match(/^style\s+([\w\u00C0-\uFFFF-]+)\s+(.+)$/))) {
      const item = itemById(m[1]);
      if (item) item.style = { ...item.style, ...styleProps(m[2]) };
      continue;
    }
    if (/^(linkStyle|click|direction)\b/.test(line)) continue;
    if (line === 'end') { if (!stack.pop()) warnings.push('"end" without a subgraph'); continue; }
    if (/^clear$/i.test(line)) { state.nodes.clear(); state.groups.clear(); state.edges = []; continue; }
    if ((m = line.match(/^subgraph\s+(.+)$/))) {
      const rest = m[1].trim();
      let id, title, q, bare = false;
      if ((q = rest.match(/^([\wÀ-￿-]+)\s*\[\s*"?(.*?)"?\s*\]$/))) { id = q[1]; title = q[2]; }
      else if ((q = rest.match(/^"(.*)"$/))) { title = q[1]; id = slug(title); }
      else if (/^[\wÀ-￿-]+$/.test(rest)) { id = title = rest; bare = true; }
      else { title = rest; id = slug(rest); }
      const parent = stack[stack.length - 1] || null;
      const g = state.groups.get(id);
      if (g) { if (!bare) g.title = cleanLabel(title); if (parent) g.parent = parent; }
      else state.groups.set(id, { id, title: cleanLabel(title), parent, marked: false });
      stack.push(id);
      continue;
    }
    if ((m = line.match(/^class\s+(.+?)\s+([\w-]+)$/))) {
      for (const id of splitIds(m[1])) {
        const item = itemById(id);
        if (!item) continue;
        if (m[2] === 'marked') item.marked = true;
        else if (item === state.groups.get(id) && DEVICE_ALIAS[m[2].toLowerCase()]) item.dev = DEVICE_ALIAS[m[2].toLowerCase()];
        else if (CLASS_SHAPES.has(m[2])) { if (item === state.nodes.get(id)) item.shape = m[2]; }
        else item.cls = m[2];
      }
      continue;
    }
    if ((m = line.match(/^(mark|unmark)\s+(.+)$/i))) {
      const on = m[1].toLowerCase() === 'mark';
      const ids = /^all$/i.test(m[2].trim()) ? [...state.nodes.keys(), ...state.groups.keys()] : splitIds(m[2]);
      for (const id of ids) { const item = itemById(id); if (item) item.marked = on; }
      continue;
    }
    if ((m = line.match(/^(?:remove|delete)\s+(.+)$/i))) {
      const em = m[1].match(/^([\wÀ-￿-]+)\s*-[-.=]*>?\s*([\wÀ-￿-]+)$/);
      if (em) state.edges = state.edges.filter(e => !(e.from === em[1] && e.to === em[2]));
      else for (const id of splitIds(m[1])) removeItem(id);
      continue;
    }
    if ((m = line.match(/^rename\s+([\wÀ-￿-]+)\s*:\s*(.+)$/i))) {
      const item = itemById(m[1]);
      if (item) { if ('title' in item) item.title = cleanLabel(m[2]); else item.label = cleanLabel(m[2]); }
      continue;
    }

    const left0 = readNodeList(line, 0);
    if (!left0) { warnings.push(`Skipped: ${line}`); continue; }
    // Read the whole line first; only a line that reads to the end changes the diagram.
    let left = left0, i = left0.end, ok = true;
    const specs = [...left.list], links = [];
    for (;;) {
      const e = readEdge(line, i);
      if (!e) break;
      const right = readNodeList(line, e.end);
      if (!right) { ok = false; break; }
      specs.push(...right.list);
      links.push([left.list, right.list, e]);
      left = right; i = right.end;
    }
    const tail = line.slice(i).trim();
    if (!ok || (tail && !tail.startsWith('%%'))) { warnings.push(`Skipped: ${line}`); continue; }
    specs.forEach(touch);
    for (const [from, to, e] of links) {
      const style = edgeStyle(e.tok), arrow = e.tok.endsWith('>');
      for (const a of from) for (const b of to) {
        addEdge(a.id, b.id, e.label, style, arrow);
        if (e.back) addEdge(b.id, a.id, '', style, true);
      }
    }
  }
  if (stack.length) warnings.push('A subgraph is missing its "end"');
  for (const [id, p] of pendPos) state.pos.set(id, p);
  for (const e of state.edges) {
    const k = `${e.from}>${e.to}`, r = pendRoute.get(k) || (!e.route && keptRoutes.get(k)?.route);
    if (r) { if (r === 'curved') delete e.route; else e.route = r; }
    if (!e.color && keptRoutes.get(k)?.color) e.color = keptRoutes.get(k).color;
  }
  for (const [i, c] of pendColor) if (state.edges[i]) state.edges[i].color = c;
  for (const [id, x] of [...keptExtra, ...pendExtra]) {
    const item = itemById(id);
    if (item) for (const [k, v] of Object.entries(x)) if (v != null) item[k] = v;
  }

  // An implicit node with a group's id is a link to that group, not a box.
  for (const [id, n] of state.nodes) if (n.implicit && state.groups.has(id)) state.nodes.delete(id);
  for (const g of state.groups.values()) if (g.parent && !state.groups.has(g.parent)) g.parent = null;
  for (const n of state.nodes.values()) if (n.group && !state.groups.has(n.group)) n.group = null;
  for (const id of [...state.pos.keys()]) if (!state.nodes.has(id) && !state.groups.has(id)) state.pos.delete(id);
  return { warnings };
}

// A box or frame by id. A line to a frame first makes a placeholder box of that name; the frame wins over it.
function itemById(id) { const n = state.nodes.get(id); return (n?.implicit && state.groups.get(id)) || n || state.groups.get(id); }

function removeItem(id) {
  if (state.nodes.delete(id) || state.groups.has(id)) state.pos.delete(id);
  if (state.groups.has(id)) {
    const g = state.groups.get(id);
    for (const n of state.nodes.values()) if (n.group === id) n.group = g.parent;
    for (const c of state.groups.values()) if (c.parent === id) c.parent = g.parent;
    state.groups.delete(id);
  }
  state.edges = state.edges.filter(e => e.from !== id && e.to !== id);
}

const q = s => `"${s.replace(/"/g, '#quot;').replace(/\n/g, '<br>')}"`;

function toMermaid() {
  const L = [`flowchart ${state.dir}`];
  const decl = n => {
    if (n.shape === 'icon') return `${n.id}@{ icon: "${n.icon}", label: ${q(n.label)} }`;
    if (n.shape === 'text') return `${n.id}@{ shape: text, label: ${q(n.label)} }`;
    const [o, c] = WRAP[n.shape] || WRAP.box; return `${n.id}${o}${q(n.label)}${c}`;
  };
  const emit = (gid, ind) => {
    for (const g of state.groups.values()) if (g.parent === gid) {
      L.push(`${ind}subgraph ${g.id}[${q(g.title)}]`);
      emit(g.id, ind + '  ');
      L.push(`${ind}end`);
    }
    for (const n of state.nodes.values()) if (n.group === gid) L.push(ind + decl(n));
  };
  emit(null, '  ');
  for (const e of state.edges) {
    const base = e.style === 'dotted' ? (e.arrow ? '-.->' : '-.-') : e.style === 'thick' ? (e.arrow ? '==>' : '===') : (e.arrow ? '-->' : '---');
    L.push(`  ${e.from} ${base}${e.label ? `|${q(e.label)}|` : ''} ${e.to}`);
  }
  const items = [...state.nodes.values(), ...state.groups.values()];
  for (const [name, st] of state.classDefs) if (items.some(x => x.cls === name)) L.push(`  classDef ${name} ${propsText(st)}`);
  const byCls = new Map();
  for (const x of items) if (x.cls && state.classDefs.has(x.cls)) (byCls.get(x.cls) || byCls.set(x.cls, []).get(x.cls)).push(x.id);
  for (const [name, ids] of byCls) L.push(`  class ${ids.join(',')} ${name}`);
  // Other Mermaid tools draw these as boxes with the class's colours.
  const CLASS_LOOK = { sticky: `fill:${STICKY.fill},stroke:${STICKY.stroke}`, table: 'fill:#ffffff,stroke:#868e96', doc: 'fill:#ffffff,stroke:#868e96',
    phone: 'fill:#ffffff,stroke:#1a1a1a', browser: 'fill:#ffffff,stroke:#1a1a1a', image: 'fill:#f1f3f5,stroke:#868e96' };
  for (const k of Object.keys(UI_KINDS)) CLASS_LOOK[k] = k === 'uiButton' ? 'fill:#5f6470,stroke:#5f6470,color:#ffffff' : 'fill:#eceef2,stroke:#c4c8d0,color:#4b5160';
  for (const c of CLASS_SHAPES) {
    const ids = [...state.nodes.values()].filter(n => n.shape === c).map(n => n.id);
    if (ids.length) L.push(`  classDef ${c} ${CLASS_LOOK[c]}`, `  class ${ids.join(',')} ${c}`);
  }
  for (const d of Object.keys(DEVICES)) {
    const ids = [...state.groups.values()].filter(g => g.dev === d).map(g => g.id);
    if (ids.length) L.push(`  classDef ${d} fill:#ffffff,stroke:#1a1a1a`, `  class ${ids.join(',')} ${d}`);
  }
  state.edges.forEach((e, i) => { if (e.color) L.push(`  linkStyle ${i} stroke:${e.color}`); });
  for (const x of items) if (x.style && Object.keys(x.style).length) L.push(`  style ${x.id} ${propsText(x.style)}`);
  const marked = items.filter(x => x.marked).map(x => x.id);
  if (marked.length) {
    L.push('  classDef marked fill:#ffe066,stroke:#e0a800,stroke-width:2px');
    L.push(`  class ${marked.join(',')} marked`);
  }
  return L.join('\n');
}

// Canvas lines: what only the board needs (hand-placed positions and sizes, line routes). Mermaid skips %% lines.
// images: false leaves pictures out (share links and QR codes would get too long).
function canvasLines({ images = true } = {}) {
  const r = Math.round, L = [];
  for (const [id, p] of state.pos) {
    if (!state.nodes.has(id) && !state.groups.has(id)) continue;
    if (p.x == null) continue;
    L.push(`%% @pos ${id} ${r(p.x)} ${r(p.y)}${p.w ? ` ${r(p.w)} ${r(p.h)}` : ''}`);
  }
  for (const e of state.edges) if (e.route) L.push(`%% @route ${e.from} ${e.to} ${e.route}`);
  if (state.theme) L.push(`%% @theme ${state.theme}`);
  for (const g of state.groups.values()) if (g.zone) L.push(`%% @zone ${g.id} ${g.zone}`);
  for (const n of state.nodes.values()) {
    if (n.table) L.push(`%% @table ${n.id} ${enc(JSON.stringify(n.table))}`);
    if (n.body) L.push(`%% @doc ${n.id} ${enc(n.body)}`);
    if (n.src && images) L.push(`%% @image ${n.id} ${enc(n.src)}`);
  }
  for (const k of state.ink) L.push(`%% @ink ${k.id} ${k.kind} ${k.color} ${k.pts.map(([x, y]) => `${r(x)},${r(y)}`).join(' ')}`);
  for (const c of state.comments) L.push(`%% @comment ${c.id} ${r(c.x)} ${r(c.y)} ${enc(c.text)}`);
  return L;
}

// ---------- sizes ----------

const measure = document.createElement('canvas').getContext('2d');
function textWidth(s, size = 14, weight = 500) {
  measure.font = `${weight} ${size}px ${BOARD_STYLES[state.theme]?.font || FONT}`;
  return measure.measureText(s).width;
}

// Greedy word wrap; a word longer than the width keeps a line of its own.
function wrapLabel(label, maxW, size = 14, weight = 500) {
  const out = [];
  for (const para of String(label).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size, weight) > maxW) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

// p: the hand-set size, if the user resized the box.
function nodeSize(n, p = {}) {
  const fw = p.w, fh = p.h || 0;
  if (n.shape === 'icon') {
    const lines = wrapLabel(n.label, fw ? fw - 8 : 130, 12);
    const tw = Math.max(0, ...lines.map(l => textWidth(l, 12)));
    return { w: fw || Math.max(64, tw + 12), h: 50 + lines.length * 15, lines };
  }
  if (n.shape === 'sticky') {
    const w = fw || 160, lines = wrapLabel(n.label, w - 28);
    return { w, h: Math.max(fh || w, lines.length * 18 + 28), lines };
  }
  if (n.shape === 'table') {
    // Columns as wide as their widest cell; the caption sits above the grid.
    const rows = n.table || [['']], cols = Math.max(...rows.map(r => r.length));
    const colW = [...Array(cols)].map((_, c) => Math.max(40, ...rows.map((r, i) => textWidth(r[c] || '', 12.5, i ? 400 : 600) + 18)));
    const natural = colW.reduce((a, b) => a + b, 0);
    const scale = fw ? fw / natural : 1;
    return { w: fw || natural, h: Math.max(fh, 26 + rows.length * 26), colW: colW.map(x => x * scale), rows, lines: [n.label] };
  }
  if (n.shape === 'doc') {
    const w = fw || 280, body = wrapLabel(n.body || '', w - 28, 12.5, 400), title = wrapLabel(n.label, w - 28, 15, 700);
    return { w, h: Math.max(fh, 24 + title.length * 20 + (n.body ? 8 + body.length * 17 : 0) + 12), lines: title, body };
  }
  if (n.shape === 'phone') return { w: fw || 200, h: fh || 380, lines: wrapLabel(n.label, (fw || 200) - 30, 13) };
  if (n.shape === 'browser') return { w: fw || 440, h: fh || 280, lines: [n.label] };
  if (n.shape === 'image') return { w: fw || 240, h: fh || 160, lines: [] };
  if (n.shape === 'text') {
    const lines = wrapLabel(n.label, fw ? fw - 8 : 320, 16);
    const tw = Math.max(0, ...lines.map(l => textWidth(l, 16)));
    return { w: fw || Math.max(40, tw + 12), h: Math.max(fh, lines.length * 21 + 10), lines };
  }
  const lines = wrapLabel(n.label, fw ? fw - 24 : 200);
  const tw = Math.max(...lines.map(l => textWidth(l)));
  let w = Math.max(100, tw + 32), h = Math.max(44, lines.length * 18 + 24);
  if (n.shape === 'circle') w = h = Math.max(w, h, 64);
  else if (n.shape === 'diamond') { w = Math.max(110, tw * 1.35 + 52); h = Math.max(64, lines.length * 18 + 46); }
  else if (n.shape === 'hexagon' || n.shape === 'flag') w += 24;
  else if (n.shape === 'cylinder') h += 14;
  if (fw) { w = fw; h = Math.max(fh, lines.length * 18 + 16); }
  return { w, h, lines };
}

// ---------- screens: devices and wireframe pieces ----------

// A screen is a frame with a device (class login phone, or %% @device login phone). Its pieces are ordinary
// boxes with a ui class (l1["Email"]:::uiInput) that stack inside it from the top, like a real screen.
const DEVICES = {
  phone: { name: 'Phone', w: 220, h: 440, top: 26, bottom: 14, pad: 14 },
  tablet: { name: 'Tablet', w: 360, h: 500, top: 22, bottom: 12, pad: 20 },
  desktop: { name: 'Desktop', w: 560, h: 350, top: 24, bottom: 0, pad: 22 },
};
const DEVICE_ALIAS = { phone: 'phone', mobile: 'phone', tablet: 'tablet', ipad: 'tablet', desktop: 'desktop', browser: 'desktop', web: 'desktop', laptop: 'desktop' };
// Pieces: name, height (null: from the text), and the default text. Menus and tables list items one per line or split by |.
const UI_KINDS = {
  uiTopbar: { name: 'Top bar', h: 34, def: 'Title' },
  uiHeading: { name: 'Heading', h: 24, def: 'Heading' },
  uiText: { name: 'Text', h: null, def: '' },
  uiInput: { name: 'Input field', h: 30, def: 'Placeholder' },
  uiButton: { name: 'Button', h: 32, def: 'Button' },
  uiLink: { name: 'Link', h: 18, def: 'Link' },
  uiCheckbox: { name: 'Checkbox', h: 20, def: 'Remember me' },
  uiImage: { name: 'Image', h: 96, def: '' },
  uiList: { name: 'List', h: null, def: 'First item\nSecond item\nThird item' },
  uiTable: { name: 'Table', h: null, def: 'Name | Status | Date' },
  uiTabbar: { name: 'Bottom menu', h: 40, def: 'Home\nSearch\nProfile' },
  uiSidebar: { name: 'Side menu', h: null, def: 'Home\nProjects\nSettings' },
};
const isUi = n => !!(n && UI_KINDS[n.shape]);
const uiItems = label => String(label || '').split(/\n|\|/).map(t => t.trim()).filter(Boolean);
const deviceOf = gid => state.groups.get(gid)?.dev || null;

// Where each piece of a screen goes, relative to the screen's top-left corner, and how tall the screen gets.
function screenLayout(gid) {
  const own = state.pos.get(gid), D = { ...DEVICES[deviceOf(gid)], ...(own?.w ? { w: own.w, h: own.h } : {}) }, out = new Map();
  const kids = [...state.nodes.values()].filter(n => n.group === gid);
  const bars = kids.filter(n => n.shape === 'uiTopbar'), tabs = kids.filter(n => n.shape === 'uiTabbar'), side = kids.find(n => n.shape === 'uiSidebar');
  let top = D.top;
  for (const n of bars) { out.set(n.id, { x: 0, y: top, w: D.w, h: UI_KINDS.uiTopbar.h }); top += UI_KINDS.uiTopbar.h; }
  const sw = side ? Math.round(D.w * (deviceOf(gid) === 'phone' ? 0.5 : 0.24)) : 0;
  const x0 = sw + D.pad, cw = D.w - sw - D.pad * 2;
  let y = top + D.pad + 4;
  for (const n of kids) {
    if (n === side || bars.includes(n) || tabs.includes(n)) continue;
    const k = UI_KINDS[n.shape];
    let w = cw, h;
    if (k) {
      if (n.shape === 'uiText') h = n.label ? wrapLabel(n.label, cw, 11.5, 400).length * 15 + 4 : 34;
      else if (n.shape === 'uiList') h = uiItems(n.label).length * 30;
      else if (n.shape === 'uiTable') h = 22 + 3 * 20;
      else h = k.h;
      if (n.shape === 'uiImage' && deviceOf(gid) === 'desktop') h = 120;
    } else { const s = nodeSize(n); w = Math.min(cw, s.w); h = s.h; }
    out.set(n.id, { x: x0 + (cw - w) / 2, y, w, h });
    y += h + (n.shape === 'uiHeading' ? 8 : 10);
  }
  const tabH = tabs.length ? UI_KINDS.uiTabbar.h : 0;
  const H = Math.max(D.h, y + D.pad + tabH + D.bottom);
  for (const n of tabs) out.set(n.id, { x: 0, y: H - D.bottom - tabH, w: D.w, h: tabH });
  if (side) out.set(side.id, { x: 0, y: top, w: sw, h: H - top - D.bottom - tabH });
  return { w: D.w, h: H, pieces: out };
}

// ---------- layout ----------

// Every frame is laid out on its own first, then placed in its parent's flow as one block, so frames and
// screens line up along the flow instead of stacking. Within a block: break cycles, rank by longest path,
// order each rank by its neighbours, then place ranks along the main axis.
const FRAME_PAD = 20, FRAME_TITLE = 24;
let deviceRects = new Map();
function layout() {
  const horiz = state.dir === 'LR' || state.dir === 'RL', flip = state.dir === 'RL' || state.dir === 'BT';
  const GAP_MAIN = horiz ? 110 : 80, GAP_CROSS = horiz ? 36 : 44;
  const size = new Map([...state.nodes.values()].map(n => [n.id, nodeSize(n, state.pos.get(n.id))]));
  const kidsOf = gid => [
    ...[...state.nodes.values()].filter(n => (n.group || null) === gid).map(n => n.id),
    ...[...state.groups.values()].filter(g => (g.parent || null) === gid).map(g => g.id),
  ];
  // The item at this level that holds id: the box itself, or the frame around it.
  const itemAt = (id, gid) => {
    let cur = id, up = state.nodes.has(id) ? state.nodes.get(id).group || null : state.groups.get(id)?.parent || null;
    for (let k = 0; k < 50; k++) {
      if (up === gid) return cur;
      if (up == null) return null;
      cur = up; up = state.groups.get(up)?.parent || null;
    }
    return null;
  };
  const rel = new Map(), foot = new Map(), screens = new Map();
  const block = gid => {
    if (gid && deviceOf(gid)) { const sc = screenLayout(gid); screens.set(gid, sc); return { w: sc.w, h: sc.h }; }
    const items = kidsOf(gid);
    for (const id of items) {
      if (state.nodes.has(id)) foot.set(id, size.get(id));
      else { const b = block(id); foot.set(id, { w: b.w + (deviceOf(id) ? 0 : FRAME_PAD * 2), h: b.h + (deviceOf(id) ? 0 : FRAME_PAD * 2) + FRAME_TITLE }); }
    }
    if (!items.length) return { w: 160, h: 60 };
    const set = new Set(items), out = new Map(items.map(id => [id, new Set()]));
    for (const e of state.edges) { const a = itemAt(e.from, gid), b = itemAt(e.to, gid); if (a && b && a !== b && set.has(a) && set.has(b)) out.get(a).add(b); }
    // Cycles broken by a depth-first walk; ranks by longest path.
    const seen = new Map(), dag = [];
    const visit = u => { seen.set(u, 1); for (const v of out.get(u)) { if (seen.get(v) === 1) continue; dag.push([u, v]); if (!seen.get(v)) visit(v); } seen.set(u, 2); };
    // Start from where flows begin (nothing points there), so a loop back doesn't turn the flow around.
    const indeg = new Map(items.map(id => [id, 0])); for (const vs of out.values()) for (const v of vs) indeg.set(v, indeg.get(v) + 1);
    [...items].sort((x, y) => (indeg.get(x) > 0) - (indeg.get(y) > 0)).forEach(id => seen.get(id) || visit(id));
    const rank = new Map(items.map(id => [id, 0]));
    for (let k = 0; k < items.length; k++) { let ch = false; for (const [u, v] of dag) if (rank.get(v) < rank.get(u) + 1) { rank.set(v, rank.get(u) + 1); ch = true; } if (!ch) break; }
    const maxR = Math.max(...rank.values());
    if (flip) for (const id of items) rank.set(id, maxR - rank.get(id));
    const layers = [...Array(maxR + 1)].map(() => []);
    items.forEach(id => layers[rank.get(id)].push(id));
    const preds = new Map(items.map(id => [id, []])), succs = new Map(items.map(id => [id, []]));
    for (const [u, v] of dag) { succs.get(u).push(v); preds.get(v).push(u); }
    const index = new Map(), reindex = () => layers.forEach(l => l.forEach((id, i) => index.set(id, i)));
    reindex();
    const order = (layer, nbrs) => {
      const bary = new Map(layer.map(id => { const ns = nbrs.get(id).filter(n => index.has(n)); return [id, ns.length ? ns.reduce((a, n) => a + index.get(n), 0) / ns.length : index.get(id)]; }));
      layer.sort((a, b) => bary.get(a) - bary.get(b));
    };
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let r = 1; r < layers.length; r++) { order(layers[r], flip ? succs : preds); reindex(); }
      for (let r = layers.length - 2; r >= 0; r--) { order(layers[r], flip ? preds : succs); reindex(); }
    }
    const main = id => horiz ? foot.get(id).w : foot.get(id).h, cross = id => horiz ? foot.get(id).h : foot.get(id).w;
    let m = 0;
    const along = new Map(), across = new Map();
    for (const layer of layers) {
      const thick = Math.max(0, ...layer.map(main));
      const span = layer.reduce((a, id) => a + cross(id), 0) + GAP_CROSS * (layer.length - 1);
      let c = -span / 2;
      for (const id of layer) { along.set(id, m + thick / 2); across.set(id, c + cross(id) / 2); c += cross(id) + GAP_CROSS; }
      m += thick + GAP_MAIN;
    }
    // Pull each item towards the middle of the items it links to, keeping the order: fewer crossing, straighter lines.
    for (let pass = 0; pass < 3; pass++) for (const layer of layers) {
      for (let i = 0; i < layer.length; i++) {
        const id = layer[i], ns = [...preds.get(id), ...succs.get(id)];
        if (!ns.length) continue;
        const want = ns.reduce((a, n) => a + across.get(n), 0) / ns.length;
        const lo = i ? across.get(layer[i - 1]) + (cross(layer[i - 1]) + cross(id)) / 2 + GAP_CROSS : -Infinity;
        const hi = i < layer.length - 1 ? across.get(layer[i + 1]) - (cross(layer[i + 1]) + cross(id)) / 2 - GAP_CROSS : Infinity;
        across.set(id, Math.max(lo, Math.min(hi, want)));
      }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of items) {
      const [x, y] = horiz ? [along.get(id), across.get(id)] : [across.get(id), along.get(id)], f = foot.get(id);
      rel.set(id, { x, y });
      x0 = Math.min(x0, x - f.w / 2); x1 = Math.max(x1, x + f.w / 2); y0 = Math.min(y0, y - f.h / 2); y1 = Math.max(y1, y + f.h / 2);
    }
    for (const id of items) { const r = rel.get(id); rel.set(id, { x: r.x - x0, y: r.y - y0 }); }
    return { w: x1 - x0, h: y1 - y0 };
  };
  const all = block(null);
  // Absolute places: the board is centred on 0,0; a frame's boxes start inside its padding, below its title.
  const result = new Map();
  deviceRects = new Map();
  const place = (gid, ox, oy) => {
    for (const id of kidsOf(gid)) {
      const r = rel.get(id); if (!r) continue;
      const cx = ox + r.x, cy = oy + r.y;
      if (state.nodes.has(id)) { result.set(id, { x: cx, y: cy }); continue; }
      const f = foot.get(id), bx = cx - f.w / 2, by = cy - f.h / 2 + FRAME_TITLE;
      if (deviceOf(id)) {
        const own = state.pos.get(id), sc = screens.get(id);
        const rx = own?.x != null ? own.x - sc.w / 2 : bx, ry = own?.x != null ? own.y - sc.h / 2 : by;
        deviceRects.set(id, { x: rx + sc.w / 2, y: ry + sc.h / 2, w: sc.w, h: sc.h });
        for (const [pid, p] of sc.pieces) { result.set(pid, { x: rx + p.x + p.w / 2, y: ry + p.y + p.h / 2 }); size.set(pid, { ...size.get(pid), w: p.w, h: p.h, lines: size.get(pid).lines }); }
      } else place(id, bx + FRAME_PAD, by + FRAME_PAD);
    }
  };
  place(null, -all.w / 2, -all.h / 2);

  boxes = new Map();
  for (const [id, n] of state.nodes) {
    const p = state.pos.get(id) || result.get(id) || { x: 0, y: 0 };
    const sz = state.pos.get(id)?.w && isUi(n) ? { ...size.get(id), w: state.pos.get(id).w, h: state.pos.get(id).h } : size.get(id);
    boxes.set(id, { x: p.x, y: p.y, ...sz, shape: n.shape });
  }
  computeGroupBoxes();
}

const groupDepth = g => { let d = 0, p = state.groups.get(g)?.parent; while (p && d < 20) { d++; p = state.groups.get(p)?.parent; } return d; };

// A frame wraps its boxes and subframes; a frame the user sized by hand is at least that big.
// skip: boxes left out, to ask which frame a dragged box was dropped into.
function groupBoxesFor(skip = null) {
  const out = new Map();
  const gs = [...state.groups.keys()].sort((a, b) => groupDepth(b) - groupDepth(a));
  for (const gid of gs) {
    // A screen is exactly its device: moved by hand, or where the layout put it.
    if (deviceOf(gid)) {
      const own = state.pos.get(gid), auto = deviceRects.get(gid);
      if (own?.x != null) out.set(gid, { x: own.x, y: own.y, w: auto?.w || own.w, h: auto?.h || own.h });
      else if (auto) out.set(gid, auto);
      continue;
    }
    const rects = [];
    for (const n of state.nodes.values()) if (n.group === gid && boxes.has(n.id) && !skip?.has(n.id)) rects.push(boxes.get(n.id));
    // A frame inside also needs room for its title, which sits above it.
    for (const c of state.groups.values()) if (c.parent === gid && out.has(c.id)) { const r = out.get(c.id); rects.push({ ...r, y: r.y - FRAME_TITLE / 2, h: r.h + FRAME_TITLE }); }
    const pad = FRAME_PAD, top = FRAME_PAD;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    if (rects.length) {
      x0 = Math.min(...rects.map(r => r.x - r.w / 2)) - pad; x1 = Math.max(...rects.map(r => r.x + r.w / 2)) + pad;
      y0 = Math.min(...rects.map(r => r.y - r.h / 2)) - top; y1 = Math.max(...rects.map(r => r.y + r.h / 2)) + pad;
    }
    const own = state.pos.get(gid);
    if (own?.w) {
      x0 = Math.min(x0, own.x - own.w / 2); x1 = Math.max(x1, own.x + own.w / 2);
      y0 = Math.min(y0, own.y - own.h / 2); y1 = Math.max(y1, own.y + own.h / 2);
    }
    if (x0 === Infinity) continue;
    out.set(gid, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}
function computeGroupBoxes() { groupBoxes = groupBoxesFor(); }

// The innermost frame under a point.
function groupAt(p, skip = null, not = null) {
  let best = null, area = Infinity;
  for (const [gid, b] of groupBoxesFor(skip)) {
    if (not?.has(gid)) continue;
    if (Math.abs(p.x - b.x) <= b.w / 2 && Math.abs(p.y - b.y) <= b.h / 2 && b.w * b.h < area) { best = gid; area = b.w * b.h; }
  }
  return best;
}

// ---------- board styles ----------

// One click recolours the board. Classic follows day and night; the others keep their own colours.
// Saved as one canvas line (%% @theme pastel), so the Mermaid stays plain for other tools.
const BOARD_STYLES = {
  classic: { name: 'Classic' },
  pastel: { name: 'Pastel', accents: ['#56b8a6', '#e3a93c', '#ea7f5f', '#7f88f5', '#de74a6'] },
  midnight: { name: 'Midnight', accents: ['#6cc7b9', '#f6c97f', '#f2805f', '#9ea9ff', '#f7a8cf'] },
  blueprint: { name: 'Blueprint', font: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  sketch: { name: 'Sketch', font: '"Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Sans MS", cursive' },
};
// Top-level frames take the style's accents in turn; frames inside share their parent's.
function accentOf(gid) {
  const acc = BOARD_STYLES[state.theme]?.accents;
  if (!acc || !gid || !state.groups.has(gid)) return null;
  let g = state.groups.get(gid), k = 0;
  while (g.parent && state.groups.has(g.parent) && k++ < 50) g = state.groups.get(g.parent);
  const tops = [...state.groups.values()].filter(x => !x.parent).map(x => x.id);
  return acc[tops.indexOf(g.id) % acc.length];
}
function setBoardStyle(k) {
  pushUndo();
  state.theme = k === 'classic' ? null : k;
  commit('board', `${BOARD_STYLES[k].name} style`);
  paintStyles();
}
function paintStyles() {
  const cur = state.theme || 'classic';
  $('#style-picks').innerHTML = Object.entries(BOARD_STYLES).map(([k, t]) => `<button type="button" class="style-pick" data-bstyle="${k}" aria-pressed="${k === cur}" title="${t.name}"><span class="style-sw" data-sw="${k}"></span>${t.name}</button>`).join('');
}

// ---------- architecture: zones, line types, steps ----------

// A zone is a frame with a kind: its colour, line style and title icon. A frame titled like one
// ("Resource group: prod", "VNet") becomes that zone by itself; %% @zone sets it by hand.
const ZONES = {
  internet: { name: 'Internet', stroke: '#64748b', dash: '2 5', icon: null, match: /^internet\b/i },
  onprem: { name: 'On-premises', stroke: '#475569', dash: '', icon: 'azure:on-premises-data-gateways', match: /on-?prem/i },
  mgmt: { name: 'Management group', stroke: '#0f6cbd', dash: '10 5', icon: 'azure:management-groups', match: /management group/i },
  subscription: { name: 'Azure subscription', stroke: '#c58b00', dash: '', icon: 'azure:subscriptions', match: /subscription/i },
  resourceGroup: { name: 'Resource group', stroke: '#2563eb', dash: '6 4', icon: 'azure:resource-groups', match: /resource group|^rg\b/i },
  vnet: { name: 'Virtual network', stroke: '#15803d', dash: '', icon: 'azure:virtual-networks', match: /virtual network|\bvnet\b/i },
  subnet: { name: 'Subnet', stroke: '#16a34a', dash: '4 3', icon: 'azure:subnet', match: /subnet/i },
  perimeter: { name: 'Perimeter / DMZ', stroke: '#dc2626', dash: '6 4', icon: 'azure:firewalls', match: /\bdmz\b|perimeter/i },
  ppEnv: { name: 'Power Platform environment', stroke: '#7c3aed', dash: '', icon: 'pp:power-platform', match: /power platform/i },
  external: { name: 'External system', stroke: '#9333ea', dash: '3 3', icon: null, match: /external|third.party|partner/i },
};
const zoneOf = g => g.zone === 'plain' ? null : g.zone && ZONES[g.zone] ? g.zone : Object.keys(ZONES).find(k => ZONES[k].match.test(g.title || '')) || null;

const LINE_TYPES = {
  https: { name: 'HTTPS request', style: 'solid', color: null, label: 'HTTPS' },
  auth: { name: 'Sign-in / token', style: 'dotted', color: '#0891b2', label: 'sign in' },
  private: { name: 'Private link', style: 'dotted', color: '#16a34a', label: 'private link' },
  vpn: { name: 'VPN / ExpressRoute', style: 'thick', color: '#7c3aed', label: 'VPN' },
  event: { name: 'Async message / event', style: 'dotted', color: '#d97706', label: 'event' },
  sync: { name: 'Data sync (both ways)', style: 'solid', color: '#2563eb', label: 'sync' },
  sql: { name: 'Database query', style: 'solid', color: null, label: 'SQL' },
};
const EDGE_COLORS = [{ name: 'Default', fill: null }, { name: 'Blue', fill: '#2563eb' }, { name: 'Green', fill: '#16a34a' }, { name: 'Orange', fill: '#d97706' },
  { name: 'Red', fill: '#dc2626' }, { name: 'Violet', fill: '#7c3aed' }, { name: 'Teal', fill: '#0891b2' }];
// A type sets the line's style, colour and label; a label the user wrote stays, after the step number.
function applyLineType(e, k) {
  const t = LINE_TYPES[k]; if (!e || !t) return;
  pushUndo();
  e.style = t.style; if (t.color) e.color = t.color; else delete e.color; e.arrow = true;
  const step = stepOf(e.label), rest = stripStep(e.label);
  if (!rest || Object.values(LINE_TYPES).some(x => x.label === rest)) e.label = (step ? `${step} ` : '') + t.label;
  if (k === 'sync' && !state.edges.some(o => o.from === e.to && o.to === e.from)) state.edges.push({ from: e.to, to: e.from, label: '', style: t.style, arrow: true, color: t.color });
  commit('board', `Made ${e.from} → ${e.to} ${t.name.toLowerCase()}`);
}

// Numbered steps: circled numbers at the start of the line labels, in flow order, so they show in any Mermaid viewer.
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const STEP_RE = /^(?:[①-⑳]|\(\d+\))\s*/;
const stepMark = n => n <= 20 ? CIRCLED[n - 1] : `(${n})`;
const stepOf = l => { const x = STEP_RE.exec(l || ''); return x ? x[0].trim() : ''; };
const stripStep = l => String(l || '').replace(STEP_RE, '');
function stepNumber(l) { const s = stepOf(l); if (!s) return 0; const i = CIRCLED.indexOf(s); return i >= 0 ? i + 1 : +s.replace(/\D/g, ''); }
function numberSteps() {
  const only = sel?.type === 'edge' ? [sel.i] : null;
  const idx = only || state.edges.map((_, i) => i);
  if (!idx.length) { toast('Add some lines first'); return; }
  // Flow order: by how far each line starts from where the flow begins.
  const incoming = new Map(); for (const e of state.edges) incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
  const depth = new Map(), q = [...state.nodes.keys(), ...state.groups.keys()].filter(id => !incoming.get(id)).map(id => [id, 0]);
  for (const [id] of q) depth.set(id, 0);
  while (q.length) { const [id, d] = q.shift(); for (const e of state.edges) if (e.from === id && !depth.has(e.to)) { depth.set(e.to, d + 1); q.push([e.to, d + 1]); } }
  const dOf = id => depth.has(id) ? depth.get(id) : 1e6;
  const order = [...idx].sort((a, b) => dOf(state.edges[a].from) - dOf(state.edges[b].from) || dOf(state.edges[a].to) - dOf(state.edges[b].to) || a - b);
  pushUndo();
  order.forEach((i, n) => { const e = state.edges[i], rest = stripStep(e.label); e.label = stepMark(n + 1) + (rest ? ` ${rest}` : ''); });
  commit('board', `Numbered ${order.length} steps`);
}
function clearSteps() { pushUndo(); for (const e of state.edges) if (stepOf(e.label)) e.label = stripStep(e.label); commit('board', 'Removed the step numbers'); }
// A table next to the diagram listing every numbered step: what happens, from where, to where.
function addLegend() {
  const name = id => (state.nodes.get(id)?.label || state.groups.get(id)?.title || id).replace(/\n/g, ' ');
  const steps = state.edges.map(e => ({ n: stepNumber(e.label), e })).filter(x => x.n).sort((a, b) => a.n - b.n);
  if (!steps.length) { toast('Number the steps first: More → Number the steps'); return; }
  const table = [['Step', 'What happens', 'From', 'To'], ...steps.map(({ n, e }) => [stepMark(n), stripStep(e.label) || '—', name(e.from), name(e.to)])];
  const old = [...state.nodes.values()].find(n => n.shape === 'table' && n.label === 'Flow steps');
  pushUndo(); pinAll();
  if (old) { old.table = table; commit('board', 'Updated the step legend'); return; }
  const all = contentBoxes(), x1 = Math.max(...all.map(b => b.x + b.w / 2)), y0 = Math.min(...all.map(b => b.y - b.h / 2));
  const id = freeId('legend', false);
  state.nodes.set(id, { id, label: 'Flow steps', shape: 'table', table, group: null, marked: false });
  state.pos.set(id, { x: x1 + 260, y: y0 + 20 + table.length * 14 });
  sel = { type: 'node', id };
  commit('board', 'Added a step legend');
}

// ---------- rendering ----------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shapeSvg(b) {
  const { w, h } = b, x = -w / 2, y = -h / 2;
  switch (b.shape) {
    case 'round': return `<rect class="node-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/>`;
    case 'stadium': return `<rect class="node-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
    case 'circle': return `<circle class="node-shape" r="${w / 2}"/>`;
    case 'diamond': return `<polygon class="node-shape" points="0,${y} ${-x},0 0,${-y} ${x},0"/>`;
    case 'hexagon': return `<polygon class="node-shape" points="${x + 14},${y} ${-x - 14},${y} ${-x},0 ${-x - 14},${-y} ${x + 14},${-y} ${x},0"/>`;
    case 'flag': return `<polygon class="node-shape" points="${x},${y} ${-x},${y} ${-x},${-y} ${x},${-y} ${x + 14},0"/>`;
    case 'cylinder': {
      const ry = 7;
      return `<path class="node-shape" d="M${x},${y + ry} a${w / 2},${ry} 0 0,1 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0,1 ${-w},0 z"/>` +
        `<path class="node-shape" d="M${x},${y + ry} a${w / 2},${ry} 0 0,0 ${w},0" fill="none"/>`;
    }
    case 'subroutine': return `<rect class="node-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>` +
      `<path class="node-shape" d="M${x + 8},${y} v${h} M${-x - 8},${y} v${h}"/>`;
    case 'sticky': return `<rect class="node-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>`;
    case 'text': case 'icon': return `<rect class="node-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`;
    default: return `<rect class="node-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`;
  }
}

function textSvg(lines, dy = 0, step = 18) {
  const start = -(lines.length - 1) * step / 2 + dy;
  return `<text text-anchor="middle" dominant-baseline="central">${lines.map((l, i) => `<tspan x="0" y="${start + i * step}">${esc(l)}</tspan>`).join('')}</text>`;
}

// What goes inside a node's <g>, centred on 0,0.
// Wireframe pieces in greys, as in Miro's wireframe kit; a fill colour on a piece is its accent.
function uiSvg(n, b) {
  // An empty label falls back to the id elsewhere; on a piece it just means no text.
  const w = b.w, h = b.h, x0 = -w / 2, y0 = -h / 2, acc = colorsOf(n).fill, label = n.label === n.id ? '' : n.label || '';
  const T = (t, x, y, cls, anchor = 'start', fill = null) => `<text class="ui-t ${cls}" x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central"${fill ? ` style="fill:${esc(fill)}"` : ''}>${esc(t)}</text>`;
  const bars = (x, y, ws) => ws.map((f, i) => `<rect class="ui-bar" x="${x}" y="${y + i * 10}" width="${w * f}" height="5" rx="2.5"/>`).join('');
  switch (n.shape) {
    case 'uiTopbar': return `<rect class="ui-top" x="${x0}" y="${y0}" width="${w}" height="${h}"/><path class="ui-line" d="M${x0},${-y0} h${w}"/>` +
      `<path class="ui-ico" d="M${x0 + 12},-4 h12 M${x0 + 12},0 h12 M${x0 + 12},4 h12"/>${T(label, 0, 0, 'ui-title', 'middle')}<circle class="ui-avatar" cx="${-x0 - 18}" cy="0" r="7"/>`;
    case 'uiHeading': return `<rect class="ui-hit" x="${x0}" y="${y0}" width="${w}" height="${h}"/>${T(label, x0, 0, 'ui-h')}`;
    case 'uiText': {
      if (!label) return `<rect class="ui-hit" x="${x0}" y="${y0}" width="${w}" height="${h}"/>${bars(x0, y0 + 5, [1, 0.92, 0.6])}`;
      const lines = wrapLabel(label, w, 11.5, 400);
      return `<rect class="ui-hit" x="${x0}" y="${y0}" width="${w}" height="${h}"/>${lines.map((l, i) => T(l, x0, y0 + 9 + i * 15, 'ui-p')).join('')}`;
    }
    case 'uiInput': return `<rect class="ui-input" x="${x0}" y="${y0}" width="${w}" height="${h}" rx="5"/>${T(label, x0 + 10, 0, 'ui-ph')}`;
    case 'uiButton': return `<rect class="ui-btn" x="${x0}" y="${y0}" width="${w}" height="${h}" rx="6"${acc ? ` style="fill:${esc(acc)}"` : ''}/>${T(label, 0, 0, 'ui-btn-t', 'middle')}`;
    case 'uiLink': return `<rect class="ui-hit" x="${x0}" y="${y0}" width="${w}" height="${h}"/>${T(label, 0, 0, 'ui-link', 'middle', acc)}`;
    case 'uiCheckbox': return `<rect class="ui-hit" x="${x0}" y="${y0}" width="${w}" height="${h}"/><rect class="ui-input" x="${x0}" y="-7" width="14" height="14" rx="3"/>${T(label, x0 + 22, 0, 'ui-p')}`;
    case 'uiImage': return `<rect class="ui-img" x="${x0}" y="${y0}" width="${w}" height="${h}" rx="6"/><path class="ui-img-x" d="M${x0},${y0} L${-x0},${-y0} M${-x0},${y0} L${x0},${-y0}"/>` +
      (label ? T(label, 0, 0, 'ui-cap', 'middle') : '');
    case 'uiList': return `<rect class="ui-hit" x="${x0}" y="${y0}" width="${w}" height="${h}"/>` + uiItems(label).map((t, i) => {
      const y = y0 + i * 30 + 15;
      return `<circle class="ui-avatar" cx="${x0 + 10}" cy="${y}" r="9"/>${T(t, x0 + 26, y, 'ui-p')}<path class="ui-ico" d="M${-x0 - 8},${y - 4} l4,4 l-4,4"/>${i ? `<path class="ui-line" d="M${x0},${y - 15} h${w}"/>` : ''}`;
    }).join('');
    case 'uiTable': {
      const cols = uiItems(label).length ? uiItems(label) : ['Name', 'Status'], cw = w / cols.length;
      return `<rect class="ui-input" x="${x0}" y="${y0}" width="${w}" height="${h}" rx="5"/><rect class="ui-top" x="${x0 + 1}" y="${y0 + 1}" width="${w - 2}" height="21" rx="4"/>` +
        cols.map((c, i) => T(c, x0 + i * cw + 8, y0 + 11, 'ui-th')).join('') +
        [1, 2, 3].map(r => `<path class="ui-line" d="M${x0},${y0 + 22 + (r - 1) * 20} h${w}"/>` + cols.map((_, i) => `<rect class="ui-bar" x="${x0 + i * cw + 8}" y="${y0 + 22 + (r - 1) * 20 + 8}" width="${cw * 0.55}" height="5" rx="2.5"/>`).join('')).join('');
    }
    case 'uiTabbar': {
      const items = uiItems(label), iw = w / Math.max(1, items.length);
      return `<rect class="ui-tab" x="${x0}" y="${y0}" width="${w}" height="${h}"/><path class="ui-line" d="M${x0},${y0} h${w}"/>` +
        items.map((t, i) => { const cx = x0 + iw * (i + 0.5), on = i === 0; return `<circle class="ui-dot${on ? ' on' : ''}" cx="${cx}" cy="${y0 + 13}" r="5"${on && acc ? ` style="fill:${esc(acc)}"` : ''}/>${T(t, cx, y0 + 29, `ui-tab-t${on ? ' on' : ''}`, 'middle')}`; }).join('');
    }
    case 'uiSidebar': return `<rect class="ui-top" x="${x0}" y="${y0}" width="${w}" height="${h}"/><path class="ui-line" d="M${-x0},${y0} v${h}"/>` +
      uiItems(label).map((t, i) => `${i ? '' : `<rect class="ui-side-on" x="${x0 + 6}" y="${y0 + 8}" width="${w - 12}" height="24" rx="5"${acc ? ` style="fill:${esc(acc)}"` : ''}/>`}${T(t, x0 + 16, y0 + 20 + i * 28, `ui-p${i ? '' : ' on'}`)}`).join('');
  }
  return shapeSvg(b);
}

// A screen's device around its pieces: phone bezel and notch, tablet camera, desktop window bar.
function deviceSvg(dev, b, on) {
  const x0 = b.x - b.w / 2, y0 = b.y - b.h / 2, cls = `device-frame${on ? ' sel' : ''}`;
  if (dev === 'phone') return `<rect class="${cls}" x="${x0}" y="${y0}" width="${b.w}" height="${b.h}" rx="26"/>` +
    `<rect class="device-notch" x="${b.x - 26}" y="${y0 + 7}" width="52" height="12" rx="6"/><rect class="device-home" x="${b.x - 30}" y="${y0 + b.h - 8}" width="60" height="3" rx="1.5"/>`;
  if (dev === 'tablet') return `<rect class="${cls}" x="${x0}" y="${y0}" width="${b.w}" height="${b.h}" rx="18"/><circle class="device-notch" cx="${b.x}" cy="${y0 + 10}" r="3"/>`;
  return `<rect class="${cls}" x="${x0}" y="${y0}" width="${b.w}" height="${b.h}" rx="8"/><path class="device-bar" d="M${x0},${y0 + 24} h${b.w}"/>` +
    [0, 1, 2].map(i => `<circle class="device-dot" cx="${x0 + 13 + i * 12}" cy="${y0 + 12}" r="3.5"/>`).join('') +
    `<rect class="device-url" x="${x0 + 56}" y="${y0 + 6}" width="${Math.max(40, b.w - 112)}" height="12" rx="6"/>`;
}

function nodeInner(n, b) {
  if (isUi(n)) return uiSvg(n, b);
  if (n.shape === 'icon') {
    const ic = iconFor(n.icon), top = -b.h / 2;
    const pic = ic ? `<image href="${ic.uri}" x="-20" y="${top + 2}" width="40" height="40"/>`
      : `<rect class="icon-missing" x="-20" y="${top + 2}" width="40" height="40" rx="8"/><text class="icon-missing-q" x="0" y="${top + 23}" text-anchor="middle" dominant-baseline="central">${Icons.state === 'failed' || Icons.state === 'ready' ? '?' : '…'}</text>`;
    const lines = b.lines, start = top + 50 + 7;
    return shapeSvg(b) + pic + `<text class="icon-label" text-anchor="middle" dominant-baseline="central">${lines.map((l, i) => `<tspan x="0" y="${start + i * 15}">${esc(l)}</tspan>`).join('')}</text>`;
  }
  if (n.shape === 'text') return shapeSvg(b) + textSvg(b.lines, 0, 21);
  const x0 = -b.w / 2, y0 = -b.h / 2, r = `<rect class="node-shape" x="${x0}" y="${y0}" width="${b.w}" height="${b.h}"`;
  if (n.shape === 'table') {
    let out = `<text class="table-cap" x="${x0}" y="${y0 + 9}">${esc(n.label)}</text><rect class="node-shape" x="${x0}" y="${y0 + 22}" width="${b.w}" height="${b.h - 22}" rx="4"/>`;
    const top = y0 + 22, rh = (b.h - 22) / b.rows.length;
    out += `<rect class="table-head" x="${x0}" y="${top}" width="${b.w}" height="${rh}" rx="4"/>`;
    b.rows.forEach((row, i) => {
      let x = x0;
      if (i) out += `<path class="table-line" d="M${x0},${top + i * rh} h${b.w}"/>`;
      b.colW.forEach((cw, c) => {
        if (c && !i) out += `<path class="table-line" d="M${x},${top} v${b.h - 22}"/>`;
        out += `<text class="cell${i ? '' : ' head'}" x="${x + 9}" y="${top + i * rh + rh / 2}" dominant-baseline="central">${esc(row[c] || '')}</text>`;
        x += cw;
      });
    });
    return out;
  }
  if (n.shape === 'doc') {
    let y = y0 + 22, out = `${r} rx="8"/><path class="doc-fold" d="M${-x0 - 18},${y0} v14 h14"/>`;
    out += `<text class="doc-title">${b.lines.map((l, i) => `<tspan x="${x0 + 14}" y="${y + i * 20}">${esc(l)}</tspan>`).join('')}</text>`;
    y += b.lines.length * 20 + 6;
    if (b.body.length && n.body) out += `<text class="doc-body">${b.body.map((l, i) => `<tspan x="${x0 + 14}" y="${y + i * 17}">${esc(l)}</tspan>`).join('')}</text>`;
    return out;
  }
  if (n.shape === 'phone') {
    return `${r} rx="26"/><rect class="device-screen" x="${x0 + 8}" y="${y0 + 8}" width="${b.w - 16}" height="${b.h - 16}" rx="19"/>` +
      `<rect class="device-notch" x="-28" y="${y0 + 13}" width="56" height="12" rx="6"/>` +
      `<text class="device-title" text-anchor="middle">${b.lines.map((l, i) => `<tspan x="0" y="${y0 + 46 + i * 17}">${esc(l)}</tspan>`).join('')}</text>`;
  }
  if (n.shape === 'browser') {
    return `${r} rx="10"/><path class="device-bar" d="M${x0},${y0 + 30} h${b.w}"/>` +
      [0, 1, 2].map(i => `<circle class="device-dot" cx="${x0 + 14 + i * 13}" cy="${y0 + 15}" r="4"/>`).join('') +
      `<rect class="device-url" x="${x0 + 58}" y="${y0 + 7}" width="${Math.max(40, b.w - 76)}" height="16" rx="8"/>` +
      `<text class="device-title" x="${x0 + 68}" y="${y0 + 15}" dominant-baseline="central">${esc(n.label)}</text>`;
  }
  if (n.shape === 'image') {
    return n.src ? `<rect class="node-shape image-frame" x="${x0}" y="${y0}" width="${b.w}" height="${b.h}" rx="4"/><image href="${n.src}" x="${x0}" y="${y0}" width="${b.w}" height="${b.h}" preserveAspectRatio="xMidYMid meet"/>`
      : `${r} rx="4"/>${textSvg(['Image missing'])}`;
  }
  return shapeSvg(b) + textSvg(b.lines, n.shape === 'cylinder' ? 4 : 0);
}

// Where a line leaves a box: the middle of the side facing the other end.
function sideOf(b, toward, horiz) {
  const dx = toward.x - b.x, dy = toward.y - b.y;
  const h = horiz ?? Math.abs(dx) / (b.w / 2 || 1) >= Math.abs(dy) / (b.h / 2 || 1);
  return h ? { x: b.x + Math.sign(dx || 1) * b.w / 2, y: b.y, nx: Math.sign(dx || 1), ny: 0 }
    : { x: b.x, y: b.y + Math.sign(dy || 1) * b.h / 2, nx: 0, ny: Math.sign(dy || 1) };
}

// Lines curve unless set straight or elbow, as in orim.
const routeOf = e => e.route || 'curved';

// A line's path and a function for the point a fraction u along it.
function edgeGeometry(e, a, b) {
  // A line from a piece of a screen leaves through the screen's side, level with the piece.
  const screenOf = id => { const n = state.nodes.get(id); return n && deviceOf(n.group) && groupBoxes.get(n.group); };
  const exitFrom = (id, box, other) => {
    const sc = screenOf(id); if (!sc) return null;
    const dir = Math.sign((other.x - sc.x) || 1);
    return { x: sc.x + dir * sc.w / 2, y: box.y, nx: dir, ny: 0 };
  };
  const sa = exitFrom(e.from, a, b), sb = exitFrom(e.to, b, a);
  if (routeOf(e) === 'curved') {
    const s = sa || sideOf(a, b), t = sb || sideOf(b, a);
    // A line that also runs the other way keeps to its own side of the pair.
    if (state.edges.some(o => o.from === e.to && o.to === e.from)) {
      const k = e.from < e.to ? 7 : -7;
      for (const q of [s, t]) { if (q.nx) q.y += k; else q.x += k; }
    }
    const k = Math.max(30, Math.min(140, Math.hypot(t.x - s.x, t.y - s.y) * 0.45));
    const c1 = { x: s.x + s.nx * k, y: s.y + s.ny * k }, c2 = { x: t.x + t.nx * k, y: t.y + t.ny * k };
    const at = u => {
      const v = 1 - u;
      return { x: v ** 3 * s.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u ** 3 * t.x, y: v ** 3 * s.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u ** 3 * t.y };
    };
    return { d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`, at, start: s };
  }
  if (e.route === 'elbow') {
    const horiz = sa || sb ? true : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const s = sa || sideOf(a, b, horiz), t = sb || sideOf(b, a, horiz);
    const pts = horiz ? [s, { x: (s.x + t.x) / 2, y: s.y }, { x: (s.x + t.x) / 2, y: t.y }, t]
      : [s, { x: s.x, y: (s.y + t.y) / 2 }, { x: t.x, y: (s.y + t.y) / 2 }, t];
    return { d: `M${pts.map(p => `${p.x},${p.y}`).join(' L')}`, at: alongPolyline(pts), start: s };
  }
  // straight; a link that also runs the other way bends to its own side, so the pair doesn't overlap
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const bulge = state.edges.some(o => o.from === e.to && o.to === e.from) ? 34 : 0;
  const c = { x: (a.x + b.x) / 2 + nx * bulge, y: (a.y + b.y) / 2 + ny * bulge };
  const s = sa || clip(a, c.x, c.y), t = sb || clip(b, c.x, c.y);
  const at = u => ({ x: (1 - u) ** 2 * s.x + 2 * (1 - u) * u * c.x + u * u * t.x, y: (1 - u) ** 2 * s.y + 2 * (1 - u) * u * c.y + u * u * t.y });
  return { d: bulge ? `M${s.x},${s.y} Q${c.x},${c.y} ${t.x},${t.y}` : `M${s.x},${s.y} L${t.x},${t.y}`, at, start: s };
}
function alongPolyline(pts) {
  const segs = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const total = segs.reduce((s, x) => s + x, 0) || 1;
  return u => {
    let d = u * total;
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) { const f = segs[i] ? Math.min(1, d / segs[i]) : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f }; }
      d -= segs[i];
    }
  };
}

function anchorBox(id) {
  return boxes.get(id) || (groupBoxes.has(id) ? { ...groupBoxes.get(id), shape: 'box' } : null);
}

function clip(b, px, py) {
  const dx = px - b.x, dy = py - b.y;
  if (!dx && !dy) return { x: b.x, y: b.y };
  let t;
  if (b.shape === 'circle') t = (b.w / 2) / Math.hypot(dx, dy);
  else if (b.shape === 'diamond') t = 1 / (Math.abs(dx) / (b.w / 2) + Math.abs(dy) / (b.h / 2));
  else t = Math.min((b.w / 2) / Math.abs(dx || 1e-9), (b.h / 2) / Math.abs(dy || 1e-9));
  return { x: b.x + dx * t, y: b.y + dy * t };
}

function render() {
  const vp = $('#viewport');
  vp.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  let html = '';
  svg.dataset.style = state.theme || '';
  // The dots move and zoom with the board.
  const step = 20 * view.k * (view.k < 0.5 ? 2 : 1);
  svg.style.backgroundSize = `${step}px ${step}px`;
  svg.style.backgroundPosition = `${view.x}px ${view.y}px`;
  if (Icons.state === 'idle' && ([...state.nodes.values()].some(n => n.shape === 'icon') || [...state.groups.values()].some(g => ZONES[zoneOf(g)]?.icon))) loadIcons();
  for (const gid of [...groupBoxes.keys()].sort((a, b) => groupDepth(a) - groupDepth(b))) {
    const g = state.groups.get(gid), b = groupBoxes.get(gid);
    const Z = ZONES[zoneOf(g)];
    const cls = ['group', Z && 'zone', g.marked && 'marked', isSel(`g:${gid}`) && 'sel'].filter(Boolean).join(' ');
    const a = Z ? Z.stroke : accentOf(gid);
    const ic = Z?.icon && iconFor(Z.icon), x0 = b.x - b.w / 2, y0 = b.y - b.h / 2;
    // The title sits above the frame, as in Miro and orim; a screen draws its device instead of a frame.
    const title = (ic ? `<image href="${ic.uri}" x="${x0}" y="${y0 - 19}" width="15" height="15"/>` : '') +
      `<text class="group-title" x="${x0 + (ic ? 20 : 2)}" y="${y0 - 11}" dominant-baseline="central">${esc(g.title)}</text>`;
    if (g.dev) { html += `<g class="${cls} screen" data-group="${esc(gid)}">${deviceSvg(g.dev, b, isSel(`g:${gid}`))}${title}</g>`; continue; }
    html += `<g class="${cls}" data-group="${esc(gid)}"${colorVars(g, a && { stroke: a, fill: `color-mix(in srgb, ${a} ${Z ? 5 : 9}%, transparent)` })}>` +
      `<rect x="${x0}" y="${y0}" width="${b.w}" height="${b.h}" rx="8"${Z ? ` style="stroke-dasharray:${Z.dash || 'none'}"` : ''}/>${title}</g>`;
  }
  // Labels already placed, and the boxes, so labels can step aside from them.
  // Labels step aside from boxes, screens and frame titles.
  const taken = [...boxes.values()].map(b => ({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, y0: b.y - b.h / 2, y1: b.y + b.h / 2 }));
  for (const [gid, b] of groupBoxes) {
    const x0 = b.x - b.w / 2, y0 = b.y - b.h / 2;
    taken.push({ x0, x1: x0 + textWidth(state.groups.get(gid).title, 12.5, 600) + 24, y0: y0 - FRAME_TITLE, y1: y0 });
    if (deviceOf(gid)) taken.push({ x0, x1: x0 + b.w, y0, y1: y0 + b.h });
  }
  const hits = r => taken.some(t => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
  state.edges.forEach((e, i) => {
    const a = anchorBox(e.from), b = anchorBox(e.to);
    if (!a || !b) return;
    const { d, at } = edgeGeometry(e, a, b);
    const on = isSel(`e:${i}`);
    const marker = e.arrow ? ` marker-end="url(#${on ? 'arrow-sel' : arrowFor(e.color)})"` : '';
    let label = '';
    if (e.label) {
      const text = e.label.replace(/\n/g, ' ');
      const lw = textWidth(text, 12, 400) + 10, lh = 20;
      const rectAt = p => ({ x0: p.x - lw / 2, x1: p.x + lw / 2, y0: p.y - lh / 2, y1: p.y + lh / 2 });
      let p = at(0.5);
      for (const u of [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8]) { const q = at(u); if (!hits(rectAt(q))) { p = q; break; } }
      taken.push(rectAt(p));
      label = `<rect class="label-bg" x="${p.x - lw / 2}" y="${p.y - lh / 2}" width="${lw}" height="${lh}" rx="4"/>` +
        `<text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`;
    }
    html += `<g class="edge ${e.style}${on ? ' sel' : ''}" data-edge="${i}"${e.color ? ` style="--ec:${esc(e.color)}"` : ''}><path class="hit" d="${d}"/><path class="line" d="${d}"${marker}/>${label}</g>`;
  });
  html += state.ink.filter(k => k.kind === 'hl').map(inkSvg).join('');
  for (const [id, b] of boxes) {
    const n = state.nodes.get(id);
    const kind = isUi(n) ? 'ui' : ['sticky', 'text', 'icon', 'table', 'doc', 'phone', 'browser', 'image'].includes(n.shape) ? n.shape : '';
    const cls = ['node', kind, n.marked && 'marked', isSel(`n:${id}`) && 'sel', flash.has(id) && `flash-${flash.get(id)}`].filter(Boolean).join(' ');
    const a = (!kind || kind === 'table' || kind === 'doc') && accentOf(n.group);
    html += `<g class="${cls}" data-node="${esc(id)}" transform="translate(${b.x},${b.y})"${colorVars(n, a && { stroke: a })}>${nodeInner(n, b)}</g>`;
  }
  html += state.ink.filter(k => k.kind !== 'hl').map(inkSvg).join('');
  if (drag?.kind === 'ink') html += inkSvg(drag.ink);
  html += state.comments.map(commentSvg).join('');
  html += handlesSvg();
  if (drag?.kind === 'marquee') {
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    html += `<rect class="marquee" x="${x}" y="${y}" width="${Math.abs(drag.x1 - drag.x0)}" height="${Math.abs(drag.y1 - drag.y0)}"/>`;
  }
  if (drag?.kind === 'connect' && drag.to) {
    const a = boxes.get(drag.from), s = sideOf(a, drag.to);
    html += `<path class="ghost" d="M${s.x},${s.y} L${drag.to.x},${drag.to.y}"/>`;
  }
  vp.innerHTML = html;
  updateEmpty();
  renderCtx();
  renderMinimap();
}

// Arrow heads in a line's own colour: one marker per colour, made when first needed.
function arrowFor(color) {
  if (!color) return 'arrow';
  const id = `arrow-${color.replace(/[^\w]/g, '')}`;
  const defs = $('#board defs');
  if (!defs.querySelector(`#${id}`)) defs.insertAdjacentHTML('beforeend', `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:${esc(color)}"/></marker>`);
  return id;
}

// Pen and highlighter strokes as smooth paths, arrows as straight lines with a head.
function inkPath(pts) {
  if (pts.length < 3) return `M${pts.map(q => q.join(',')).join(' L')}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) d += ` Q${pts[i][0]},${pts[i][1]} ${(pts[i][0] + pts[i + 1][0]) / 2},${(pts[i][1] + pts[i + 1][1]) / 2}`;
  const l = pts[pts.length - 1];
  return `${d} L${l[0]},${l[1]}`;
}
function inkSvg(k) {
  const d = inkPath(k.pts), on = k.id && isSel(`i:${k.id}`);
  const marker = k.kind === 'arrow' ? ` marker-end="url(#${arrowFor(k.color)})"` : '';
  return `<g class="ink ${k.kind}${on ? ' sel' : ''}"${k.id ? ` data-ink="${esc(k.id)}"` : ''} style="--ic:${esc(k.color)}"><path class="hit" d="${d}"/><path class="stroke" d="${d}"${marker}/></g>`;
}
// A comment is a numbered pin; its text shows on hover and while it is selected.
function commentSvg(c, i) {
  const lines = wrapLabel(c.text || '…', 220, 12, 400), w = Math.max(...lines.map(l => textWidth(l, 12, 400))) + 20, h = lines.length * 16 + 12;
  return `<g class="comment${isSel(`c:${c.id}`) ? ' sel' : ''}" data-comment="${esc(c.id)}" transform="translate(${c.x},${c.y})">` +
    `<circle class="pin" r="12"/><text class="pin-n" text-anchor="middle" dominant-baseline="central">${i + 1}</text>` +
    `<g class="ctext"><rect x="18" y="-14" width="${w}" height="${h}" rx="8"/><text>${lines.map((l, j) => `<tspan x="28" y="${-14 + 15 + j * 16}" dominant-baseline="central">${esc(l)}</tspan>`).join('')}</text></g></g>`;
}

// The selected box gets four dots to drag a line from and a corner to resize it; a frame gets the corner.
function handlesSvg() {
  if (!sel || sel.type === 'edge' || drag?.moved) return '';
  const k = view.k, r = 5.5 / k, off = 14 / k, hs = 9 / k;
  // Several items, ink or a comment: a dashed outline around them.
  if (sel.type === 'multi' || sel.type === 'ink' || sel.type === 'comment') {
    const b = keysBox(selKeys()); if (!b) return '';
    const m = 6 / k;
    return `<rect class="sel-box" x="${b.x - b.w / 2 - m}" y="${b.y - b.h / 2 - m}" width="${b.w + 2 * m}" height="${b.h + 2 * m}" rx="${4 / k}"/>`;
  }
  const b = sel.type === 'node' ? boxes.get(sel.id) : groupBoxes.get(sel.id);
  if (!b) return '';
  let out = '';
  if (sel.type === 'node' && !markMode) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      out += `<circle class="port" data-port="${esc(sel.id)}" cx="${b.x + dx * (b.w / 2 + off)}" cy="${b.y + dy * (b.h / 2 + off)}" r="${r}"/>`;
  }
  const inScreen = sel.type === 'node' && deviceOf(state.nodes.get(sel.id)?.group);
  if (!(sel.type === 'node' && state.nodes.get(sel.id)?.shape === 'icon') && !inScreen)
    out += `<rect class="handle" data-resize="${sel.type}:${esc(sel.id)}" x="${b.x + b.w / 2 - hs / 2}" y="${b.y + b.h / 2 - hs / 2}" width="${hs}" height="${hs}" rx="${2 / k}"/>`;
  return out;
}

// Everything drawn on the board, as boxes: for fitting the view, the minimap and exports.
function contentBoxes() { return [...boxes.values(), ...groupBoxes.values(), ...state.ink.map(inkBox), ...state.comments.map(commentBox)]; }

function fit() {
  const all = contentBoxes();
  const svg = $('#board'), W = svg.clientWidth, H = svg.clientHeight;
  if (!all.length) { view = { x: W / 2, y: H / 2, k: 1 }; render(); return; }
  const x0 = Math.min(...all.map(b => b.x - b.w / 2)), x1 = Math.max(...all.map(b => b.x + b.w / 2));
  const y0 = Math.min(...all.map(b => b.y - b.h / 2)), y1 = Math.max(...all.map(b => b.y + b.h / 2));
  // Leave room for the rail on the left, the bar on top and the request box at the bottom.
  const L = 64, R = 20, T = $('#note').hidden ? 64 : 112, B = 76;
  const k = Math.min(1.4, (W - L - R) / (x1 - x0 || 1), (H - T - B) / (y1 - y0 || 1));
  view = { k, x: L + (W - L - R) / 2 - (x0 + x1) / 2 * k, y: T + (H - T - B) / 2 - (y0 + y1) / 2 * k };
  render();
}

// ---------- changes ----------

const snapshot = () => JSON.stringify({ src: shareText(), pos: [...state.pos] });
const redoStack = [];
function pushUndo(snap = snapshot()) {
  if (undoStack[undoStack.length - 1] !== snap) undoStack.push(snap);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
function restore(snap) {
  const { src, pos } = JSON.parse(snap);
  parseInto(src, { replace: true, keep: false });
  state.pos = new Map(pos);
  sel = null;
}
function undo() {
  const snap = undoStack.pop();
  if (!snap) { toast('Nothing to undo'); return; }
  redoStack.push(snapshot());
  restore(snap);
  commit('undo', 'Undid the last change');
}
function redo() {
  const snap = redoStack.pop();
  if (!snap) { toast('Nothing to redo'); return; }
  undoStack.push(snapshot());
  restore(snap);
  commit('undo', 'Redid the change');
}

// Every change ends here: relayout, redraw, sync the source box, save, describe, log.
function commit(channel, message, { fromSource = false } = {}) {
  layout();
  render();
  if (!fromSource) $('#source').value = toMermaid();
  save();
  updateReadout();
  if (typeof updateBackButton === 'function') updateBackButton();
  if (message) log(channel, message);
}

function itemFingerprint(n) { return `${n.label}|${n.shape}|${n.group}|${n.marked}|${JSON.stringify(colorsOf(n))}`; }

function applyText(text, channel) {
  let src = String(text || '');
  const fence = src.match(/```(?:mermaid)?[^\n]*\n([\s\S]*?)```/);
  if (fence) src = fence[1];
  src = src.trim().replace(/^---\s*[\n;][\s\S]*?[\n;]\s*---\s*[\n;]/, '').trim();
  if (!src) return { ok: false, message: 'Empty text' };
  const replace = /^(flowchart|graph)\b/i.test(src);
  const before = new Map([...state.nodes].map(([id, n]) => [id, itemFingerprint(n)]));
  const edgesBefore = state.edges.length;
  const hadNothing = state.nodes.size === 0;
  pushUndo();
  // Boxes the user moved by hand keep their place while they are still in the diagram.
  const { warnings } = parseInto(src, { replace });
  let added = 0, changed = 0;
  flash = new Map();
  for (const [id, n] of state.nodes) {
    if (!before.has(id)) { added++; flash.set(id, 'add'); }
    else if (before.get(id) !== itemFingerprint(n)) { changed++; flash.set(id, 'change'); }
  }
  const removed = [...before.keys()].filter(id => !state.nodes.has(id)).length;
  const parts = [`${added} added`, changed && `${changed} changed`, removed && `${removed} removed`, `${state.edges.length} links`].filter(Boolean);
  const message = `${replace ? 'Replaced diagram' : 'Merged lines'}: ${parts.join(', ')}` + (warnings.length ? ` · ${warnings.length} lines skipped` : '');
  commit(channel, message);
  warnings.forEach(w => log('error', w));
  if (replace || hadNothing) fit();
  setTimeout(() => { flash = new Map(); render(); }, 1700);
  return { ok: true, message, warnings, nodes: state.nodes.size, edges: state.edges.length, edgesBefore };
}

// ---------- boards ----------

// Every board is saved in this browser: a list (id, name, when it changed, how big) and one entry per board.
// The board open last is the one a new tab, or a link from the chat, lands on.
const BOARDS_KEY = 'kiertotie.boards', CURRENT_KEY = 'kiertotie.current';
const boardKey = id => `kiertotie.board.${id}`;
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
function boardList() { try { return JSON.parse(store.get(BOARDS_KEY)) || []; } catch { return []; } }
function saveBoardList(list) { store.set(BOARDS_KEY, JSON.stringify(list)); }
const newBoardId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

let boardId = null;
function currentBoard() { return boardList().find(b => b.id === boardId) || { id: boardId, name: 'Untitled board' }; }

// The first run with boards: the single board saved before becomes the first board on the list.
function initBoards() {
  let list = boardList();
  if (!list.length) {
    const id = newBoardId(), old = store.get(STORE_KEY);
    if (old) store.set(boardKey(id), old);
    list = [{ id, name: 'My board', updated: Date.now() }];
    saveBoardList(list);
    store.del(STORE_KEY);
  }
  const cur = store.get(CURRENT_KEY);
  boardId = list.some(b => b.id === cur) ? cur : [...list].sort((a, b) => b.updated - a.updated)[0].id;
  store.set(CURRENT_KEY, boardId);
}

function save() {
  lastSaved = JSON.stringify({ src: shareText(), pos: [...state.pos] });
  store.set(boardKey(boardId), lastSaved);
  const list = boardList(), b = list.find(x => x.id === boardId);
  const info = { updated: Date.now(), boxes: state.nodes.size };
  if (b) Object.assign(b, info); else list.push({ id: boardId, name: 'Untitled board', ...info });
  saveBoardList(list);
  paintBoardName();
}
function load() {
  try {
    const raw = store.get(boardKey(boardId));
    if (!raw) return false;
    lastSaved = raw;
    const { src, pos } = JSON.parse(raw);
    parseInto(src, { replace: true, keep: false });
    state.pos = new Map(pos || []);
    return state.nodes.size > 0;
  } catch { return false; }
}

// Open another board: this one is already saved, so only the view and the undo history start afresh.
function openBoard(id) {
  boardId = id;
  store.set(CURRENT_KEY, id);
  parseInto('flowchart LR', { replace: true, keep: false }); state.pos.clear();
  load();
  undoStack.length = 0; sel = null; started = false; showNote('');
  layout(); render(); $('#source').value = toMermaid(); updateReadout(); paintBoardName();
  fit(); updateEmpty();
}
function createBoard(name = 'Untitled board', text = null) {
  const id = newBoardId();
  saveBoardList([...boardList(), { id, name, updated: Date.now(), boxes: 0 }]);
  openBoard(id);
  if (text) { applyText(text, 'template'); undoStack.length = 0; }
  return id;
}
function renameBoard(id, name) {
  const list = boardList(), b = list.find(x => x.id === id);
  if (!b || !name.trim()) return;
  b.name = name.trim(); saveBoardList(list); paintBoardName();
}
function deleteBoard(id) {
  saveBoardList(boardList().filter(b => b.id !== id));
  store.del(boardKey(id));
  if (id !== boardId) return;
  const rest = boardList().sort((a, b) => b.updated - a.updated);
  if (rest.length) openBoard(rest[0].id); else createBoard('My board');
}
function duplicateBoard(id) {
  const b = boardList().find(x => x.id === id); if (!b) return;
  const nid = newBoardId(), raw = store.get(boardKey(id));
  if (raw) store.set(boardKey(nid), raw);
  saveBoardList([...boardList(), { ...b, id: nid, name: `${b.name} (copy)`, updated: Date.now() }]);
  openBoard(nid);
}

function paintBoardName() {
  const el = $('#board-name'); if (!el) return;
  el.textContent = currentBoard().name;
  document.title = `${currentBoard().name} · Kiertotie`;
}

const ago = t => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};
function paintBoards() {
  const list = boardList().sort((a, b) => b.updated - a.updated);
  $('#boards-list').innerHTML = list.map(b => `<li class="board-row${b.id === boardId ? ' current' : ''}" data-board="${esc(b.id)}">
    <button class="board-open" data-bact="open"><strong>${esc(b.name)}</strong><span class="muted small">${b.id === boardId ? 'Open now · ' : ''}${b.boxes != null ? `${b.boxes} boxes · ` : ''}${ago(b.updated)}</span></button>
    <button data-bact="rename" title="Rename">Rename</button><button data-bact="copy" title="Duplicate">Duplicate</button><button data-bact="delete" title="Delete">Delete</button></li>`).join('');
}
function openBoards() { paintBoards(); $('#boards').showModal(); }

function boardsClick(e) {
  const b = e.target.closest('[data-bact]'); if (!b) return;
  const id = b.closest('[data-board]').dataset.board, act = b.dataset.bact;
  const w = pipWin || window, name = boardList().find(x => x.id === id)?.name || '';
  if (act === 'open') { $('#boards').close(); if (id !== boardId) { openBoard(id); toast(`Opened ${name}`); } return; }
  if (act === 'rename') { const n = w.prompt('Name this board', name); if (n) renameBoard(id, n); }
  if (act === 'copy') duplicateBoard(id);
  if (act === 'delete' && w.confirm(`Delete "${name}"? This can't be undone.`)) deleteBoard(id);
  paintBoards();
}

function markedItems() {
  return [...state.nodes.values(), ...state.groups.values()].filter(x => x.marked);
}

function updateReadout() {
  const names = new Map([...state.nodes.values()].map(n => [n.id, n.label.replace(/\n/g, ' ')]));
  for (const g of state.groups.values()) names.set(g.id, g.title);
  const dirWords = { LR: 'left to right', RL: 'right to left', TD: 'top to bottom', BT: 'bottom to top' };
  const marked = markedItems();
  const lines = [
    `Kiertotie diagram, laid out ${dirWords[state.dir]}: ${state.nodes.size} boxes, ${state.groups.size} groups, ${state.edges.length} links.`,
    marked.length ? `Highlighted by the user: ${marked.map(x => `${names.get(x.id)} (${x.id})`).join(', ')}.` : 'Nothing is highlighted.',
    ...[...state.groups.values()].map(g => `Group ${g.title} (${g.id})${g.parent ? ` inside ${names.get(g.parent)}` : ''}.`),
    ...[...state.nodes.values()].map(n => `Box ${names.get(n.id)} (${n.id}, ${n.shape === 'icon' ? `icon ${n.icon}` : n.shape})${n.group ? ` in ${names.get(n.group)}` : ''}.`),
    ...state.edges.map(e => `Link ${names.get(e.from) || e.from} → ${names.get(e.to) || e.to}${e.label ? `: ${e.label}` : ''}.`),
    'Mermaid source:', toMermaid(),
    '', 'Instructions for an assistant reading this page:', starterText(),
  ];
  $('#readout').textContent = lines.join('\n');
}

// ---------- interaction ----------

const svg = $('#board');
let drag = null;

function toWorld(e) {
  const r = svg.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
}
function select(s) { sel = s; render(); }

function toggleMark(item, kind) {
  pushUndo();
  item.marked = !item.marked;
  commit('board', `${item.marked ? 'Highlighted' : 'Unhighlighted'} ${kind} ${item.id}`);
}

function descendantsOf(gid) {
  const groups = new Set([gid]);
  let grew = true;
  while (grew) { grew = false; for (const g of state.groups.values()) if (g.parent && groups.has(g.parent) && !groups.has(g.id)) { groups.add(g.id); grew = true; } }
  return [...state.nodes.values()].filter(n => groups.has(n.group)).map(n => n.id);
}

// Clicks redraw the board, so the browser's dblclick never sees the same element twice; detect it here.
let lastDown = { t: 0, key: '', x: 0, y: 0 };

function descendantGroups(gid) {
  const out = [gid];
  for (let i = 0; i < out.length; i++) for (const g of state.groups.values()) if (g.parent === out[i] && !out.includes(g.id)) out.push(g.id);
  return out;
}

// ---------- selection ----------

// sel is one item ({type: 'node'|'group'|'ink'|'comment', id} or {type: 'edge', i}) or several ({type: 'multi', keys}).
// A key names one item: n:id, g:id, e:index, i:id (ink), c:id (comment).
const keyOf = s => !s ? null : s.type === 'edge' ? `e:${s.i}` : `${{ node: 'n', group: 'g', ink: 'i', comment: 'c' }[s.type]}:${s.id}`;
function selKeys() { return !sel ? new Set() : sel.type === 'multi' ? sel.keys : new Set([keyOf(sel)]); }
const isSel = k => selKeys().has(k);
const splitKey = k => { const at = k.indexOf(':'); return [k.slice(0, at), k.slice(at + 1)]; };
function fromKeys(keys) {
  keys = new Set([...keys].filter(Boolean));
  if (keys.size > 1) return { type: 'multi', keys };
  if (!keys.size) return null;
  const [t, id] = splitKey([...keys][0]);
  return t === 'e' ? { type: 'edge', i: +id } : { type: { n: 'node', g: 'group', i: 'ink', c: 'comment' }[t], id };
}
const keyAt = target => {
  const el = target.closest?.('[data-node],[data-ink],[data-comment],[data-edge],[data-group]');
  if (!el) return null;
  const d = el.dataset;
  return d.node != null ? `n:${d.node}` : d.ink != null ? `i:${d.ink}` : d.comment != null ? `c:${d.comment}` : d.edge != null ? `e:${d.edge}` : `g:${d.group}`;
};

// What the selection covers: boxes (with everything inside selected frames), frames, ink and comments.
function selectionItems(keys = selKeys()) {
  const nodes = new Set(), groups = new Set(), ink = new Set(), comments = new Set();
  for (const k of keys) {
    const [t, id] = splitKey(k);
    if (t === 'n' && state.nodes.has(id)) nodes.add(id);
    if (t === 'g' && state.groups.has(id)) { for (const g of descendantGroups(id)) groups.add(g); for (const n of descendantsOf(id)) nodes.add(n); }
    if (t === 'i') ink.add(id);
    if (t === 'c') comments.add(id);
  }
  return { nodes, groups, ink, comments };
}

const inkBox = k => { const xs = k.pts.map(q => q[0]), ys = k.pts.map(q => q[1]); const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0 + 4, h: y1 - y0 + 4 }; };
const commentBox = c => ({ x: c.x, y: c.y, w: 24, h: 24 });
// The bounding box of some keys, in board coordinates.
function keysBox(keys) {
  const rs = [];
  for (const k of keys) {
    const [t, id] = splitKey(k);
    const b = t === 'n' ? boxes.get(id) : t === 'g' ? groupBoxes.get(id) : t === 'i' ? (state.ink.find(x => x.id === id) && inkBox(state.ink.find(x => x.id === id)))
      : t === 'c' ? (state.comments.find(x => x.id === id) && commentBox(state.comments.find(x => x.id === id))) : null;
    if (b) rs.push(b);
  }
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map(b => b.x - b.w / 2)), x1 = Math.max(...rs.map(b => b.x + b.w / 2));
  const y0 = Math.min(...rs.map(b => b.y - b.h / 2)), y1 = Math.max(...rs.map(b => b.y + b.h / 2));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

// Everything a drag-select rectangle touches; a frame only when the rectangle holds all of it.
function keysInRect(r) {
  const out = [], hit = b => b.x - b.w / 2 < r.x1 && b.x + b.w / 2 > r.x0 && b.y - b.h / 2 < r.y1 && b.y + b.h / 2 > r.y0;
  for (const [id, b] of boxes) if (hit(b)) out.push(`n:${id}`);
  for (const [id, b] of groupBoxes) if (b.x - b.w / 2 >= r.x0 && b.x + b.w / 2 <= r.x1 && b.y - b.h / 2 >= r.y0 && b.y + b.h / 2 <= r.y1) out.push(`g:${id}`);
  for (const k of state.ink) if (hit(inkBox(k))) out.push(`i:${k.id}`);
  for (const c of state.comments) if (hit(commentBox(c))) out.push(`c:${c.id}`);
  return out;
}

// Snap: a dragged selection's top-left corner lands on a 10-point grid. Alt drags freely.
const SNAP_KEY = 'kiertotie.snap';
let snapOn = store.get(SNAP_KEY) !== 'off';
const GRID = 10;

let spaceDown = false;
function startMove(p, single) {
  const it = selectionItems();
  // A screen moves as one: its pieces follow it through the layout instead of being moved one by one.
  for (const g of it.groups) if (deviceOf(g) && state.pos.get(g)?.x == null) { const gb = groupBoxes.get(g); state.pos.set(g, { ...state.pos.get(g), x: gb.x, y: gb.y }); }
  const ids = [...it.nodes].filter(id => !(it.groups.has(state.nodes.get(id).group) && deviceOf(state.nodes.get(id).group)) || state.pos.has(id));
  const rects = [...it.groups].filter(g => state.pos.get(g)?.w || deviceOf(g)).map(g => ({ id: g, p: state.pos.get(g) }));
  const inks = state.ink.filter(k => it.ink.has(k.id)).map(k => ({ k, pts: k.pts.map(q => [...q]) }));
  const notes = state.comments.filter(c => it.comments.has(c.id)).map(c => ({ c, x: c.x, y: c.y }));
  const b0 = keysBox(selKeys());
  return { kind: 'move', ids, start: ids.map(n => ({ x: boxes.get(n).x, y: boxes.get(n).y })), rects, inks, notes, p0: p, snap: snapshot(), moved: false,
    tl: b0 && { x: b0.x - b0.w / 2, y: b0.y - b0.h / 2 }, single, groupBox0: single && groupBoxes.get(state.nodes.get(single).group), group: sel?.type === 'group' ? sel.id : null };
}

svg.addEventListener('pointerdown', e => {
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault(); drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(e.pointerId); return;
  }
  if (e.button !== 0) return;
  closeEditor(true);
  const p = toWorld(e);
  const portEl = e.target.closest('[data-port]'), sizeEl = e.target.closest('[data-resize]');
  if (portEl) { drag = { kind: 'connect', from: portEl.dataset.port, to: p }; svg.setPointerCapture(e.pointerId); return; }
  if (sizeEl) {
    const [type, ...rest] = sizeEl.dataset.resize.split(':'), id = rest.join(':');
    const b = type === 'node' ? boxes.get(id) : groupBoxes.get(id);
    drag = { kind: 'resize', type, id, x0: b.x - b.w / 2, y0: b.y - b.h / 2, snap: snapshot(), moved: false, ratio: type === 'node' && state.nodes.get(id)?.shape === 'image' ? b.w / b.h : null };
    svg.setPointerCapture(e.pointerId); return;
  }
  if (!markMode && (tool === 'pen' || tool === 'hl' || tool === 'arrow')) {
    drag = { kind: 'ink', snap: snapshot(), ink: { id: null, kind: tool, color: tool === 'hl' ? hlColor : penColor, pts: [[p.x, p.y], [p.x, p.y]] } };
    svg.setPointerCapture(e.pointerId); return;
  }
  if (!markMode && tool === 'eraser') { drag = { kind: 'erase', snap: snapshot(), hit: false }; eraseAt(e); svg.setPointerCapture(e.pointerId); return; }
  if (!markMode && tool === 'comment') { e.preventDefault(); placeComment(p); return; }
  if (tool !== 'select' && !markMode) { e.preventDefault(); placeItem(tool, p); return; }
  let key = keyAt(e.target) || 'empty';
  // A frame is picked up by its title bar; its inside behaves like the empty board, as in Miro.
  if (key.startsWith('g:') && !isSel(key)) { const gb = groupBoxes.get(splitKey(key)[1]); if (gb && p.y > gb.y - gb.h / 2 && !deviceOf(splitKey(key)[1])) key = 'empty'; }
  const now = performance.now();
  const isDouble = now - lastDown.t < 400 && key === lastDown.key && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
  lastDown = isDouble ? { t: 0, key: '' } : { t: now, key, x: e.clientX, y: e.clientY };
  if (isDouble && !markMode) { e.preventDefault(); doubleClick(key, p); return; }
  const [t, id] = key === 'empty' ? ['', ''] : splitKey(key);
  if (markMode && (t === 'n' || t === 'g')) { toggleMark(t === 'n' ? state.nodes.get(id) : state.groups.get(id), t === 'n' ? 'box' : 'group'); return; }
  if (key === 'empty') {
    // Drag on empty board: select what the rectangle touches. Space-drag, the middle button or two fingers pan.
    const base = e.shiftKey ? new Set([...selKeys()].filter(k => !k.startsWith('e:'))) : new Set();
    sel = fromKeys(base); render();
    drag = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, base };
  } else if (t === 'e') {
    select({ type: 'edge', i: +id });
  } else {
    if (e.shiftKey) {
      const keys = new Set([...selKeys()].filter(k => !k.startsWith('e:')));
      if (keys.has(key)) keys.delete(key); else keys.add(key);
      select(fromKeys(keys)); return;
    }
    if (!isSel(key)) sel = fromKeys([key]);
    render();
    drag = startMove(p, t === 'n' && selKeys().size === 1 ? id : null);
  }
  svg.setPointerCapture(e.pointerId);
});

// A piece dropped on a screen goes into its stack, above the first piece below where it was dropped.
function stackInto(n, gid, y) {
  const was = n.group;
  const sibs = [...state.nodes.values()].filter(x => x.group === gid && x !== n).sort((a, b) => boxes.get(a.id).y - boxes.get(b.id).y);
  const before = sibs.find(x => boxes.get(x.id).y > y);
  n.group = gid; state.pos.delete(n.id);
  // The stack follows the order of the boxes, so move this one in front of the piece it goes above.
  const entries = [...state.nodes].filter(([id]) => id !== n.id);
  const at = before ? entries.findIndex(([id]) => id === before.id) : entries.length;
  entries.splice(at < 0 ? entries.length : at, 0, [n.id, n]);
  state.nodes = new Map(entries);
  commit('board', was === gid ? `Moved ${n.id} in ${state.groups.get(gid).title}` : `Put ${n.id} on ${state.groups.get(gid).title}`);
}

// New screens: a device with a starting set of pieces.
const SCREEN_PRESETS = {
  blank: { name: 'Blank', pieces: () => [['uiTopbar', 'Title']] },
  login: { name: 'Login', pieces: () => [['uiImage', ''], ['uiHeading', 'Sign in'], ['uiInput', 'Email'], ['uiInput', 'Password'], ['uiButton', 'Sign in'], ['uiLink', 'Forgot password?']] },
  main: { name: 'Main page', pieces: dev => dev === 'desktop'
    ? [['uiTopbar', 'Home'], ['uiSidebar', 'Home\nSearch\nSaved\nSettings'], ['uiHeading', 'Welcome back'], ['uiInput', 'Search'], ['uiImage', ''], ['uiText', '']]
    : [['uiTopbar', 'Home'], ['uiHeading', 'Where to today?'], ['uiInput', 'Search'], ['uiImage', ''], ['uiText', ''], ['uiTabbar', 'Home\nSearch\nProfile']] },
};
const PIECE_IDS = { uiTopbar: 'bar', uiHeading: 'title', uiText: 'text', uiInput: 'field', uiButton: 'btn', uiLink: 'link', uiCheckbox: 'check', uiImage: 'img', uiList: 'list', uiTable: 'grid', uiTabbar: 'tabs', uiSidebar: 'menu' };
let screenPreset = 'main';
function placeScreen(dev, p = viewCentre()) {
  setTool('select');
  pushUndo(); pinAll();
  const P = SCREEN_PRESETS[screenPreset];
  const gid = freeId('screen');
  state.groups.set(gid, { id: gid, title: screenPreset === 'blank' ? 'Screen' : P.name, parent: null, marked: false, dev });
  state.pos.set(gid, { x: p.x, y: p.y });
  for (const [kind, label] of P.pieces(dev)) { const id = freeId(PIECE_IDS[kind]); state.nodes.set(id, { id, label, shape: kind, group: gid, marked: false }); }
  sel = { type: 'group', id: gid };
  commit('board', `Added a ${DEVICES[dev].name.toLowerCase()} screen`);
}
// A new piece goes at the bottom of the selected screen, or of the screen in the middle of the view.
function addPiece(kind) {
  closePops();
  const c = viewCentre();
  const gid = sel?.type === 'group' && deviceOf(sel.id) ? sel.id : sel?.type === 'node' && deviceOf(state.nodes.get(sel.id)?.group) ? state.nodes.get(sel.id).group
    : [...groupBoxes].find(([g, b]) => deviceOf(g) && Math.abs(c.x - b.x) < b.w / 2 && Math.abs(c.y - b.y) < b.h / 2)?.[0];
  pushUndo();
  const id = freeId(PIECE_IDS[kind]);
  state.nodes.set(id, { id, label: UI_KINDS[kind].def, shape: kind, group: gid || null, marked: false });
  if (!gid) { pinAll(); state.pos.set(id, { x: c.x, y: c.y, w: 200, h: UI_KINDS[kind].h || 40 }); }
  sel = { type: 'node', id };
  commit('board', `Added ${UI_KINDS[kind].name.toLowerCase()}${gid ? ` to ${state.groups.get(gid).title}` : ''}`);
}

function eraseAt(e) {
  const k = keyAt(doc().elementFromPoint(e.clientX, e.clientY) || svg);
  if (!k || !k.startsWith('i:')) return;
  const id = splitKey(k)[1];
  if (!drag.hit) { pushUndo(drag.snap); drag.hit = true; }
  state.ink = state.ink.filter(x => x.id !== id);
  render();
}

svg.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.kind === 'pan') { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; render(); return; }
  const p = toWorld(e);
  if (drag.kind === 'connect') { drag.to = p; render(); return; }
  if (drag.kind === 'erase') { eraseAt(e); return; }
  if (drag.kind === 'ink') {
    const pts = drag.ink.pts, last = pts[pts.length - 1];
    if (drag.ink.kind === 'arrow') pts[1] = [p.x, p.y];
    else if (Math.hypot(p.x - last[0], p.y - last[1]) * view.k > 2) pts.push([p.x, p.y]);
    render(); return;
  }
  if (drag.kind === 'marquee') {
    Object.assign(drag, { x1: p.x, y1: p.y });
    const r = { x0: Math.min(drag.x0, p.x), x1: Math.max(drag.x0, p.x), y0: Math.min(drag.y0, p.y), y1: Math.max(drag.y0, p.y) };
    sel = fromKeys([...drag.base, ...((r.x1 - r.x0) * view.k > 3 || (r.y1 - r.y0) * view.k > 3 ? keysInRect(r) : [])]);
    render(); return;
  }
  if (drag.kind === 'resize') {
    drag.moved = true;
    const min = drag.type === 'node' ? [40, 28] : [120, 80];
    let w = Math.max(min[0], p.x - drag.x0), h = Math.max(min[1], p.y - drag.y0);
    if (snapOn && !e.altKey) { w = Math.max(min[0], Math.round(w / GRID) * GRID); h = Math.max(min[1], Math.round(h / GRID) * GRID); }
    if (drag.ratio) h = w / drag.ratio;
    state.pos.set(drag.id, { x: drag.x0 + w / 2, y: drag.y0 + h / 2, w, h });
    layout(); render(); return;
  }
  let dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
  if (!drag.moved && Math.hypot(dx, dy) * view.k < 3) return;
  drag.moved = true;
  if (snapOn && !e.altKey && drag.tl) {
    dx = Math.round((drag.tl.x + dx) / GRID) * GRID - drag.tl.x;
    dy = Math.round((drag.tl.y + dy) / GRID) * GRID - drag.tl.y;
  }
  drag.ids.forEach((id, i) => {
    const pos = { x: drag.start[i].x + dx, y: drag.start[i].y + dy };
    state.pos.set(id, { ...state.pos.get(id), ...pos });
    Object.assign(boxes.get(id), pos);
  });
  for (const r of drag.rects) state.pos.set(r.id, { ...r.p, x: r.p.x + dx, y: r.p.y + dy });
  if (drag.rects.some(r => deviceOf(r.id))) layout();
  for (const { k, pts } of drag.inks) k.pts = pts.map(([x, y]) => [x + dx, y + dy]);
  for (const n of drag.notes) { n.c.x = n.x + dx; n.c.y = n.y + dy; }
  if (!drag.single) computeGroupBoxes();
  else {
    // The frame stays put under a box being dragged, so you can see where it will land.
    const g = state.nodes.get(drag.single).group;
    groupBoxes = groupBoxesFor(new Set(drag.ids));
    if (g && !groupBoxes.has(g) && drag.groupBox0) groupBoxes.set(g, drag.groupBox0);
  }
  render();
});

svg.addEventListener('pointerup', e => {
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.kind === 'marquee') { render(); return; }
  if (d.kind === 'erase') { if (d.hit) commit('board', 'Erased ink'); return; }
  if (d.kind === 'ink') {
    const k = d.ink, b = inkBox(k);
    if (Math.max(b.w, b.h) * view.k < 6) { render(); return; }
    pushUndo(d.snap);
    k.id = freeInkId();
    state.ink.push(k);
    commit('board', k.kind === 'arrow' ? 'Drew an arrow' : k.kind === 'hl' ? 'Highlighted with the pen' : 'Drew with the pen');
    if (k.kind === 'arrow') { setTool('select'); select({ type: 'ink', id: k.id }); }
    return;
  }
  if (d.kind === 'connect') {
    const target = doc().elementFromPoint(e.clientX, e.clientY)?.closest('[data-node],[data-group]');
    const to = target?.dataset.node || target?.dataset.group;
    if (to && to !== d.from) {
      pushUndo(); pinAll();
      if (!state.edges.some(x => x.from === d.from && x.to === to)) state.edges.push({ from: d.from, to, label: '', style: 'solid', arrow: true });
      commit('board', `Linked ${d.from} → ${to}`);
    } else if (!to && d.to && Math.hypot(d.to.x - boxes.get(d.from).x, d.to.y - boxes.get(d.from).y) > 60) {
      // Dropped on empty board: a new box of the same kind, linked, ready to type in.
      const from = state.nodes.get(d.from);
      const shape = ['icon', 'text', 'image', 'table', 'doc', 'phone', 'browser'].includes(from.shape) ? 'box' : from.shape;
      const id = placeItem(shape === 'sticky' ? 'sticky' : 'shape', d.to, { shape, edit: false, quiet: true });
      state.edges.push({ from: d.from, to: id, label: '', style: 'solid', arrow: true });
      commit('board', `Added ${id}, linked from ${d.from}`);
      openEditor({ type: 'node', id });
    } else render();
  } else if (d.kind === 'resize') {
    if (d.moved) { pushUndo(d.snap); commit('board', `Resized ${d.id}`); }
  } else if (d.kind === 'move' && d.moved) {
    pushUndo(d.snap);
    // A single box dropped into or out of a frame joins that frame.
    if (d.single) {
      const n = state.nodes.get(d.single), b = boxes.get(n.id);
      const into = groupAt(b, new Set([n.id]));
      if (isUi(n) && deviceOf(into)) { stackInto(n, into, b.y); return; }
      if (into !== n.group) {
        const was = n.group;
        // A frame left empty stays where it was, as an empty frame.
        if (was && !state.pos.get(was)?.w && !groupBoxesFor(new Set([n.id])).has(was)) {
          const gb = d.groupBox0 || groupBoxes.get(was);
          if (gb) state.pos.set(was, { x: gb.x, y: gb.y, w: gb.w, h: gb.h });
        }
        n.group = into;
        commit('board', into ? `Moved ${n.id} into ${state.groups.get(into).title}` : `Moved ${n.id} out of ${state.groups.get(was).title}`);
        return;
      }
    }
    computeGroupBoxes(); render(); save(); updateReadout();
    log('board', `Moved ${selKeys().size > 1 ? `${selKeys().size} items` : d.group ? `group ${d.group}` : d.ids[0] || 'an item'}`);
  }
});

svg.addEventListener('wheel', e => {
  e.preventDefault();
  const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
  if (e.ctrlKey || e.metaKey || mouseWheel) {
    const r = svg.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    const k = Math.min(3, Math.max(0.2, view.k * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))));
    view.x = cx - (cx - view.x) * k / view.k; view.y = cy - (cy - view.y) * k / view.k; view.k = k;
  } else { view.x -= e.deltaX; view.y -= e.deltaY; }
  render();
}, { passive: false });

function doubleClick(key, p) {
  drag = null;
  const [kind, ...rest] = key.split(':'), ref = rest.join(':');
  if (kind === 'n') openEditor({ type: 'node', id: ref });
  else if (kind === 'e') openEditor({ type: 'edge', i: +ref });
  else if (kind === 'g') openEditor({ type: 'group', id: ref });
  else if (kind === 'c') openEditor({ type: 'comment', id: ref });
  else if (kind === 'i') select({ type: 'ink', id: ref });
  else placeItem('shape', p, { shape: 'box' });
}

// ---------- tools ----------

let tool = 'select', toolShape = 'box';
function setTool(t, shape) {
  tool = t; if (shape) toolShape = shape;
  for (const b of doc().querySelectorAll('#rail [data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  svg.classList.toggle('placing', t !== 'select');
  svg.dataset.tool = t;
  for (const b of doc().querySelectorAll('#rail [data-pop="draw"]')) b.setAttribute('aria-pressed', String(['pen', 'hl', 'arrow', 'eraser'].includes(t)));
  closePops();
}

function freeId(base, numbered = true) {
  if (!numbered && !state.nodes.has(base) && !state.groups.has(base)) return base;
  let k = 1;
  while (state.nodes.has(`${base}${k}`) || state.groups.has(`${base}${k}`)) k++;
  return `${base}${k}`;
}

// A new sticky note, text, shape, icon or frame at p, inside whatever frame is under it.
function placeItem(kind, p, { shape = toolShape, icon = null, edit = true, quiet = false } = {}) {
  setTool('select');
  pushUndo();
  pinAll();
  const into = groupAt(p);
  let id;
  if (kind === 'frame') {
    id = freeId('frame');
    state.groups.set(id, { id, title: 'Frame', parent: into, marked: false });
    state.pos.set(id, { x: p.x, y: p.y, w: 480, h: 320 });
    // Boxes already under the new frame go into it.
    for (const n of state.nodes.values()) {
      const b = boxes.get(n.id);
      if (b && (n.group || null) === into && Math.abs(b.x - p.x) < 240 && Math.abs(b.y - p.y) < 160) n.group = id;
    }
    sel = { type: 'group', id };
  } else {
    const ic = kind === 'icon' ? iconFor(icon) : null;
    const s = kind === 'icon' ? 'icon' : kind === 'sticky' ? 'sticky' : kind === 'text' ? 'text' : shape;
    const NEW = { sticky: ['note', ''], text: ['text', 'Text'], table: ['table', 'Table'], doc: ['doc', 'Untitled doc'], phone: ['phone', 'App screen'], browser: ['page', 'example.com'] };
    const [base, label0] = NEW[s] || ['n', 'New box'];
    id = ic ? freeId(ic.id.split('-').slice(0, 2).join('_'), false) : freeId(base);
    const label = ic ? ic.title : label0;
    state.nodes.set(id, { id, label, shape: s, icon: ic ? ic.key : null, group: into, marked: false, ...(s === 'table' ? { table: [['Name', 'Value'], ['', ''], ['', '']] } : {}) });
    state.pos.set(id, { x: p.x, y: p.y });
    sel = { type: 'node', id };
  }
  if (quiet) return id;
  commit('board', `Added ${id}`);
  if (edit && kind !== 'icon') openEditor(sel);
  return id;
}

// Drawing by hand keeps everything else where it is: the automatic layout would move boxes around.
// Pieces of a screen stay in their screen's stack; the screen itself is pinned.
function pinAll() {
  for (const [id, b] of boxes) if (!state.pos.has(id) && !deviceOf(state.nodes.get(id)?.group)) state.pos.set(id, { x: b.x, y: b.y });
  for (const [gid, b] of groupBoxes) if (deviceOf(gid) && state.pos.get(gid)?.x == null) state.pos.set(gid, { ...state.pos.get(gid), x: b.x, y: b.y });
}

// The middle of what the board shows, in board coordinates.
function viewCentre() {
  const r = svg.getBoundingClientRect();
  return { x: (r.width / 2 - view.x) / view.k, y: (r.height / 2 - view.y) / view.k };
}

let editor = null;
function openEditor(target) {
  closeEditor(true);
  let text, b;
  let multiline = false;
  if (target.type === 'node') {
    const n = state.nodes.get(target.id);
    text = n.label; b = boxes.get(target.id);
    if (n.shape === 'icon') b = { ...b, y: b.y + 22, h: Math.max(28, b.h - 44) };
    // A table is edited as lines of cells split by |, a doc as its title line and then its text.
    if (n.shape === 'table') { text = (n.table || [['']]).map(r => r.join(' | ')).join('\n'); multiline = true; b = { ...b, w: Math.max(b.w, 260), h: Math.max(b.h, 120) }; }
    if (n.shape === 'doc') { text = `${n.label}\n${n.body || ''}`; multiline = true; }
  }
  else if (target.type === 'comment') {
    const c = state.comments.find(x => x.id === target.id); if (!c) return;
    text = c.text; b = { x: c.x + 18 + 120, y: c.y + 20, w: 240, h: 70 };
  }
  else if (target.type === 'group') { text = state.groups.get(target.id).title; const g = groupBoxes.get(target.id), w = Math.max(160, Math.min(g.w, 320)); b = { x: g.x - g.w / 2 + w / 2, y: g.y - g.h / 2 - 12, w, h: 26 }; }
  else {
    const e = state.edges[target.i], a = anchorBox(e.from), c = anchorBox(e.to);
    text = e.label; b = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2, w: 160, h: 30 };
  }
  const ta = document.createElement('textarea');
  ta.className = `editor${multiline || target.type === 'comment' ? ' editor-left' : ''}`; ta.value = text;
  if (multiline) ta.title = 'Ctrl+Enter or click outside to finish';
  const w = Math.max(120, b.w * view.k), h = Math.max(32, b.h * view.k);
  Object.assign(ta.style, { left: `${view.x + b.x * view.k - w / 2}px`, top: `${view.y + b.y * view.k - h / 2}px`, width: `${w}px`, height: `${h}px` });
  $('.board-wrap').append(ta);
  ta.focus(); ta.select();
  editor = { ta, target };
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && (multiline ? ev.metaKey || ev.ctrlKey : !ev.shiftKey)) { ev.preventDefault(); closeEditor(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); closeEditor(false); }
  });
  ta.addEventListener('blur', () => closeEditor(true));
}
function closeEditor(keep) {
  if (!editor) return;
  const { ta, target } = editor;
  editor = null;
  const value = ta.value.trim();
  ta.remove();
  if (!keep) return;
  if (target.type === 'comment') {
    const c = state.comments.find(x => x.id === target.id); if (!c || c.text === value) return;
    pushUndo();
    if (!value) { state.comments = state.comments.filter(x => x !== c); sel = null; commit('board', 'Removed a comment'); return; }
    c.text = value; commit('board', 'Edited a comment'); return;
  }
  const item = target.type === 'node' ? state.nodes.get(target.id) : target.type === 'group' ? state.groups.get(target.id) : state.edges[target.i];
  if (!item) return;
  if (item.shape === 'table') {
    const rows = ta.value.split('\n').filter(l => l.trim()).map(l => l.split('|').map(c => c.trim()));
    const cols = Math.max(1, ...rows.map(r => r.length));
    const table = (rows.length ? rows : [['']]).map(r => [...r, ...Array(cols - r.length).fill('')]);
    if (JSON.stringify(table) === JSON.stringify(item.table)) return;
    pushUndo(); item.table = table; commit('board', `Edited table ${item.id}`); return;
  }
  if (item.shape === 'doc') {
    const [first, ...rest] = ta.value.split('\n'), label = first.trim() || 'Doc', body = rest.join('\n').trim();
    if (label === item.label && body === (item.body || '')) return;
    pushUndo(); item.label = label; item.body = body; commit('board', `Edited doc ${item.id}`); return;
  }
  const field = target.type === 'node' ? 'label' : target.type === 'group' ? 'title' : 'label';
  if (item[field] === value || (!value && field !== 'label')) return;
  pushUndo();
  // An emptied text is gone; a sticky note may stay blank.
  if (!value && item.shape === 'text') { removeItem(item.id); sel = null; commit('board', `Removed ${item.id}`); return; }
  item[field] = value || (target.type === 'node' && item.shape !== 'sticky' ? item.id : '');
  commit('board', `Edited ${target.type === 'edge' ? `link ${item.from} → ${item.to}` : target.id}`);
}

function deleteSelection() {
  if (!sel) return;
  pushUndo();
  if (sel.type === 'edge') { const e = state.edges[sel.i]; state.edges.splice(sel.i, 1); commit('board', `Removed link ${e.from} → ${e.to}`); }
  else {
    const keys = [...selKeys()];
    for (const k of keys) {
      const [t, id] = splitKey(k);
      if (t === 'n' || t === 'g') removeItem(id);
      if (t === 'i') state.ink = state.ink.filter(x => x.id !== id);
      if (t === 'c') state.comments = state.comments.filter(x => x.id !== id);
    }
    commit('board', keys.length > 1 ? `Removed ${keys.length} items` : `Removed ${splitKey(keys[0])[1]}`);
  }
  sel = null; render();
}

// ---------- images ----------

// A pasted or dropped picture, made smaller first so the board stays light enough to save.
function addImage(file, p) {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    const max = 1200, k = Math.min(1, max / Math.max(img.width, img.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const src = c.toDataURL('image/webp', 0.85);
    const w = Math.min(360, c.width), h = w * c.height / c.width;
    pushUndo(); pinAll();
    const id = freeId('img');
    state.nodes.set(id, { id, label: (file.name || 'Image').replace(/\.\w+$/, ''), shape: 'image', src, group: groupAt(p), marked: false });
    state.pos.set(id, { x: p.x, y: p.y, w, h });
    sel = { type: 'node', id };
    commit('board', `Added image ${id}`);
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('That picture could not be read'); };
  img.src = url;
}

// ---------- comments and ink ----------

let penColor = '#1a1a1a', hlColor = '#ffd43b';
const INK_COLORS = ['#1a1a1a', '#e03131', '#4262ff', '#2f9e44', '#f08c00', '#7048e8'];
const HL_COLORS = ['#ffd43b', '#69db7c', '#74c0fc', '#f783ac', '#ffa94d'];
function freeInkId() { let k = state.ink.length + 1; while (state.ink.some(x => x.id === `ink${k}`)) k++; return `ink${k}`; }
function placeComment(p) {
  setTool('select');
  pushUndo();
  let k = state.comments.length + 1; while (state.comments.some(x => x.id === `c${k}`)) k++;
  const c = { id: `c${k}`, x: p.x, y: p.y, text: '' };
  state.comments.push(c);
  sel = { type: 'comment', id: c.id };
  commit('board', 'Added a comment');
  openEditor({ type: 'comment', id: c.id });
}

// ---------- copy, paste, align ----------

// Copy keeps the items, with their links, positions, ink and comments, for pasting on any board.
// The chat gets the selection as Mermaid, so a copied piece can be pasted there too.
const CLIP_KEY = 'kiertotie.clip';
function copySelection() {
  const it = selectionItems();
  if (!it.nodes.size && !it.ink.size && !it.comments.size && !it.groups.size) return null;
  const ids = new Set([...it.nodes, ...it.groups]);
  const clone = x => JSON.parse(JSON.stringify(x));
  const pos = [];
  for (const id of ids) { const b = state.pos.get(id) || boxes.get(id); if (b && (state.nodes.has(id) || state.pos.get(id))) pos.push([id, { x: b.x, y: b.y, ...(state.pos.get(id)?.w ? { w: state.pos.get(id).w, h: state.pos.get(id).h } : {}) }]); }
  const clip = {
    board: boardId,
    nodes: [...it.nodes].map(id => clone(state.nodes.get(id))),
    groups: [...it.groups].map(id => clone(state.groups.get(id))),
    edges: state.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map(clone),
    pos, ink: state.ink.filter(k => it.ink.has(k.id)).map(clone), comments: state.comments.filter(c => it.comments.has(c.id)).map(clone),
  };
  clip.text = subsetMermaid(clip);
  store.set(CLIP_KEY, JSON.stringify(clip));
  return clip;
}
function readClip() { try { return JSON.parse(store.get(CLIP_KEY)); } catch { return null; } }
// The Mermaid for just some items: the writer, run on a board that holds only them.
function subsetMermaid(clip) {
  const keep = { nodes: state.nodes, groups: state.groups, edges: state.edges };
  // Frames and boxes whose parent wasn't copied sit at the top level of the copy.
  const gids = new Set(clip.groups.map(g => g.id));
  state.groups = new Map(clip.groups.map(g => [g.id, { ...g, parent: gids.has(g.parent) ? g.parent : null }]));
  state.nodes = new Map(clip.nodes.map(n => [n.id, { ...n, group: gids.has(n.group) ? n.group : null }]));
  state.edges = clip.edges;
  try { return toMermaid(); } finally { Object.assign(state, keep); }
}

function pasteClip(clip) {
  pushUndo(); pinAll();
  const map = new Map();
  const take = old => { const base = old.replace(/\d+$/, '') || 'n'; const id = freeId(base); map.set(old, id); return id; };
  // Same board: a little down and right of the original. Another board: in the middle of the view.
  const b0 = clip.pos.length ? clip.pos.reduce((a, [, p]) => ({ x0: Math.min(a.x0, p.x), x1: Math.max(a.x1, p.x), y0: Math.min(a.y0, p.y), y1: Math.max(a.y1, p.y) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }) : null;
  const c = viewCentre();
  const d = clip.board === boardId || !b0 ? { x: 30, y: 30 } : { x: c.x - (b0.x0 + b0.x1) / 2, y: c.y - (b0.y0 + b0.y1) / 2 };
  for (const g of clip.groups) { const id = take(g.id); state.groups.set(id, { ...g, id }); }
  for (const g of clip.groups) { const ng = state.groups.get(map.get(g.id)); ng.parent = map.get(g.parent) || (state.groups.has(g.parent) ? g.parent : null); }
  for (const n of clip.nodes) { const id = take(n.id); state.nodes.set(id, { ...n, id, group: map.get(n.group) || (state.groups.has(n.group) ? n.group : null) }); }
  for (const [old, p] of clip.pos) if (map.has(old)) state.pos.set(map.get(old), { ...p, x: p.x + d.x, y: p.y + d.y });
  for (const e of clip.edges) state.edges.push({ ...e, from: map.get(e.from), to: map.get(e.to) });
  // Select what was pasted: the outermost frames, and boxes that aren't inside one of them.
  const keys = [...clip.groups.filter(g => !map.has(g.parent)).map(g => `g:${map.get(g.id)}`), ...clip.nodes.filter(n => !map.has(n.group)).map(n => `n:${map.get(n.id)}`)];
  for (const k of clip.ink) { const id = freeInkId(); state.ink.push({ ...k, id, pts: k.pts.map(([x, y]) => [x + d.x, y + d.y]) }); keys.push(`i:${id}`); }
  for (const cm of clip.comments) { let n = state.comments.length + 1; while (state.comments.some(x => x.id === `c${n}`)) n++; state.comments.push({ ...cm, id: `c${n}`, x: cm.x + d.x, y: cm.y + d.y }); keys.push(`c:c${n}`); }
  sel = fromKeys(keys);
  commit('board', `Pasted ${keys.length} ${keys.length === 1 ? 'item' : 'items'}`);
}

// Align and spread the selected boxes, using their outer edges, as Miro does.
function alignSelection(how) {
  const ids = [...selKeys()].filter(k => k.startsWith('n:')).map(k => splitKey(k)[1]).filter(id => boxes.has(id));
  if (ids.length < 2) return;
  pushUndo(); pinAll();
  const bs = ids.map(id => ({ id, b: boxes.get(id) }));
  const L = Math.min(...bs.map(({ b }) => b.x - b.w / 2)), R = Math.max(...bs.map(({ b }) => b.x + b.w / 2));
  const T = Math.min(...bs.map(({ b }) => b.y - b.h / 2)), B = Math.max(...bs.map(({ b }) => b.y + b.h / 2));
  const set = (id, x, y) => state.pos.set(id, { ...state.pos.get(id), x, y });
  if (how === 'left') for (const { id, b } of bs) set(id, L + b.w / 2, b.y);
  if (how === 'center') for (const { id, b } of bs) set(id, (L + R) / 2, b.y);
  if (how === 'right') for (const { id, b } of bs) set(id, R - b.w / 2, b.y);
  if (how === 'top') for (const { id, b } of bs) set(id, b.x, T + b.h / 2);
  if (how === 'middle') for (const { id, b } of bs) set(id, b.x, (T + B) / 2);
  if (how === 'bottom') for (const { id, b } of bs) set(id, b.x, B - b.h / 2);
  if (how === 'hspace' || how === 'vspace') {
    const h = how === 'hspace', sorted = [...bs].sort((a, b) => h ? a.b.x - b.b.x : a.b.y - b.b.y);
    const total = sorted.reduce((s, { b }) => s + (h ? b.w : b.h), 0);
    const gap = ((h ? R - L : B - T) - total) / (sorted.length - 1);
    let at = h ? L : T;
    for (const { id, b } of sorted) { if (h) set(id, at + b.w / 2, b.y); else set(id, b.x, at + b.h / 2); at += (h ? b.w : b.h) + gap; }
  }
  commit('board', `Aligned ${ids.length} boxes`);
}

// Frame it: the selected boxes go into a new frame.
function frameSelection() {
  const ids = [...selectionItems().nodes];
  if (!ids.length) return;
  pushUndo(); pinAll();
  const parents = new Set(ids.map(id => state.nodes.get(id).group || null));
  const id = freeId('frame');
  state.groups.set(id, { id, title: 'Frame', parent: parents.size === 1 ? [...parents][0] : null, marked: false });
  for (const n of ids) state.nodes.get(n).group = id;
  sel = { type: 'group', id };
  commit('board', `Put ${ids.length} boxes in a frame`);
  openEditor(sel);
}

function nudge(dx, dy) {
  const it = selectionItems(); if (!it.nodes.size && !it.ink.size && !it.comments.size) return;
  pushUndo(); pinAll();
  for (const id of it.nodes) { const p = state.pos.get(id); state.pos.set(id, { ...p, x: p.x + dx, y: p.y + dy }); }
  for (const g of it.groups) { const p = state.pos.get(g); if (p?.w) state.pos.set(g, { ...p, x: p.x + dx, y: p.y + dy }); }
  for (const k of state.ink) if (it.ink.has(k.id)) k.pts = k.pts.map(([x, y]) => [x + dx, y + dy]);
  for (const c of state.comments) if (it.comments.has(c.id)) { c.x += dx; c.y += dy; }
  commit('board', '');
}

const typing = el => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);

onDoc('keydown', e => {
  if (typing(doc().activeElement)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (mod && k === 'z') { e.preventDefault(); undo(); }
  else if (mod && (k === 'c' || k === 'x')) {
    const clip = sel && sel.type !== 'edge' && copySelection(); if (!clip) return;
    e.preventDefault(); copyText(clip.text);
    if (k === 'x') deleteSelection(); else toast('Copied. Paste here, on another board, or in the chat.');
  }
  else if (mod && k === 'd') { e.preventDefault(); const clip = sel && copySelection(); if (clip) pasteClip(clip); }
  else if (mod && k === 'a') { e.preventDefault(); select(fromKeys([...[...state.nodes.keys()].map(id => `n:${id}`), ...state.ink.map(x => `i:${x.id}`), ...state.comments.map(x => `c:${x.id}`)])); }
  else if (e.key.startsWith('Arrow') && sel && sel.type !== 'edge') {
    e.preventDefault(); const st = e.shiftKey ? 10 : 1;
    nudge(e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0);
  }
  else if (e.key === ' ' && !e.repeat) { e.preventDefault(); spaceDown = true; svg.classList.add('panning'); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
  else if (e.key === 'Escape') { select(null); setTool('select'); if (markMode) setMarkMode(false); }
  else if (mod || e.altKey) return;
  else if (e.key.toLowerCase() === 'm') setMarkMode(!markMode);
  else if (e.key.toLowerCase() === 'f') fit();
  else if (e.key.toLowerCase() === 'v') setTool('select');
  else if (e.key.toLowerCase() === 'n') setTool('sticky');
  else if (e.key.toLowerCase() === 't') setTool('text');
  else if (e.key.toLowerCase() === 'r') setTool('shape', 'box');
  else if (e.key.toLowerCase() === 'i') openPop('icon');
  else if (e.key.toLowerCase() === 'p') setTool('pen');
  else if (e.key.toLowerCase() === 'c') setTool('comment');
});
onDoc('keyup', e => { if (e.key === ' ') { spaceDown = false; svg.classList.remove('panning'); } });

const looksLikeDiagram = text => /-->|---|==>|-\.->|^\s*(flowchart|graph|subgraph)\b|^\s*(remove|delete|rename|mark|unmark)\s+\S/im.test(text);

onDoc('paste', e => {
  if (typing(e.target)) return;
  const text = e.clipboardData?.getData('text/plain') || '';
  // A picture: it becomes an image on the board.
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); addImage(file, viewCentre()); return; }
  // What Kiertotie itself copied: paste the items, not the Mermaid.
  const clip = readClip();
  if (clip && text && text === clip.text) { e.preventDefault(); pasteClip(clip); return; }
  if (!looksLikeDiagram(text) && !/\[|\(/.test(text)) { toast('That paste does not look like a diagram'); return; }
  e.preventDefault();
  applyText(text, 'paste');
});

// ---------- minimap ----------

// A small map of the whole board in the corner; click or drag in it to move the view.
const MINI_KEY = 'kiertotie.minimap';
let miniOn = store.get(MINI_KEY) !== 'off';
let miniFrame = null;
function renderMinimap() {
  const el = $('#minimap'); if (!el) return;
  const all = contentBoxes();
  // An <svg> has no .hidden property, so the attribute is set directly.
  const show = miniOn && all.length >= 2;
  el.toggleAttribute('hidden', !show);
  if (!show) return;
  const W = 168, H = 110, r = svg.getBoundingClientRect();
  const vw = { x0: -view.x / view.k, y0: -view.y / view.k, x1: (r.width - view.x) / view.k, y1: (r.height - view.y) / view.k };
  let x0 = Math.min(vw.x0, ...all.map(b => b.x - b.w / 2)), x1 = Math.max(vw.x1, ...all.map(b => b.x + b.w / 2));
  let y0 = Math.min(vw.y0, ...all.map(b => b.y - b.h / 2)), y1 = Math.max(vw.y1, ...all.map(b => b.y + b.h / 2));
  const k = Math.min(W / (x1 - x0), H / (y1 - y0)), ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
  miniFrame = { x0, y0, k, ox, oy };
  const R = b => `x="${ox + (b.x - b.w / 2 - x0) * k}" y="${oy + (b.y - b.h / 2 - y0) * k}" width="${Math.max(1, b.w * k)}" height="${Math.max(1, b.h * k)}"`;
  el.innerHTML = [...groupBoxes.values()].map(b => `<rect class="mm-group" ${R(b)}/>`).join('') +
    [...boxes.values()].map(b => `<rect class="mm-node" ${R(b)}/>`).join('') +
    `<rect class="mm-view" ${R({ x: (vw.x0 + vw.x1) / 2, y: (vw.y0 + vw.y1) / 2, w: vw.x1 - vw.x0, h: vw.y1 - vw.y0 })}/>`;
}
function miniMove(e) {
  if (!miniFrame) return;
  const r = $('#minimap').getBoundingClientRect(), b = svg.getBoundingClientRect();
  const wx = miniFrame.x0 + (e.clientX - r.left - miniFrame.ox) / miniFrame.k, wy = miniFrame.y0 + (e.clientY - r.top - miniFrame.oy) / miniFrame.k;
  view.x = b.width / 2 - wx * view.k; view.y = b.height / 2 - wy * view.k;
  render();
}

// ---------- icons ----------

// Azure, Power Platform and Dynamics 365 icons (from orim), loaded the first time a board needs one.
const Icons = { state: 'idle', list: [], byKey: new Map(), memo: new Map(), promise: null };
const PACK_ALIAS = { azure: 'azure', az: 'azure', pp: 'pp', power: 'pp', powerplatform: 'pp', 'power-platform': 'pp', d365: 'd365', dynamics: 'd365', dynamics365: 'd365' };
const PACK_TITLES = { azure: 'Azure', pp: 'Power Platform', d365: 'Dynamics 365' };

function loadIcons() {
  if (Icons.promise) return Icons.promise;
  Icons.state = 'loading';
  Icons.promise = fetch('vendor/icons.json?v=1').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(d => {
    for (const p of d.packs) for (const it of p.icons) {
      const icon = { key: `${p.id}:${it.id}`, pack: p.id, id: it.id, title: it.t, cat: it.c, uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(it.s)}` };
      Icons.list.push(icon); Icons.byKey.set(icon.key, icon);
    }
    Icons.state = 'ready';
  }).catch(() => { Icons.state = 'failed'; }).then(() => { Icons.memo.clear(); render(); renderIconGrid(); });
  return Icons.promise;
}

// Assistants guess names, so a near miss still finds its icon: plural or not, an azure- prefix, shared words.
function iconFor(key) {
  if (!key || Icons.state !== 'ready') return null;
  if (Icons.memo.has(key)) return Icons.memo.get(key);
  let k = String(key).trim().toLowerCase().replace(/[\s_]+/g, '-'), pack = null;
  const c = k.indexOf(':');
  if (c > 0) { pack = PACK_ALIAS[k.slice(0, c)] || null; k = k.slice(c + 1); }
  const pool = pack ? Icons.list.filter(i => i.pack === pack) : Icons.list;
  const bare = k.replace(/^(azure|microsoft)-/, '');
  let hit = pool.find(i => i.id === k) || pool.find(i => [k, `${k}s`, k.replace(/s$/, ''), `azure-${bare}`, bare, `${bare}s`].includes(i.id));
  if (!hit) {
    const words = bare.split('-').map(w => w.replace(/s$/, '')).filter(Boolean);
    let best = 0;
    for (const i of pool) {
      const iw = i.id.split('-').map(w => w.replace(/s$/, ''));
      const common = words.filter(w => iw.includes(w)).length;
      const score = common - (iw.length - common) * 0.3;
      if (common >= Math.ceil(words.length / 2) && score > best) { best = score; hit = i; }
    }
  }
  Icons.memo.set(key, hit || null);
  return hit || null;
}

let iconPack = 'azure';
function renderIconGrid() {
  const grid = $('#icon-grid'); if (!grid || $('#icon-pop').hidden) return;
  if (Icons.state !== 'ready') { grid.innerHTML = `<p class="muted small">${Icons.state === 'failed' ? 'The icons did not load.' : 'Loading icons…'}</p>`; return; }
  const words = $('#icon-q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = Icons.list.filter(i => (words.length || i.pack === iconPack) && words.every(w => `${i.title} ${i.id} ${i.cat}`.toLowerCase().includes(w)));
  grid.innerHTML = list.slice(0, 120).map(i => `<button type="button" class="icon-btn" data-icon="${esc(i.key)}" title="${esc(i.title)} (${esc(i.key)})"><img src="${i.uri}" alt="" width="32" height="32"><span>${esc(i.title)}</span></button>`).join('')
    || '<p class="muted small">No icon matches.</p>';
  for (const b of doc().querySelectorAll('#icon-tabs [data-pack]')) b.setAttribute('aria-pressed', String(!words.length && b.dataset.pack === iconPack));
}

// ---------- templates ----------

// Columns of sticky notes in frames: a retrospective, a kanban board. wrap: frames per row.
function stickyBoard(cols, { wrap = cols.length, theme = 'pastel' } = {}) {
  const S = 160, G = 24, PADX = 24, PADT = 44, PADB = 24, per = 2, gap = 64;
  const colW = PADX * 2 + per * S + (per - 1) * G;
  const rows = Math.max(...cols.map(c => Math.ceil(c.notes.length / per)));
  const colH = PADT + rows * S + (rows - 1) * G + PADB;
  const L = ['flowchart LR'], style = [], pos = [];
  cols.forEach((c, k) => {
    const x0 = (k % wrap) * (colW + gap), y0 = Math.floor(k / wrap) * (colH + gap);
    L.push(`  subgraph ${c.id}["${c.label}"]`);
    c.notes.forEach(([text, fill], i) => {
      const id = `${c.id}${i + 1}`;
      L.push(`    ${id}["${text}"]:::sticky`); style.push(`  style ${id} fill:${fill}`);
      pos.push(`%% @pos ${id} ${x0 + PADX + (i % per) * (S + G) + S / 2} ${y0 + PADT + Math.floor(i / per) * (S + G) + S / 2}`);
    });
    L.push('  end');
    pos.push(`%% @pos ${c.id} ${x0 + colW / 2} ${y0 + colH / 2} ${colW} ${colH}`);
  });
  return [...L, ...style, ...pos, ...(theme ? [`%% @theme ${theme}`] : [])].join('\n');
}
function brainstorm(topic, ideas) {
  const L = ['flowchart LR', `  topic(("${topic}"))`], pos = ['%% @pos topic 0 0'];
  ideas.forEach(([text, fill], i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / ideas.length, id = `idea${i + 1}`;
    L.push(`  ${id}["${text}"]:::sticky`, `  topic --- ${id}`, `  style ${id} fill:${fill}`);
    pos.push(`%% @pos ${id} ${Math.round(Math.cos(a) * 340)} ${Math.round(Math.sin(a) * 260)}`);
  });
  return [...L, '  style topic fill:#1a1a1a,stroke:#1a1a1a,color:#ffffff', ...pos].join('\n');
}

const NOTE = { y: '#fff59d', b: '#c5d8ff', g: '#c3f0c8', p: '#fcc2d7', o: '#ffd8a8', v: '#d0bfff', r: '#ffc9c9' };
const TEMPLATES = [
  { cat: 'Architecture', id: 'webapp', name: 'Azure web application', desc: 'Front Door, App Service, Functions, SQL', tint: '#e3f0fb', code: `flowchart LR
  user@{ icon: "azure:users", label: "Customers" }
  entra@{ icon: "azure:entra-id", label: "Entra ID" }
  fd@{ icon: "azure:front-door-and-cdn-profiles", label: "Front Door" }
  subgraph rg["Resource group: prod"]
    subgraph vnet["Virtual network"]
      web@{ icon: "azure:app-services", label: "Web app" }
      api@{ icon: "azure:function-apps", label: "Orders API" }
      sql@{ icon: "azure:sql-database", label: "Orders DB" }
    end
    kv@{ icon: "azure:key-vaults", label: "Key Vault" }
    st@{ icon: "azure:storage-accounts", label: "Blob storage" }
    ai@{ icon: "azure:application-insights", label: "App Insights" }
  end
  user --> fd
  user -.->|sign in| entra
  fd --> web
  web --> api
  api --> sql
  api --> st
  web -.->|secrets| kv
  api -.-> ai` },
  { cat: 'Architecture', id: 'events', name: 'Event-driven orders', desc: 'Service Bus, Functions, Cosmos DB, Logic Apps', tint: '#e4f4ee', code: `flowchart LR
  shop@{ icon: "azure:app-services", label: "Shop" }
  apim@{ icon: "azure:api-management-services", label: "API gateway" }
  sb@{ icon: "azure:azure-service-bus", label: "orders topic" }
  subgraph workers[Processing]
    pay@{ icon: "azure:function-apps", label: "Payment" }
    ship@{ icon: "azure:function-apps", label: "Shipping" }
  end
  cosmos@{ icon: "azure:azure-cosmos-db", label: "Order store" }
  eg@{ icon: "azure:event-grid-topics", label: "Event Grid" }
  la@{ icon: "azure:logic-apps", label: "Notify customer" }
  bi@{ icon: "pp:power-bi", label: "Sales dashboard" }
  shop --> apim --> sb
  sb --> pay
  sb --> ship
  pay --> cosmos
  ship --> cosmos
  cosmos -.->|change feed| eg
  eg --> la
  cosmos ==> bi` },
  { cat: 'Architecture', id: 'pp', name: 'Power Platform solution', desc: 'Apps, Dataverse, flows, agents and reports', tint: '#f1e6f4', code: `flowchart LR
  users@{ icon: "azure:users", label: "Employees" }
  entra@{ icon: "azure:entra-id", label: "Entra ID" }
  subgraph env["Power Platform environment"]
    app@{ icon: "pp:power-apps", label: "Canvas app" }
    portal@{ icon: "pp:power-pages", label: "Partner portal" }
    agent@{ icon: "pp:copilot-studio", label: "Help agent" }
    dv@{ icon: "pp:dataverse", label: "Dataverse" }
    flow@{ icon: "pp:power-automate", label: "Cloud flows" }
    bi@{ icon: "pp:power-bi", label: "Reports" }
  end
  gw@{ icon: "azure:on-premises-data-gateways", label: "Data gateway" }
  erp[(On-prem ERP)]
  users --> app
  users --> agent
  users -.->|sign in| entra
  app --> dv
  portal --> dv
  agent --> dv
  dv -->|row changed| flow
  flow --> gw
  gw --> erp
  dv ==> bi` },
  { cat: 'Architecture', id: 'inspect', name: 'Field inspections', desc: 'Power Apps, Dataverse and Azure services', tint: '#f1e6f4', code: `flowchart LR
  inspector@{ icon: "azure:users", label: "Field inspector" }
  subgraph pp["Power Platform"]
    app@{ icon: "pp:power-apps", label: "Inspection app" }
    copilot@{ icon: "pp:copilot-studio", label: "Inspection agent" }
    dv@{ icon: "pp:dataverse", label: "Dataverse" }
    flow@{ icon: "pp:power-automate", label: "Approval flow" }
  end
  subgraph az[Azure]
    apim@{ icon: "azure:api-management-services", label: "API Management" }
    fn@{ icon: "azure:function-apps", label: "Scoring function" }
    sql@{ icon: "azure:sql-database", label: "Reporting DB" }
    kv@{ icon: "azure:key-vaults", label: "Key Vault" }
  end
  bi@{ icon: "pp:power-bi", label: "Quality report" }
  inspector --> app
  inspector -.->|asks| copilot
  app -->|saves| dv
  copilot --> dv
  dv -->|row added| flow
  flow -->|custom connector| apim
  apim --> fn
  fn --> sql
  fn -.-> kv
  sql --> bi` },
  { cat: 'Architecture', id: 'data', name: 'Analytics pipeline', desc: 'Ingest, lake, transform and report', tint: '#e3f0fb', code: `flowchart LR
  subgraph sources[Sources]
    iot@{ icon: "azure:event-hubs", label: "Event Hubs" }
    crm@{ icon: "pp:dataverse", label: "Dataverse" }
    sql@{ icon: "azure:sql-database", label: "Sales DB" }
  end
  adf@{ icon: "azure:data-factories", label: "Data Factory" }
  subgraph lake["Data lake"]
    raw@{ icon: "azure:storage-accounts", label: "Raw" }
    curated@{ icon: "azure:storage-accounts", label: "Curated" }
  end
  dbx@{ icon: "azure:azure-databricks", label: "Databricks" }
  bi@{ icon: "pp:power-bi", label: "Dashboards" }
  iot --> adf
  crm --> adf
  sql --> adf
  adf --> raw
  raw --> dbx
  dbx --> curated
  curated ==> bi` },
  { cat: 'Screens', id: 'login', name: 'Mobile login flow', desc: 'Five phone screens and how they link', tint: '#eef1ff', code: `flowchart LR
  subgraph splash[Splash]
    sp_logo[" "]:::uiImage
    sp_h["Field inspections"]:::uiHeading
    sp_t["Inspect, score and report on site."]:::uiText
    sp_go["Get started"]:::uiButton
  end
  subgraph signin["Sign in"]
    si_bar["Sign in"]:::uiTopbar
    si_h["Welcome back"]:::uiHeading
    si_email["Email"]:::uiInput
    si_pass["Password"]:::uiInput
    si_rem["Remember me"]:::uiCheckbox
    si_btn["Sign in"]:::uiButton
    si_sso["Continue with Microsoft"]:::uiButton
    si_forgot["Forgot password?"]:::uiLink
  end
  subgraph verify["Verify code"]
    ve_bar["Verify"]:::uiTopbar
    ve_t["We sent a 6-digit code to your email."]:::uiText
    ve_code["6-digit code"]:::uiInput
    ve_btn["Verify"]:::uiButton
    ve_resend["Resend code"]:::uiLink
  end
  subgraph home[Home]
    ho_bar["Inspections"]:::uiTopbar
    ho_h["Today"]:::uiHeading
    ho_list["Warehouse 3<br>Office block B<br>Site 14"]:::uiList
    ho_tabs["Home<br>Map<br>Profile"]:::uiTabbar
  end
  subgraph reset["Reset password"]
    re_bar["Reset password"]:::uiTopbar
    re_t["Enter your email and we'll send a link."]:::uiText
    re_email["Email"]:::uiInput
    re_btn["Send link"]:::uiButton
  end
  class splash,signin,verify,home,reset phone
  sp_go -->|① Get started| signin
  si_btn -->|② signs in| verify
  si_sso -.->|② SSO| home
  ve_btn -->|③ code ok| home
  si_forgot -.->|forgot| reset
  re_btn -.->|link sent| signin
  style si_btn fill:#4262ff
  style sp_go fill:#4262ff
  style ve_btn fill:#4262ff` },
  { cat: 'Process', id: 'flow', name: 'Approval flowchart', desc: 'Shapes, decisions and colours', tint: '#fbf3dc', code: `flowchart TD
  start([Expense submitted]) --> check{Over 500 EUR?}
  check -->|No| auto[Auto-approve]
  check -->|Yes| mgr[Manager review]
  mgr --> ok{Approved?}
  ok -->|Yes| pay[(Payroll)]
  ok -->|No| reject[Notify employee]
  auto --> pay
  style check fill:#fff59d,stroke:#d9a900
  style ok fill:#fff59d,stroke:#d9a900
  style reject fill:#ffc9c9,stroke:#e03131
  style pay fill:#c3f0c8,stroke:#2f9e44` },
  { cat: 'Workshop', id: 'retro', name: 'Retrospective', desc: 'Went well, could be better, actions', tint: '#fdeef2', code: stickyBoard([
    { id: 'well', label: 'What went well', notes: [['Release shipped on time', NOTE.g], ['Pairing on the API', NOTE.g], ['Fewer incidents', NOTE.g], ['Clear sprint goal', NOTE.y]] },
    { id: 'better', label: 'What could be better', notes: [['Too many meetings', NOTE.p], ['Flaky tests in CI', NOTE.r], ['Unclear schema owner', NOTE.o], ['Late design changes', NOTE.p]] },
    { id: 'actions', label: 'Action items', notes: [['Timebox standup to 15 min', NOTE.b], ['Fix the 3 flakiest tests', NOTE.b], ['Name a schema owner', NOTE.v]] }]) },
  { cat: 'Workshop', id: 'kanban', name: 'Kanban board', desc: 'To do, in progress, done', tint: '#fff6cc', code: stickyBoard([
    { id: 'todo', label: 'To do', notes: [['Write the onboarding guide', NOTE.y], ['Set up Dataverse tables', NOTE.y], ['Design the approval flow', NOTE.y], ['Collect report needs', NOTE.y]] },
    { id: 'doing', label: 'In progress', notes: [['Build the inspection app', NOTE.b], ['Custom connector for the API', NOTE.b]] },
    { id: 'done', label: 'Done', notes: [['Environment created', NOTE.g], ['Security roles agreed', NOTE.g], ['Kick-off meeting', NOTE.g]] }]) },
  { cat: 'Workshop', id: 'ssc', name: 'Start, stop, continue', desc: 'Three columns of sticky notes', tint: '#eef6e2', code: stickyBoard([
    { id: 'start', label: 'Start', notes: [['Demo to users every sprint', NOTE.g], ['Write down big decisions', NOTE.g]] },
    { id: 'stop', label: 'Stop', notes: [['Merging without review', NOTE.r], ['Ad-hoc fixes in production', NOTE.p]] },
    { id: 'cont', label: 'Continue', notes: [['Friday knowledge share', NOTE.b], ['Small pull requests', NOTE.b], ['Pairing on hard bugs', NOTE.y]] }]) },
  { cat: 'Workshop', id: 'swot', name: 'SWOT analysis', desc: 'Strengths, weaknesses, opportunities, threats', tint: '#eef6e2', code: stickyBoard([
    { id: 'str', label: 'Strengths', notes: [['Strong Azure skills', NOTE.g], ['Reusable components', NOTE.g]] },
    { id: 'weak', label: 'Weaknesses', notes: [['Small team', NOTE.r], ['Little test automation', NOTE.r]] },
    { id: 'opp', label: 'Opportunities', notes: [['Copilot Studio agents', NOTE.b], ['Legacy apps to move', NOTE.b]] },
    { id: 'thr', label: 'Threats', notes: [['Licence costs', NOTE.o], ['Competing vendors', NOTE.o]] }], { wrap: 2 }) },
  { cat: 'Workshop', id: 'brainstorm', name: 'Brainstorm', desc: 'One topic, ideas around it', tint: '#fdeef2', code: brainstorm('New hire onboarding', [
    ['Welcome video from the team', NOTE.y], ['Buddy for the first month', NOTE.p], ['Laptop ready on day one', NOTE.b], ['Checklist app in Power Apps', NOTE.g], ['Weekly check-in with the lead', NOTE.o], ['Short quiz after week one', NOTE.v]]) },
];

function paintTemplates() {
  let html = '', cat = '';
  for (const t of TEMPLATES) {
    if (t.cat !== cat) { cat = t.cat; html += `<div class="pop-label">${esc(cat)}</div>`; }
    html += `<button type="button" class="tpl" data-tpl="${t.id}"><span class="tpl-tint" style="background:${t.tint}"></span><span><strong>${esc(t.name)}</strong><span class="muted small">${esc(t.desc)}</span></span></button>`;
  }
  $('#template-list').innerHTML = html;
}

// A template fills an empty board; otherwise it opens as a new board, so nothing is lost.
function useTemplate(id) {
  const t = TEMPLATES.find(x => x.id === id); if (!t) return;
  closePops(); if ($('#boards').open) $('#boards').close();
  if (!state.nodes.size && !state.groups.size) {
    applyText(t.code, 'template');
    if (/^(Untitled board|My board)$/.test(currentBoard().name)) renameBoard(boardId, t.name);
    toast(`${t.name} added`);
  } else {
    createBoard(t.name, t.code);
    toast(`${t.name} opened as a new board. Boards lists the others.`, 4000);
  }
  updateEmpty();
}

// ---------- rail popovers ----------

let iconTarget = null; // a node whose icon is being swapped
function openPop(name, { target = null } = {}) {
  const pop = $(`#${name}-pop`), wasOpen = !pop.hidden;
  closePops();
  if (wasOpen && !target) return;
  pop.hidden = false;
  for (const b of doc().querySelectorAll('#rail [data-pop]')) b.setAttribute('aria-expanded', String(b.dataset.pop === name));
  if (name === 'template') paintTemplates();
  if (name === 'screen') paintScreenPop();
  if (name === 'draw') { if (!['pen', 'hl', 'arrow', 'eraser'].includes(tool)) setTool('pen'); pop.hidden = false; paintDrawColors(); }
  if (name === 'icon') { iconTarget = target; loadIcons(); renderIconGrid(); $('#icon-q').focus(); }
}
function closePops() {
  for (const p of doc().querySelectorAll('.pop')) p.hidden = true;
  for (const b of doc().querySelectorAll('#rail [data-pop]')) b.setAttribute('aria-expanded', 'false');
}

// ---------- selection toolbar ----------

const PALETTE = [
  { name: 'Default', fill: null },
  { name: 'Yellow', fill: '#fff59d', stroke: '#d9a900' },
  { name: 'Orange', fill: '#ffd8a8', stroke: '#e8590c' },
  { name: 'Red', fill: '#ffc9c9', stroke: '#e03131' },
  { name: 'Pink', fill: '#fcc2d7', stroke: '#c2255c' },
  { name: 'Violet', fill: '#d0bfff', stroke: '#6741d9' },
  { name: 'Blue', fill: '#c5d8ff', stroke: '#4262ff' },
  { name: 'Green', fill: '#c3f0c8', stroke: '#2f9e44' },
  { name: 'Grey', fill: '#e9ecef', stroke: '#495057' },
];
const STICKY = PALETTE[1];
const SHAPE_NAMES = [['box', 'Box'], ['round', 'Rounded'], ['stadium', 'Pill'], ['circle', 'Circle'], ['diamond', 'Decision'],
  ['cylinder', 'Database'], ['hexagon', 'Hexagon'], ['sticky', 'Sticky note'], ['text', 'Text'], ['table', 'Table'], ['doc', 'Doc'],
  ['phone', 'Phone screen'], ['browser', 'Browser window']];
const ICON_SVG = {
  straight: '<path d="M3 13 L13 3"/>', curved: '<path d="M3 13 C3 6, 13 10, 13 3"/>', elbow: '<path d="M3 13 H8 V3 H13"/>',
  solid: '<path d="M2 8 H14"/>', dotted: '<path d="M2 8 H14" stroke-dasharray="2.5 2"/>', thick: '<path d="M2 8 H14" stroke-width="3.2"/>',
  arrow: '<path d="M2 8 H13 M9 4 L13 8 L9 12"/>', trash: '<path d="M3 4.5 H13 M6 4.5 V3 H10 V4.5 M4.5 4.5 L5.2 13 H10.8 L11.5 4.5"/>',
  mark: '<path d="M3 13 L5 11 L11 5 L13 7 L7 13 Z M10 4 L12 2 L14 4 L12 6"/>',
  'al-left': '<path d="M2.5 2 V14 M5 5 H13 M5 11 H9"/>', 'al-center': '<path d="M8 2 V14 M3 5 H13 M5 11 H11"/>', 'al-right': '<path d="M13.5 2 V14 M3 5 H11 M7 11 H11"/>',
  'al-top': '<path d="M2 2.5 H14 M5 5 V13 M11 5 V9"/>', 'al-middle': '<path d="M2 8 H14 M5 3 V13 M11 5 V11"/>', 'al-bottom': '<path d="M2 13.5 H14 M5 3 V11 M11 7 V11"/>',
  'al-hspace': '<path d="M2 3 V13 M14 3 V13 M6.5 5 V11 M9.5 5 V11"/>', 'al-vspace': '<path d="M3 2 H13 M3 14 H13 M5 6.5 H11 M5 9.5 H11"/>',
};
const glyph = name => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICON_SVG[name]}</svg>`;

let ctxKey = '';
function renderCtx() {
  const el = $('#ctx'); if (!el) return;
  const hide = !sel || drag?.moved || drag?.kind === 'connect' || drag?.kind === 'marquee' || editor || markMode;
  if (hide) { el.hidden = true; ctxKey = ''; return; }
  let html, b;
  const del = `<button data-del title="Delete (Del)">${glyph('trash')}</button>`;
  const sw = (list, cur, attr, fallback) => list.map((c, i) => `<button class="swatch" ${attr}="${i}" aria-pressed="${i === cur}" title="${c.name || c}" style="--sw:${c.fill || c || fallback}"></button>`).join('');
  if (sel.type === 'edge') {
    const e = state.edges[sel.i]; if (!e) { el.hidden = true; return; }
    const a = anchorBox(e.from), c = anchorBox(e.to); if (!a || !c) { el.hidden = true; return; }
    const mid = edgeGeometry(e, a, c).at(0.5);
    b = { x: mid.x, y: mid.y, w: 0, h: 0 };
    const route = routeOf(e);
    html = `<select data-line-type title="Line type"><option value="">Line type…</option>${Object.entries(LINE_TYPES).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('')}</select><span class="ctx-sep"></span>` +
      ['straight', 'curved', 'elbow'].map(r => `<button data-route="${r}" aria-pressed="${route === r}" title="${r[0].toUpperCase() + r.slice(1)} line">${glyph(r)}</button>`).join('') +
      '<span class="ctx-sep"></span>' +
      ['solid', 'dotted', 'thick'].map(s => `<button data-estyle="${s}" aria-pressed="${e.style === s}" title="${s[0].toUpperCase() + s.slice(1)}">${glyph(s)}</button>`).join('') +
      `<button data-arrow aria-pressed="${e.arrow}" title="Arrow head">${glyph('arrow')}</button><span class="ctx-sep"></span>` +
      sw(EDGE_COLORS, Math.max(0, EDGE_COLORS.findIndex(x => x.fill === e.color)), 'data-ecolor', 'var(--edge)') +
      `<span class="ctx-sep"></span>${del}`;
  } else if (sel.type === 'ink') {
    const k = state.ink.find(x => x.id === sel.id); if (!k) { el.hidden = true; return; }
    b = inkBox(k);
    const list = k.kind === 'hl' ? HL_COLORS : INK_COLORS;
    html = sw(list, list.indexOf(k.color), 'data-icolor') + `<span class="ctx-sep"></span>${del}`;
  } else if (sel.type === 'comment') {
    const c = state.comments.find(x => x.id === sel.id); if (!c) { el.hidden = true; return; }
    b = commentBox(c);
    html = `<button data-edit-comment>Edit</button>${del}`;
  } else if (sel.type === 'multi') {
    b = keysBox(selKeys()); if (!b) { el.hidden = true; return; }
    const boxesSel = [...selKeys()].filter(k => k.startsWith('n:')).length;
    const al = (k, t) => `<button data-align="${k}" title="${t}">${glyph(`al-${k}`)}</button>`;
    html = sw(PALETTE, -1, 'data-color', 'var(--node)') + '<span class="ctx-sep"></span>' +
      (boxesSel > 1 ? al('left', 'Align left') + al('center', 'Align centres') + al('right', 'Align right') + al('top', 'Align top') + al('middle', 'Align middles') + al('bottom', 'Align bottom') +
        (boxesSel > 2 ? al('hspace', 'Space evenly across') + al('vspace', 'Space evenly down') : '') + '<span class="ctx-sep"></span>' : '') +
      `<button data-frame-it title="Put them in a frame">Frame</button><span class="ctx-count">${selKeys().size}</span>${del}`;
  } else {
    const item = sel.type === 'node' ? state.nodes.get(sel.id) : state.groups.get(sel.id);
    b = sel.type === 'node' ? boxes.get(sel.id) : groupBoxes.get(sel.id);
    if (!item || !b) { el.hidden = true; return; }
    const isIcon = item.shape === 'icon', isImage = item.shape === 'image';
    const c = colorsOf(item);
    const cur = Math.max(0, PALETTE.findIndex(p => p.fill && (item.shape === 'text' ? p.stroke === c.color : p.fill === c.fill)));
    const swatches = isIcon || isImage || item.dev ? '' : isUi(item)
      ? sw([{ name: 'Grey', fill: null }, ...PALETTE.slice(1).map(p => ({ name: p.name, fill: p.stroke }))], Math.max(0, PALETTE.findIndex(p => p.stroke === c.fill)), 'data-color', '#5f6470') + '<span class="ctx-sep"></span>'
      : sw(PALETTE.map(p => ({ ...p, fill: p.fill || (item.shape === 'sticky' ? STICKY.fill : null) })), cur, 'data-color', 'var(--node)') + '<span class="ctx-sep"></span>';
    const pick = sel.type === 'group' && item.dev
      ? `<select data-device-pick title="Device">${Object.entries(DEVICES).map(([k, d]) => `<option value="${k}"${item.dev === k ? ' selected' : ''}>${d.name}</option>`).join('')}</select>` +
        `<select data-piece-add title="Add a piece to this screen"><option value="">Add a piece…</option>${Object.entries(UI_KINDS).map(([k, u]) => `<option value="${k}">${u.name}</option>`).join('')}</select>`
      : isUi(item) ? `<select data-piece-kind title="Kind of piece">${Object.entries(UI_KINDS).map(([k, u]) => `<option value="${k}"${item.shape === k ? ' selected' : ''}>${u.name}</option>`).join('')}</select>`
      : sel.type === 'group'
      ? `<select data-zone-pick title="What kind of boundary">${[['', 'Plain frame'], ...Object.entries(ZONES).map(([k, z]) => [k, z.name])].map(([v, t]) => `<option value="${v}"${(zoneOf(item) || '') === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`
      : isIcon ? '<button data-swap-icon title="Pick another icon">Change icon</button>'
      : isImage ? '' : `<select data-shape-pick title="Shape">${SHAPE_NAMES.map(([v, t]) => `<option value="${v}"${item.shape === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
    html = swatches + pick +
      `<button data-markitem aria-pressed="${!!item.marked}" title="Highlight for your next request">${glyph('mark')}</button>` + del;
  }
  if (html !== ctxKey) { el.innerHTML = html; ctxKey = html; }
  el.hidden = false;
  const wrap = $('.board-wrap').getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const gap = sel.type === 'node' ? 28 : sel.type === 'group' ? FRAME_TITLE + 12 : 14;
  let left = view.x + b.x * view.k - w / 2, top = view.y + (b.y - b.h / 2) * view.k - h - gap;
  if (top < 60) top = view.y + (b.y + b.h / 2) * view.k + gap;
  left = Math.max(8, Math.min(wrap.width - w - 8, left));
  top = Math.max(8, Math.min(wrap.height - h - 8, top));
  el.style.left = `${left}px`; el.style.top = `${top}px`;
}

function paint(item, p) {
  if (!p.fill) { delete item.style; if (item.cls) delete item.cls; }
  else if (isUi(item)) item.style = { fill: p.stroke };
  else if (item.shape === 'text') item.style = { color: p.stroke };
  else if (item.shape === 'sticky') item.style = { fill: p.fill };
  else if (item.shape !== 'icon' && item.shape !== 'image') item.style = { fill: p.fill, stroke: p.stroke };
}
function setColor(items, i) {
  const p = PALETTE[i];
  pushUndo();
  for (const item of items) paint(item, p);
  commit('board', `Coloured ${items.length === 1 ? items[0].id : `${items.length} items`} ${p.name.toLowerCase()}`);
}

function ctxClick(e) {
  const t = e.target.closest('button'); if (!t || !sel) return;
  if (t.dataset.del != null) return deleteSelection();
  if (sel.type === 'multi') {
    if (t.dataset.color != null) {
      const items = [...selKeys()].map(k => { const [ty, id] = splitKey(k); return ty === 'n' ? state.nodes.get(id) : ty === 'g' ? state.groups.get(id) : null; }).filter(Boolean);
      return setColor(items, +t.dataset.color);
    }
    if (t.dataset.align) return alignSelection(t.dataset.align);
    if (t.dataset.frameIt != null) return frameSelection();
    return;
  }
  if (sel.type === 'ink') {
    const k = state.ink.find(x => x.id === sel.id); if (!k || t.dataset.icolor == null) return;
    pushUndo(); k.color = (k.kind === 'hl' ? HL_COLORS : INK_COLORS)[+t.dataset.icolor]; commit('board', 'Recoloured ink'); return;
  }
  if (sel.type === 'comment') { if (t.dataset.editComment != null) openEditor({ type: 'comment', id: sel.id }); return; }
  const item = sel.type === 'edge' ? state.edges[sel.i] : sel.type === 'node' ? state.nodes.get(sel.id) : state.groups.get(sel.id);
  if (!item) return;
  if (t.dataset.color != null) return setColor([item], +t.dataset.color);
  if (t.dataset.markitem != null) return toggleMark(item, sel.type === 'node' ? 'box' : 'group');
  if (t.dataset.swapIcon != null) return openPop('icon', { target: sel.id });
  pushUndo();
  if (t.dataset.route) { if (t.dataset.route === 'curved') delete item.route; else item.route = t.dataset.route; }
  if (t.dataset.estyle) item.style = t.dataset.estyle;
  if (t.dataset.arrow != null) item.arrow = !item.arrow;
  if (t.dataset.ecolor != null) { const c = EDGE_COLORS[+t.dataset.ecolor].fill; if (c) item.color = c; else delete item.color; }
  commit('board', `Changed link ${item.from} → ${item.to}`);
}

function ctxChange(e) {
  const dv = e.target.closest('[data-device-pick]');
  if (dv && sel?.type === 'group') { const g = state.groups.get(sel.id); pushUndo(); g.dev = dv.value; const p = state.pos.get(g.id); if (p?.w) { delete p.w; delete p.h; } commit('board', `Made ${g.title} a ${DEVICES[dv.value].name.toLowerCase()} screen`); return; }
  const pa = e.target.closest('[data-piece-add]');
  if (pa && pa.value) { addPiece(pa.value); return; }
  const pk = e.target.closest('[data-piece-kind]');
  if (pk && sel?.type === 'node') { const n = state.nodes.get(sel.id); pushUndo(); if (n.label === UI_KINDS[n.shape]?.def) n.label = UI_KINDS[pk.value].def; n.shape = pk.value; commit('board', `Made ${n.id} a ${UI_KINDS[pk.value].name.toLowerCase()}`); return; }
  const lt = e.target.closest('[data-line-type]');
  if (lt && sel?.type === 'edge') { if (lt.value) applyLineType(state.edges[sel.i], lt.value); return; }
  const z = e.target.closest('[data-zone-pick]');
  if (z && sel?.type === 'group') {
    const g = state.groups.get(sel.id); pushUndo();
    // Picking a kind names a frame that still has a default name.
    if (z.value) { g.zone = z.value; if (/^(Frame|Group)$/.test(g.title) || Object.values(ZONES).some(x => x.name === g.title)) g.title = ZONES[z.value].name; }
    else g.zone = 'plain';
    commit('board', `Made ${g.id} ${z.value ? ZONES[z.value].name : 'a plain frame'}`); return;
  }
  const s = e.target.closest('[data-shape-pick]'); if (!s || sel?.type !== 'node') return;
  const n = state.nodes.get(sel.id); if (!n) return;
  pushUndo();
  n.shape = s.value;
  if (n.shape === 'sticky' && n.style?.stroke) delete n.style.stroke;
  if (n.shape === 'table' && !n.table) n.table = [['', ''], ['', '']];
  commit('board', `Made ${n.id} a ${SHAPE_NAMES.find(([v]) => v === n.shape)[1].toLowerCase()}`);
}

function pickIcon(key) {
  closePops();
  if (iconTarget && state.nodes.has(iconTarget)) {
    const n = state.nodes.get(iconTarget), ic = iconFor(key), old = iconFor(n.icon);
    pushUndo();
    if (!old || n.label === old.title) n.label = ic.title;
    n.icon = ic.key; iconTarget = null;
    commit('board', `Changed the icon of ${n.id}`);
    return;
  }
  placeItem('icon', viewCentre(), { icon: key });
}

// ---------- messages ----------

function log(channel, message) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.innerHTML = `<time>${time}</time><span class="tag ${esc(channel)}">${esc(channel)}</span><span>${esc(message)}</span>`;
  $('#log').prepend(li);
  while ($('#log').children.length > 80) $('#log').lastChild.remove();
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// The click happened in whichever window shows the board, so that window does the copying.
async function copyText(text) {
  const w = pipWin || window;
  try { await w.navigator.clipboard.writeText(text); return true; }
  catch {
    const d = w.document, ta = Object.assign(d.createElement('textarea'), { value: text });
    d.body.append(ta); ta.select();
    const ok = d.execCommand('copy'); ta.remove();
    return ok;
  }
}

// The banner: the chat's line about what changed, and a warning when part of a link was unreadable.
function showNote(note, warnings = []) {
  $('#note-text').textContent = note || 'Diagram updated';
  const w = $('#note-warn');
  w.hidden = !warnings.length;
  w.textContent = warnings.length ? `${warnings.length} ${warnings.length === 1 ? 'line' : 'lines'} couldn't be read. Ask ${ai().short} to send the link again.` : '';
  $('#note').hidden = !note && !warnings.length;
}

// ---------- the assistant ----------

// Which chat the user works with. It names the buttons and is where Start goes; the rest is the same.
const AIS = [
  { id: 'm365', name: 'Microsoft 365 Copilot', short: 'Copilot', url: 'https://m365.cloud.microsoft/chat', color: '#0f6cbd' },
  { id: 'copilot', name: 'Copilot', short: 'Copilot', url: 'https://copilot.microsoft.com/', color: '#0f6cbd' },
  { id: 'chatgpt', name: 'ChatGPT', short: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f' },
  { id: 'claude', name: 'Claude', short: 'Claude', url: 'https://claude.ai/new', color: '#c96442' },
  { id: 'gemini', name: 'Gemini', short: 'Gemini', url: 'https://gemini.google.com/', color: '#4285f4' },
  { id: 'other', name: 'Another chat', short: 'your chat', url: '', color: '#64748b' },
];
const AI_KEY = 'kiertotie.ai';
let aiId = (() => { try { return localStorage.getItem(AI_KEY); } catch { return null; } })() || 'm365';
const ai = () => AIS.find(a => a.id === aiId) || AIS[0];

function setAi(id) {
  aiId = id;
  try { localStorage.setItem(AI_KEY, id); } catch { /* storage unavailable */ }
  paintAi();
}

function paintAi() {
  const a = ai();
  $('#ai-badge').innerHTML = `<span class="ai-dot" style="background:${a.color}">${esc(a.short[0].toUpperCase())}</span>${esc(a.short)}`;
  $('#ai-chips').innerHTML = AIS.map(x => `<button type="button" role="radio" class="ai-chip" data-ai="${x.id}" aria-checked="${x.id === a.id}"><span class="ai-dot" style="background:${x.color}">${esc(x.short[0].toUpperCase())}</span>${esc(x.name)}</button>`).join('');
  $('#ai-menu').innerHTML = AIS.map(x => `<button type="button" role="menuitemradio" data-ai="${x.id}" aria-checked="${x.id === a.id}"><span class="ai-dot" style="background:${x.color}">${esc(x.short[0].toUpperCase())}</span>${esc(x.name)}</button>`).join('');
  $('#btn-start').textContent = `Start with ${a.short}`;
  if (a.url) $('#wait-open').href = a.url;
  $('#wait-open').textContent = `Open ${a.name} ↗`;
  $('#wait-open').hidden = !a.url;
  $('#mockup').innerHTML = chatMockup(a);
  for (const el of doc().querySelectorAll('.ai-name')) el.textContent = a.short;
  $('.paste-key').textContent = `${key}V`;
  $('#start-help').textContent = canFloat
    ? `Floats this board above your windows, copies the instructions${a.url ? ` and opens ${a.name}` : ''}. Paste there (${key}V) and send.`
    : `Copies the instructions${a.url ? ` and opens ${a.name}` : ''}. Paste there (${key}V) and send.`;
  $('#ask').placeholder = `Next request for ${a.short} (optional)`;
  $('#btn-done').textContent = `Send to ${a.short}`;
  $('#btn-done').title = `Copy the diagram and your request, then paste it into ${a.short}`;
}

// ---------- chat mockups ----------

// A simplified picture of each chat window, with hand-drawn arrows to the three things to do there.
// Shapes and names only: where the message box, the send button and the reply sit in that chat.
const CHAT_LOOKS = {
  m365: { host: 'm365.cloud.microsoft', side: 'rail', box: 'box', send: '#0f6cbd', hint: 'Message Copilot' },
  copilot: { host: 'copilot.microsoft.com', side: null, box: 'pill', send: '#0f6cbd', hint: 'Message Copilot' },
  chatgpt: { host: 'chatgpt.com', side: 'bar', box: 'pill', send: 'var(--text)', hint: 'Ask anything' },
  claude: { host: 'claude.ai', side: 'bar', box: 'box', send: '#c96442', hint: 'Reply to Claude…' },
  gemini: { host: 'gemini.google.com', side: 'bar', box: 'pill', send: '#4285f4', hint: 'Ask Gemini' },
  other: { host: 'your chat', side: null, box: 'box', send: '#64748b', hint: 'Type a message' },
};

function chatMockup(a) {
  const L = CHAT_LOOKS[a.id] || CHAT_LOOKS.other;
  const W = 420, H = 300;
  const x0 = L.side === 'bar' ? 92 : L.side === 'rail' ? 50 : 22, x1 = W - 22;
  const cw = x1 - x0;
  const lines = (x, y, ws) => ws.map((w, i) => `<rect x="${x}" y="${y + i * 11}" width="${w}" height="5" rx="2.5" class="mk-line"/>`).join('');
  const side = L.side === 'bar'
    ? `<rect x="12" y="40" width="66" height="${H - 52}" rx="8" class="mk-panel"/>${lines(22, 56, [44, 36, 40, 30])}`
    : L.side === 'rail' ? `<rect x="12" y="40" width="26" height="${H - 52}" rx="8" class="mk-panel"/>${[0, 1, 2, 3].map(i => `<circle cx="25" cy="${60 + i * 26}" r="6" class="mk-line"/>`).join('')}` : '';
  // the conversation: the pasted instructions, then the answer with its link
  const bubble = `<rect x="${x1 - 150}" y="54" width="150" height="34" rx="12" class="mk-panel"/>${lines(x1 - 140, 64, [120, 86])}`;
  const answerY = 104;
  const answer = `${lines(x0 + 4, answerY, [cw * 0.7, cw * 0.55])}<text x="${x0 + 4}" y="${answerY + 38}" class="mk-link">Open in Kiertotie</text>` +
    `<line x1="${x0 + 4}" y1="${answerY + 41}" x2="${x0 + 118}" y2="${answerY + 41}" class="mk-link-line"/>${lines(x0 + 4, answerY + 52, [cw * 0.6])}`;
  // the message box and send button
  const by = H - 62, bh = L.box === 'pill' ? 34 : 44, br = L.box === 'pill' ? 17 : 12;
  const sx = x1 - (L.box === 'pill' ? 21 : 24), sy = by + bh / 2 + (L.box === 'pill' ? 0 : 4);
  const box = `<rect x="${x0}" y="${by}" width="${cw}" height="${bh}" rx="${br}" class="mk-box"/>` +
    `<text x="${x0 + 14}" y="${by + (L.box === 'pill' ? 21 : 18)}" class="mk-hint">${esc(L.hint)}</text>` +
    `<circle cx="${sx}" cy="${sy}" r="11" style="fill:${L.send}"/><path d="M${sx} ${sy + 5} V${sy - 5} M${sx - 4} ${sy - 1} L${sx} ${sy - 5} L${sx + 4} ${sy - 1}" class="mk-arrow-up"${L.send === 'var(--text)' ? ' style="stroke:var(--bg)"' : ''}/>`;
  // squiggly arrows and notes
  const pasteAt = { x: x0 + cw * 0.38, y: by - 2 }, sendAt = { x: sx + 2, y: sy - 13 }, linkAt = { x: x0 + 124, y: answerY + 34 };
  const squiggle = (fx, fy, tx, ty, bend) => `<path d="M${fx} ${fy} C ${fx + bend} ${fy + 18}, ${tx - bend} ${ty - 30}, ${tx} ${ty}" class="mk-squiggle" marker-end="url(#mk-head)"/>`;
  const note = (x, y, n, t, anchor = 'start') => `<text x="${x}" y="${y}" class="mk-note" text-anchor="${anchor}"><tspan class="mk-num">${n}</tspan> ${esc(t)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Where to paste, send and click in ${esc(a.name)}">
  <defs><marker id="mk-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L8 5 L1 9" class="mk-head"/></marker></defs>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" class="mk-window"/>
  <circle cx="20" cy="18" r="4" class="mk-dot"/><circle cx="33" cy="18" r="4" class="mk-dot"/><circle cx="46" cy="18" r="4" class="mk-dot"/>
  <rect x="${W / 2 - 80}" y="9" width="160" height="18" rx="9" class="mk-panel"/><text x="${W / 2}" y="22" text-anchor="middle" class="mk-host">${esc(L.host)}</text>
  ${side}${bubble}${answer}${box}
  ${note(x0 + 30, by - 50, '1', `Paste here (${key}V)`)}${squiggle(x0 + 60, by - 44, pasteAt.x, pasteAt.y, 30)}
  ${note(x1 - 6, by - 24, '2', 'then send', 'end')}${squiggle(x1 - 30, by - 18, sendAt.x, sendAt.y, -14)}
  ${note(x1 - 6, answerY + 4, '3', 'click when it answers', 'end')}${squiggle(x1 - 70, answerY + 10, linkAt.x + 4, linkAt.y - 4, -40)}
</svg>`;
}

// ---------- texts for the assistant ----------

// encodeURIComponent leaves ( ) ! * ' alone; encoding them too keeps chat apps from cutting the link short.
const encodeLink = s => encodeURIComponent(s.replace(/\n\s*/g, ';')).replace(/[()!*']/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const FOOTER = 'Edit the board if you like, type your next request at its bottom, press Send, then paste here (Ctrl+V).';
const exampleLink = () => `${BASE}#note=${encodeLink('Drew the web app and its API')}&m=${encodeLink('flowchart LR\nweb[Web app] -->|HTTPS| api[API]\napi --> db[(SQL)]')}`;

const RULES = () => `Every reply has exactly three parts:
1. One short line saying what you drew or changed.
2. A Markdown link with the text "Open in Kiertotie" to ${BASE}#note=<your line>&m=<the whole diagram>
3. This line, word for word: "${FOOTER}"
No other text, unless I ask a question.

The diagram is a Mermaid flowchart, and always the whole diagram, never only the changes:
- Start with flowchart LR (or flowchart TD for tall diagrams).
- Short ids with the label in brackets: web[Web app]. Shapes: [box] (rounded) ([pill]) [(database)] ((circle)) {decision}.
- Links: a --> b, with text a -->|HTTPS| b, dotted a -.-> b.
- Boundaries: subgraph azure[Azure subscription] ... end. Name them by kind and they get their own look: Azure subscription, Resource group: <name>, Virtual network, Subnet, On-premises, DMZ, Power Platform environment, External system.
- For a flow, start the link labels with ① ② ③ in order: a -->|① signs in| b.
- Cloud services as icons: kv@{ icon: "azure:key-vaults", label: "Secrets" }. Prefixes azure:, pp: (Power Platform), d365: (Dynamics 365); the name is the product name in lower case with dashes, e.g. azure:app-services, azure:sql-database, azure:function-apps, azure:entra-id, pp:power-automate, d365:sales.
- Sticky notes: n1["A note"]:::sticky. Plain text: t1@{ shape: text, label: "A heading" }.
- UI screens and mockups: one subgraph per screen, then class signin,home phone (or tablet, desktop). Inside, the pieces stack from the top in the order you write them: si_bar["Sign in"]:::uiTopbar, si_h["Welcome back"]:::uiHeading, si_t["Some text"]:::uiText, si_mail["Email"]:::uiInput (the label is the placeholder), si_go["Sign in"]:::uiButton, si_forgot["Forgot password?"]:::uiLink, si_keep["Remember me"]:::uiCheckbox, si_pic[" "]:::uiImage, ho_list["Item one<br>Item two"]:::uiList, ho_tabs["Home<br>Search<br>Profile"]:::uiTabbar (always at the bottom), ho_grid["Name | Status"]:::uiTable, ho_menu["Home<br>Settings"]:::uiSidebar. Link a button to the screen it opens: si_go --> home. style si_go fill:#4262ff makes the main button blue.
- Colours: style web fill:#dbeafe,stroke:#2563eb (fill, stroke and color only), or classDef blue fill:#dbeafe,stroke:#2563eb plus class web,api blue.
- Keep the ids the diagram already has. "class x marked" means I highlighted x: my request is about those.

In the link, put ; between lines and percent-encode everything else, in the note too: space %20, > %3E, | %7C, [ %5B, ] %5D, ( %28, ) %29, { %7B, } %7D, " %22, & %26, # %23, : stays as it is. Example:
[Open in Kiertotie](${exampleLink()})`;

function starterText(request = '') {
  return `You are my diagram assistant. I draw on the Kiertotie board at ${BASE}
You can't open the board yourself: you answer with a link that I click, and the board shows the diagram.
Later I paste the diagram back from the board, with my highlights and my next request.

${RULES()}

My first request: ${request}`;
}

// What the board holds besides the diagram, in words: comments, docs and tables.
function boardNotes() {
  const near = c => { let best = null, d = Infinity; for (const [id, b] of boxes) { const x = Math.hypot(b.x - c.x, b.y - c.y); if (x < d) { d = x; best = id; } } return best && d < 400 ? ` (next to ${state.nodes.get(best).label.replace(/\n/g, ' ')})` : ''; };
  const L = [];
  if (state.comments.length) L.push('My comments on the board:', ...state.comments.map((c, i) => `${i + 1}. ${c.text.replace(/\n/g, ' ')}${near(c)}`));
  for (const n of state.nodes.values()) {
    if (n.shape === 'doc' && n.body) L.push(`Doc ${n.id} "${n.label}": ${n.body.replace(/\n/g, ' / ')}`);
    if (n.shape === 'table' && n.table) L.push(`Table ${n.id} "${n.label}":`, ...n.table.map(r => `| ${r.join(' | ')} |`));
  }
  return L.length ? `\n${L.join('\n')}\n` : '';
}

// After the starter, a paste carries only the data: the diagram, highlights and the request.
function donePacket(request = '') {
  const marked = markedItems();
  const names = marked.map(x => `${x.id} (${(x.label || x.title).replace(/\n/g, ' ')})`);
  return `My Kiertotie diagram now${marked.length ? `, with ${names.join(', ')} highlighted` : ''}:

\`\`\`mermaid
${toMermaid()}
\`\`\`
${boardNotes()}
Reply in the same Kiertotie format. My comments, docs and tables, if any, are listed after the diagram.
My request: ${request}`;
}

// ---------- links ----------

// #note=<line from the assistant>&m=<Mermaid>. The note comes first, so & inside the diagram is harmless.
function parseHash(h) {
  const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };
  let note = '', m = null;
  if (h.startsWith('note=')) {
    const at = h.indexOf('&m=');
    if (at < 0) return null;
    note = decode(h.slice(5, at)); m = h.slice(at + 3);
  } else if (h.startsWith('m=')) m = h.slice(2);
  else if (h.startsWith('z=')) return { note: '', z: h.slice(2) };
  else return null;
  return { note: note.trim(), text: decode(m) };
}

async function readHash() {
  const link = parseHash(location.hash.slice(1));
  if (!link) return;
  history.replaceState(null, '', BASE);
  if (link.z) {
    try { link.text = await unzipText(link.z); }
    catch { showNote('', ['The shared link is damaged']); return; }
  }
  if (!pipWin && await handOff(link)) return;
  const r = applyText(link.text, 'link');
  showNote(link.note, r.warnings || []);
  updateEmpty();
}

// ---------- tabs ----------

// A tab opened from the assistant's link: Done closes it and the browser returns to the chat.
// Browsers let a page close a tab that a link opened, but not bring another tab to the front.
const openedByLink = /^#(m|note|z)=/.test(location.hash);
const key = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

async function done() {
  const request = $('#ask').value.trim();
  const ok = await copyText(donePacket(request));
  if (!ok) { toast('Copying failed: open More → Show source and copy the text by hand', 5000); return; }
  $('#ask').value = '';
  const where = ai().short;
  if (pipWin) { toast(`Copied. Press ${key}V in ${where}${request ? ' and send' : ' and add your request'}.`, 4000); return; }
  window.close();
  // Still here: the browser does not let this tab close itself (it was not opened from a link).
  setTimeout(() => toast(`Copied. Go to ${where}, press ${key}V${request ? ' and send' : ' and add your request'}.`, 5000), 250);
}

// Other board tabs follow along: whatever one tab saves, the others load.
let lastSaved = null;
window.addEventListener('storage', e => {
  if (e.key === BOARDS_KEY) { paintBoardName(); if ($('#boards').open) paintBoards(); return; }
  if (e.key !== boardKey(boardId) || !e.newValue || e.newValue === lastSaved) return;
  pushUndo();
  if (!load()) return;
  layout(); render(); $('#source').value = toMermaid(); updateReadout(); updateEmpty();
  log('board', 'Updated from another Kiertotie tab');
});

// ---------- floating board ----------

// The board floats above every window (Document Picture-in-Picture, Chrome and Edge), so it stays
// in view while you work in the Copilot tab. This tab has to stay open: closing it closes the float.
const canFloat = 'documentPictureInPicture' in window;

async function floatBoard(opts = {}) {
  if (pipWin && !opts.reset) { pipWin.focus(); return; }
  if (!canFloat) { toast('This browser cannot float a window. Chrome and Edge can.', 4000); return; }
  let w;
  // reset: the default size and place, instead of where the float was last.
  try { w = await documentPictureInPicture.requestWindow({ width: 560, height: 640, preferInitialWindowPlacement: !!opts.reset }); }
  catch (err) { toast(`The browser did not open the floating window (${err.name}).`, 4000); return; }
  for (const sheet of document.styleSheets) {
    try {
      const st = w.document.createElement('style');
      st.textContent = [...sheet.cssRules].map(r => r.cssText).join('\n');
      w.document.head.append(st);
    } catch {
      const l = Object.assign(w.document.createElement('link'), { rel: 'stylesheet', href: sheet.href });
      w.document.head.append(l);
    }
  }
  w.document.title = 'Kiertotie';
  w.document.body.className = document.body.className;
  if (document.documentElement.dataset.theme) w.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  w.document.body.classList.add('floating');
  // The readout stays here, for the Edge sidebar Copilot reading this tab.
  for (const el of [...document.body.children]) if (el.tagName !== 'SCRIPT' && !['readout', 'docked', 'handed'].includes(el.id)) w.document.body.append(el);
  pipWin = w;
  document.getElementById('docked').hidden = false;
  for (const [type, fn] of docListeners) w.document.addEventListener(type, fn);
  w.addEventListener('resize', () => render());
  w.addEventListener('pagehide', dockBoard, { once: true });
  updateFloatUI(); render(); fit();
  // The floating window gets its final size a moment after it opens: fit again once it has.
  w.requestAnimationFrame(() => fit()); setTimeout(fit, 150); setTimeout(fit, 500);
  log('board', 'Board is floating');
}

function dockBoard() {
  const w = pipWin; if (!w) return;
  const anchor = document.getElementById('docked');
  for (const el of [...w.document.body.children]) document.body.insertBefore(el, anchor);
  pipWin = null;
  anchor.hidden = true;
  updateFloatUI(); render(); fit(); setTimeout(fit, 150);
}

function updateFloatUI() {
  $('#btn-float').hidden = !canFloat || !!pipWin;
  // A link tab without a floating board: floating it is the next step, so the button stands out.
  $('#btn-float').classList.toggle('primary', openedByLink && !pipWin);
}

// A link tab hands its diagram to a floating board, if one is open, and closes itself;
// the browser then returns to the Copilot tab the link was clicked in.
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('kiertotie') : null;
if (bc) bc.addEventListener('message', ({ data }) => {
  if (!data || !pipWin) return;
  if (data.type === 'floating?') bc.postMessage({ type: 'floating', to: data.from });
  if (data.type === 'apply') {
    const r = applyText(data.text, 'link'); showNote(data.note || '', r.warnings || []); updateEmpty();
    bc.postMessage({ type: 'applied', to: data.from });
  }
});

async function handOff(link) {
  if (!bc) return false;
  const me = Math.random().toString(36).slice(2);
  const reply = type => new Promise(resolve => {
    const on = ({ data }) => { if (data && data.type === type && data.to === me) { bc.removeEventListener('message', on); resolve(true); } };
    bc.addEventListener('message', on);
    setTimeout(() => { bc.removeEventListener('message', on); resolve(false); }, 400);
  });
  const found = reply('floating'); bc.postMessage({ type: 'floating?', from: me });
  if (!await found) return false;
  const applied = reply('applied'); bc.postMessage({ type: 'apply', from: me, text: link.text, note: link.note });
  if (!await applied) return false;
  window.close();
  // Still here: the browser keeps this tab open, so say where the diagram went.
  $('#handed').hidden = false;
  return true;
}

// ---------- share and export ----------

// Links the board makes itself are compressed (#z=); assistants keep writing plain #m= links.
const b64url = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function zipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return b64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}
async function unzipText(z) {
  const stream = new Blob([unb64url(z)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}
// What a shared link carries: the diagram plus where boxes were moved by hand.
const shareText = (opts) => [toMermaid(), ...canvasLines(opts)].join('\n');
async function shareLink() { return `${BASE}#z=${await zipText(shareText({ images: false }))}`; }

const QR_MAX = 2300;
function qrSvg(text) {
  const q = qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
  const n = q.getModuleCount(), m = 4, size = n + m * 2; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code for this diagram"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

async function openShare() {
  const url = await shareLink();
  $('#share-url').value = url;
  $('#share-size').textContent = `${url.length.toLocaleString()} characters`;
  const fits = typeof qrcode === 'function' && url.length <= QR_MAX;
  $('#share-qr').innerHTML = fits ? qrSvg(url) : `<p class="muted small">${typeof qrcode === 'function' ? 'This diagram is too big for a QR code. Share the link instead.' : 'The QR code library did not load.'}</p>`;
  $('#share').showModal();
}

// Exports render the board with its colours written out, so they look the same outside this page.
function exportSvg() {
  if (sel) { sel = null; render(); }
  const all = [...boxes.values(), ...groupBoxes.values(), ...state.ink.map(inkBox)];
  if (!all.length) return null;
  const pad = 32;
  const x0 = Math.min(...all.map(b => b.x - b.w / 2)) - pad, x1 = Math.max(...all.map(b => b.x + b.w / 2)) + pad;
  const y0 = Math.min(...all.map(b => b.y - b.h / 2)) - pad, y1 = Math.max(...all.map(b => b.y + b.h / 2)) + pad;
  const src = $('#viewport'), copy = src.cloneNode(true);
  copy.removeAttribute('transform');
  const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'font-family', 'font-size', 'font-weight', 'opacity'];
  const a = [src, ...src.querySelectorAll('*')], b = [copy, ...copy.querySelectorAll('*')];
  const inline = (from, to) => from.forEach((el, i) => { const cs = getComputedStyle(el); to[i].setAttribute('style', props.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';')); to[i].removeAttribute('class'); });
  // Comments are notes for the people working on the board, so exports leave them out.
  const hits = b.filter((_, i) => ['hit', 'port', 'handle', 'ghost', 'comment', 'sel-box', 'marquee'].some(c => a[i].classList?.contains(c)));
  inline(a, b); hits.forEach(el => el.remove());
  const bg = getComputedStyle($('#board')).getPropertyValue('--bg').trim() || '#ffffff';
  const defs = $('#board defs'), defsCopy = defs.cloneNode(true);
  inline([...defs.querySelectorAll('path')], [...defsCopy.querySelectorAll('path')]);
  const head = defsCopy.outerHTML;
  const w = x1 - x0, h = y1 - y0;
  return { w, h, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" width="${w}" height="${h}">${head}<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${bg}"/>${copy.outerHTML}</svg>` };
}
function download(name, blob) {
  const a = Object.assign(doc().createElement('a'), { href: URL.createObjectURL(blob), download: name });
  doc().body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const fileBase = () => currentBoard().name.replace(/[^\w\u00C0-\uFFFF -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'diagram';
function downloadSvg() { const e = exportSvg(); if (!e) return toast('Nothing to export yet'); download(`${fileBase()}.svg`, new Blob([e.svg], { type: 'image/svg+xml' })); }
// ---------- draw.io, folders and files ----------

// draw.io: frames become containers, boxes keep their shape and colours, icons and images go in as pictures.
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const b64 = str => btoa(unescape(encodeURIComponent(str)));
const DRAWIO_SHAPES = { box: 'rounded=1;arcSize=8;', round: 'rounded=1;arcSize=25;', stadium: 'rounded=1;arcSize=50;', circle: 'ellipse;', diamond: 'rhombus;',
  cylinder: 'shape=cylinder3;boundedLbl=1;size=8;', hexagon: 'shape=hexagon;perimeter=hexagonPerimeter2;size=0.15;', subroutine: 'shape=process;', flag: 'shape=step;perimeter=stepPerimeter;',
  sticky: 'rounded=0;strokeColor=none;shadow=1;fillColor=#fff59d;', text: 'text;align=center;verticalAlign=middle;fontSize=16;fontStyle=1;', doc: 'rounded=1;arcSize=4;align=left;verticalAlign=top;spacing=10;',
  table: 'shape=table;', phone: 'rounded=1;arcSize=12;verticalAlign=top;', browser: 'rounded=1;arcSize=3;verticalAlign=top;' };
function exportDrawio() {
  if (!state.nodes.size && !state.groups.size) { toast('Nothing to export yet'); return; }
  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const cid = id => `k_${id}`;
  const origin = id => { const g = state.nodes.get(id)?.group ?? state.groups.get(id)?.parent; const gb = g && groupBoxes.get(g); return gb ? { x: gb.x - gb.w / 2, y: gb.y - gb.h / 2, parent: cid(g) } : { x: 0, y: 0, parent: '1' }; };
  const geo = (b, o) => `<mxGeometry x="${Math.round(b.x - b.w / 2 - o.x)}" y="${Math.round(b.y - b.h / 2 - o.y)}" width="${Math.round(b.w)}" height="${Math.round(b.h)}" as="geometry"/>`;
  for (const gid of [...groupBoxes.keys()].sort((a, b) => groupDepth(a) - groupDepth(b))) {
    const g = state.groups.get(gid), Z = ZONES[zoneOf(g)], c = colorsOf(g), o = origin(gid);
    const style = `rounded=1;arcSize=3;container=1;collapsible=0;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=8;fontStyle=1;dashed=${Z ? (Z.dash ? 1 : 0) : 1};` +
      `fillColor=${c.fill || 'none'};strokeColor=${c.stroke || Z?.stroke || '#999999'};`;
    cells.push(`<mxCell id="${cid(gid)}" value="${xmlEsc(g.title)}" style="${style}" vertex="1" parent="${o.parent}">${geo(groupBoxes.get(gid), o)}</mxCell>`);
  }
  for (const [id, b] of boxes) {
    const n = state.nodes.get(id), c = colorsOf(n), o = origin(id);
    let style = DRAWIO_SHAPES[n.shape] || DRAWIO_SHAPES.box, value = n.label;
    if (n.shape === 'icon' || n.shape === 'image') {
      const ic = n.shape === 'icon' && iconFor(n.icon);
      const img = ic ? `data:image/svg+xml,${b64(decodeURIComponent(ic.uri.split(',')[1]))}` : (n.src || '').replace(';base64', '');
      style = `shape=image;image=${img};imageAspect=1;verticalLabelPosition=bottom;verticalAlign=top;labelBackgroundColor=none;`;
      if (n.shape === 'image') value = '';
    }
    if (n.shape === 'table') { style = 'html=1;whiteSpace=wrap;overflow=fill;rounded=0;'; value = `<b>${xmlEsc(n.label)}</b><table border="1" style="border-collapse:collapse;width:100%">${(n.table || []).map((r, i) => `<tr>${r.map(x => `<${i ? 'td' : 'th'}>${xmlEsc(x)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`; }
    if (n.shape === 'doc') value = `<b>${xmlEsc(n.label)}</b><br>${xmlEsc(n.body || '').replace(/\n/g, '<br>')}`;
    if (c.fill && n.shape !== 'icon') style += `fillColor=${c.fill};`;
    if (c.stroke) style += `strokeColor=${c.stroke};`;
    if (c.color) style += `fontColor=${c.color};`;
    cells.push(`<mxCell id="${cid(id)}" value="${xmlEsc(value)}" style="${style}whiteSpace=wrap;html=1;" vertex="1" parent="${o.parent}">${geo(b, o)}</mxCell>`);
  }
  state.edges.forEach((e, i) => {
    if (!anchorBox(e.from) || !anchorBox(e.to)) return;
    const style = `${e.route === 'elbow' ? 'edgeStyle=orthogonalEdgeStyle;rounded=1;' : routeOf(e) === 'curved' ? 'curved=1;' : 'edgeStyle=none;'}html=1;endArrow=${e.arrow ? 'classic' : 'none'};` +
      `${e.style === 'dotted' ? 'dashed=1;' : ''}${e.style === 'thick' ? 'strokeWidth=3;' : ''}${e.color ? `strokeColor=${e.color};` : ''}`;
    cells.push(`<mxCell id="e${i}" value="${xmlEsc(e.label)}" style="${style}" edge="1" parent="1" source="${cid(e.from)}" target="${cid(e.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  });
  for (const k of state.ink.filter(x => x.kind === 'arrow')) {
    const [[x1, y1], [x2, y2]] = k.pts;
    cells.push(`<mxCell id="${k.id}" style="endArrow=classic;html=1;strokeColor=${k.color};" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${Math.round(x1)}" y="${Math.round(y1)}" as="sourcePoint"/><mxPoint x="${Math.round(x2)}" y="${Math.round(y2)}" as="targetPoint"/></mxGeometry></mxCell>`);
  }
  const xml = `<mxfile host="Kiertotie"><diagram name="${xmlEsc(currentBoard().name)}"><mxGraphModel grid="1" gridSize="10"><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
  download(`${fileBase()}.drawio`, new Blob([xml], { type: 'application/xml' }));
  if (state.ink.some(x => x.kind !== 'arrow') || state.comments.length) toast('Exported. Pen drawings and comments stay on the board only.', 4000);
}

// A board as a file: Mermaid with a title, plus the canvas lines that keep its look.
const boardFile = (name, text) => `---\ntitle: ${name}\n---\n${text}\n`;
const safeName = s => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'board';

// Save every board to a folder you pick, one .mmd file each (Chrome and Edge).
async function saveToFolder() {
  const w = pipWin || window;
  if (!w.showDirectoryPicker) { toast('This browser cannot save to a folder. Chrome and Edge can; use Download instead.', 4500); return; }
  let dir;
  try { dir = await w.showDirectoryPicker({ mode: 'readwrite', id: 'kiertotie' }); } catch { return; }
  save();
  let count = 0;
  for (const b of boardList()) {
    let text = '';
    try { text = JSON.parse(store.get(boardKey(b.id))).src; } catch { continue; }
    const fh = await dir.getFileHandle(`${safeName(b.name)}.mmd`, { create: true });
    const out = await fh.createWritable(); await out.write(boardFile(b.name, text)); await out.close();
    count++;
  }
  toast(`Saved ${count} ${count === 1 ? 'board' : 'boards'} to the folder`);
}
function downloadBoardFile() { save(); download(`${fileBase()}.mmd`, new Blob([boardFile(currentBoard().name, shareText())], { type: 'text/plain' })); }

// Open files: each Mermaid or Markdown file becomes a new board; pictures go onto this one.
function importFiles(files, p = viewCentre()) {
  for (const f of files) {
    if (f.type.startsWith('image/')) { addImage(f, p); continue; }
    if (!/\.(mmd|mermaid|md|txt)$/i.test(f.name) && f.type && !f.type.startsWith('text/')) { toast(`Can't open ${f.name}`); continue; }
    f.text().then(text => {
      const name = text.match(/^---\s*\n(?:.*\n)*?title:\s*(.+)\n/)?.[1]?.trim() || f.name.replace(/\.\w+$/, '');
      createBoard(name, text);
      toast(`Opened ${name}`);
    });
  }
}
function pickFiles() {
  const input = Object.assign(doc().createElement('input'), { type: 'file', multiple: true, accept: '.mmd,.mermaid,.md,.txt,image/*' });
  input.addEventListener('change', () => importFiles([...input.files]));
  input.click();
}

function downloadPng() {
  const e = exportSvg(); if (!e) return toast('Nothing to export yet');
  const img = new Image(), scale = 2;
  img.onload = () => {
    const c = Object.assign(document.createElement('canvas'), { width: e.w * scale, height: e.h * scale });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(blob => download(`${fileBase()}.png`, blob), 'image/png');
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(e.svg);
}

// ---------- controls ----------

function setMarkMode(on) {
  markMode = on;
  $('#btn-mark').setAttribute('aria-pressed', String(on));
  svg.classList.toggle('marking', on);
  if (on) toast('Click boxes or group titles to highlight them. Esc to stop.');
}

function updateEmpty() {
  const empty = state.nodes.size === 0 && state.groups.size === 0;
  $('#start').hidden = !empty || started;
  $('#waiting').hidden = !empty || !started;
  $('#composer').hidden = empty;
}

async function copyStarter() {
  const ok = await copyText(starterText($('#first').value.trim()));
  toast(ok ? `Instructions copied. Paste them into ${ai().short} (${key}V) and send.` : 'Copying failed.', 5000);
  return ok;
}

// Start: copy the instructions and float the board. The waiting card then shows how to finish in the chat.
let started = false;
function startLoop() {
  const copying = copyText(starterText($('#first').value.trim()));
  // Floating uses up the click, so the chat opens from its own button on the waiting card.
  // Without a float the click is still free, and the chat opens straight away.
  const floating = canFloat && !pipWin ? floatBoard() : null;
  if (!canFloat && ai().url) window.open(ai().url, 'kiertotie-chat');
  started = true; updateEmpty();
  copying.then(ok => toast(ok ? `Instructions copied. In ${ai().short}, press ${key}V and send.` : 'Copying failed: use Copy the instructions again.', 6000));
  return floating;
}

// Tidy: boxes go back to the automatic layout. An empty frame keeps its place, since it has nothing to wrap.
function tidy() {
  for (const id of [...state.pos.keys()]) {
    const empty = state.groups.has(id) && ![...state.nodes.values()].some(n => n.group === id) && ![...state.groups.values()].some(g => g.parent === id);
    if (!empty) state.pos.delete(id);
  }
}

function closeMore() { $('#more').open = false; }

$('#btn-mark').addEventListener('click', () => setMarkMode(!markMode));
$('#rail').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.pop) { openPop(b.dataset.pop); return; }
  setTool(tool === b.dataset.tool ? 'select' : b.dataset.tool);
  if (tool !== 'select') toast('Click the board to place it');
});
$('#shape-pop').addEventListener('click', e => {
  const b = e.target.closest('[data-shape]'); if (!b) return;
  setTool('shape', b.dataset.shape); toast('Click the board to place it');
});
$('#icon-grid').addEventListener('click', e => { const b = e.target.closest('[data-icon]'); if (b) pickIcon(b.dataset.icon); });
$('#icon-tabs').addEventListener('click', e => { const b = e.target.closest('[data-pack]'); if (!b) return; iconPack = b.dataset.pack; $('#icon-q').value = ''; renderIconGrid(); });
$('#icon-q').addEventListener('input', renderIconGrid);
$('#icon-q').addEventListener('keydown', e => {
  if (e.key === 'Escape') closePops();
  if (e.key === 'Enter') { const b = $('#icon-grid [data-icon]'); if (b) pickIcon(b.dataset.icon); }
});
$('#ctx').addEventListener('click', ctxClick);
$('#template-list').addEventListener('click', e => { const b = e.target.closest('[data-tpl]'); if (b) useTemplate(b.dataset.tpl); });
$('#start-template').addEventListener('click', () => openPop('template'));
$('#style-picks').addEventListener('click', e => { const b = e.target.closest('[data-bstyle]'); if (b) { e.stopPropagation(); setBoardStyle(b.dataset.bstyle); } });
$('#board-name').addEventListener('click', openBoards);
$('#more').addEventListener('toggle', () => { if ($('#more').open) { paintStyles(); paintToggles(); } });
function paintToggles() {
  $('#menu-snap').setAttribute('aria-checked', String(snapOn));
  $('#menu-minimap').setAttribute('aria-checked', String(miniOn));
}
$('#btn-redo').addEventListener('click', redo);
function paintScreenPop() {
  $('#screen-presets').innerHTML = Object.entries(SCREEN_PRESETS).map(([k, p]) => `<button role="radio" data-preset="${k}" aria-checked="${k === screenPreset}">${p.name}</button>`).join('');
  $('#piece-list').innerHTML = Object.entries(UI_KINDS).map(([k, u]) => `<button data-piece="${k}">${u.name}</button>`).join('');
}
$('#screen-pop').addEventListener('click', e => {
  const pr = e.target.closest('[data-preset]'), dv = e.target.closest('[data-device]'), pc = e.target.closest('[data-piece]');
  if (pr) { screenPreset = pr.dataset.preset; paintScreenPop(); }
  if (dv) { closePops(); placeScreen(dv.dataset.device); }
  if (pc) addPiece(pc.dataset.piece);
});
$('#draw-pop').addEventListener('click', e => {
  const t = e.target.closest('[data-tool]'), c = e.target.closest('[data-pen-color]');
  if (t) { setTool(t.dataset.tool); paintDrawColors(); $('#draw-pop').hidden = false; return; }
  if (c) { if (tool === 'hl') hlColor = c.dataset.penColor; else penColor = c.dataset.penColor; if (!['pen', 'hl'].includes(tool)) setTool('pen'); paintDrawColors(); $('#draw-pop').hidden = false; }
});
function paintDrawColors() {
  const list = tool === 'hl' ? HL_COLORS : INK_COLORS, cur = tool === 'hl' ? hlColor : penColor;
  $('#draw-colors').innerHTML = list.map(c => `<button class="swatch" data-pen-color="${c}" aria-pressed="${c === cur}" style="--sw:${c}" title="${c}"></button>`).join('');
  for (const b of doc().querySelectorAll('#draw-pop [data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
}
$('#minimap').addEventListener('pointerdown', e => {
  e.preventDefault(); miniMove(e);
  const el = $('#minimap'); el.setPointerCapture(e.pointerId);
  const mv = ev => miniMove(ev), up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
});
// Files dropped on the board: pictures land where they are dropped, Mermaid files open as boards.
$('.board-wrap').addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
$('.board-wrap').addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); importFiles([...e.dataTransfer.files], toWorld(e));
});
$('#boards-list').addEventListener('click', boardsClick);
$('#boards-new').addEventListener('click', () => { $('#boards').close(); createBoard(); toast('New board'); });
$('#boards-template').addEventListener('click', () => { $('#boards').close(); openPop('template'); });
$('#boards-close').addEventListener('click', () => $('#boards').close());
$('#ctx').addEventListener('change', ctxChange);
onDoc('pointerdown', e => { if (!e.target.closest?.('.pop, #rail, #more, #start, .boards')) closePops(); });
$('#btn-undo').addEventListener('click', undo);
$('#btn-done').addEventListener('click', done);
$('#ask').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(); } });
$('#first').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startLoop(); } });
$('#btn-start').addEventListener('click', startLoop);
$('#wait-copy').addEventListener('click', copyStarter);
$('#wait-back').addEventListener('click', startOver);
$('#share-copy').addEventListener('click', () => copyText($('#share-url').value).then(ok => { $('#share-copy').textContent = ok ? 'Copied ✓' : 'Copy failed'; setTimeout(() => { $('#share-copy').textContent = 'Copy link'; }, 1500); }));
$('#share-close').addEventListener('click', () => $('#share').close());
$('#docked-reset').addEventListener('click', async () => {
  if (pipWin) { pipWin.close(); for (let i = 0; i < 20 && pipWin; i++) await new Promise(r => setTimeout(r, 25)); }
  floatBoard({ reset: true });
});
$('#btn-theme').addEventListener('click', () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]));

// Start over: delete the diagram, after asking, and go back to the start card. Undo still brings it back.
function startOver() {
  const hasDiagram = state.nodes.size || state.groups.size;
  if (hasDiagram && !(pipWin || window).confirm('Clear this board and start over?')) return;
  pushUndo(); parseInto('flowchart LR', { replace: true }); state.pos.clear(); showNote('');
  started = false; commit('board', 'Started over'); updateEmpty();
}

// Day and night: follow the system, or pick light or dark. Applied to the floating window too.
const THEMES = ['system', 'light', 'dark'];
const THEME_KEY = 'kiertotie.theme';
let theme = (() => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } })() || 'system';
function setTheme(t) {
  theme = THEMES.includes(t) ? t : 'system';
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
  for (const d of [document, pipWin && pipWin.document].filter(Boolean)) {
    if (theme === 'system') delete d.documentElement.dataset.theme; else d.documentElement.dataset.theme = theme;
  }
  $('#btn-theme').textContent = { system: '◐ Auto', light: '☀ Day', dark: '☾ Night' }[theme];
  $('#btn-theme').title = `Theme: ${{ system: 'follows your system', light: 'day', dark: 'night' }[theme]}. Click to change.`;
  render();
}
$('#ai-chips').addEventListener('click', e => { const b = e.target.closest('[data-ai]'); if (b) setAi(b.dataset.ai); });
$('#start-sample').addEventListener('click', () => { applyText(SAMPLE, 'sample'); updateEmpty(); });
$('#note-close').addEventListener('click', () => showNote(''));
$('#more').addEventListener('click', e => {
  const pick = e.target.closest('[data-ai]'); if (pick) { setAi(pick.dataset.ai); closeMore(); toast(`Assistant: ${ai().name}`); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  closeMore();
  if (act === 'boards') openBoards();
  if (act === 'snap') { snapOn = !snapOn; store.set(SNAP_KEY, snapOn ? 'on' : 'off'); paintToggles(); toast(snapOn ? 'Snapping to the grid' : 'Snapping off'); }
  if (act === 'minimap') { miniOn = !miniOn; store.set(MINI_KEY, miniOn ? 'on' : 'off'); paintToggles(); render(); }
  if (act === 'steps') numberSteps();
  if (act === 'legend') addLegend();
  if (act === 'nosteps') clearSteps();
  if (act === 'drawio') exportDrawio();
  if (act === 'mmd') downloadBoardFile();
  if (act === 'folder') saveToFolder();
  if (act === 'open') pickFiles();
  if (act === 'templates') openPop('template');
  if (act === 'tidy') { pushUndo(); tidy(); commit('board', 'Tidied up the layout'); fit(); }
  if (act === 'fit') fit();
  if (act === 'starter') copyStarter();
  if (act === 'share') openShare();
  if (act === 'png') downloadPng();
  if (act === 'svg') downloadSvg();
  if (act === 'mermaid') copyText(toMermaid()).then(ok => toast(ok ? 'Mermaid copied' : 'Copying failed'));
  if (act === 'source') { document.body.classList.toggle('show-panel'); render(); }
  if (act === 'new') startOver();
});
onDoc('click', e => { if (!e.target.closest('#more')) closeMore(); });

let sourceTimer;
$('#source').addEventListener('input', () => {
  clearTimeout(sourceTimer);
  sourceTimer = setTimeout(() => {
    pushUndo();
    const { warnings } = parseInto($('#source').value, { replace: true });
    $('#source-msg').textContent = warnings.length ? warnings.slice(0, 3).join(' · ') : '';
    commit('source', 'Edited the source', { fromSource: true });
    updateEmpty();
  }, 450);
});

// Pasting a diagram anywhere also works, for when a link comes out broken.
onDoc('paste', () => setTimeout(updateEmpty, 0));
window.addEventListener('hashchange', readHash);
window.addEventListener('resize', () => render());
$('#btn-float').addEventListener('click', () => floatBoard());
$('#docked-back').addEventListener('click', () => pipWin && pipWin.close());

const SAMPLE = `flowchart LR
  user([Consultant])
  subgraph onprem[On-premises]
    ad[Active Directory]
    sync[Entra Connect]
  end
  subgraph azure[Azure subscription]
    entra[Entra ID]
    app[Web app]
    db[(SQL database)]
  end
  user -->|signs in| app
  ad --> sync -->|syncs groups| entra
  app -->|checks group| entra
  app --> db`;

// ---------- start ----------

(function start() {
  initBoards();
  load();
  paintBoardName();
  paintStyles();
  layout();
  $('#source').value = toMermaid();
  updateReadout();
  updateFloatUI();
  setTheme(theme);
  paintAi();
  fit();
  updateEmpty();
  readHash();
})();
