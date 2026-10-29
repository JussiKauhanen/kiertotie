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

const state = { dir: 'LR', nodes: new Map(), groups: new Map(), edges: [], pos: new Map(), classDefs: new Map() };
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

function readNode(s, i) {
  i += s.slice(i).match(/^\s*/)[0].length;
  const m = s.slice(i).match(ID_RE);
  if (!m) return null;
  const node = { id: m[0], end: i + m[0].length };
  const sh = readShape(s, node.end);
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
function colorVars(item) {
  const c = colorsOf(item), v = [];
  if (c.fill) v.push(`--nf:${c.fill}`);
  if (c.stroke) v.push(`--ns:${c.stroke}`);
  const t = c.color || (c.fill && textOn(c.fill));
  if (t) v.push(`--nt:${t}`);
  return v.length ? ` style="${esc(v.join(';'))}"` : '';
}

// Parses text into the current state. replace: start from an empty diagram (manual positions are kept).
function parseInto(text, { replace }) {
  if (replace) { state.nodes = new Map(); state.groups = new Map(); state.edges = []; state.classDefs = new Map(); }
  const warnings = [];
  const stack = [];
  const fresh = new Set();
  const lines = text.split(/\n|;/);

  const touch = spec => {
    let n = state.nodes.get(spec.id);
    if (!n) { n = { id: spec.id, label: spec.id, shape: 'box', group: null, marked: false, implicit: true }; state.nodes.set(spec.id, n); fresh.add(spec.id); }
    if (spec.shape) { n.label = spec.label || spec.id; n.shape = spec.shape; n.implicit = false; }
    const g = stack[stack.length - 1] || null;
    if (g && (fresh.has(spec.id) || spec.shape || !n.group)) n.group = g;
    if (spec.cls === 'marked') n.marked = true;
    else if (spec.cls) n.cls = spec.cls;
  };
  const addEdge = (from, to, label, style, arrow) => {
    const e = state.edges.find(x => x.from === from && x.to === to);
    if (e) Object.assign(e, { label, style, arrow });
    else state.edges.push({ from, to, label, style, arrow });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    let m;
    if ((m = line.match(/^(?:flowchart|graph)\s*(LR|RL|TD|TB|BT)?\s*$/i))) { state.dir = (m[1] || 'TD').toUpperCase().replace('TB', 'TD'); continue; }
    if ((m = line.match(/^classDef\s+([\w-]+)\s+(.+)$/))) { if (m[1] !== 'marked') state.classDefs.set(m[1], styleProps(m[2])); continue; }
    if ((m = line.match(/^style\s+([\w\u00C0-\uFFFF-]+)\s+(.+)$/))) {
      const item = state.nodes.get(m[1]) || state.groups.get(m[1]);
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
        const item = state.nodes.get(id) || state.groups.get(id);
        if (!item) continue;
        if (m[2] === 'marked') item.marked = true; else item.cls = m[2];
      }
      continue;
    }
    if ((m = line.match(/^(mark|unmark)\s+(.+)$/i))) {
      const on = m[1].toLowerCase() === 'mark';
      const ids = /^all$/i.test(m[2].trim()) ? [...state.nodes.keys(), ...state.groups.keys()] : splitIds(m[2]);
      for (const id of ids) { const item = state.nodes.get(id) || state.groups.get(id); if (item) item.marked = on; }
      continue;
    }
    if ((m = line.match(/^(?:remove|delete)\s+(.+)$/i))) {
      const em = m[1].match(/^([\wÀ-￿-]+)\s*-[-.=]*>?\s*([\wÀ-￿-]+)$/);
      if (em) state.edges = state.edges.filter(e => !(e.from === em[1] && e.to === em[2]));
      else for (const id of splitIds(m[1])) removeItem(id);
      continue;
    }
    if ((m = line.match(/^rename\s+([\wÀ-￿-]+)\s*:\s*(.+)$/i))) {
      const item = state.nodes.get(m[1]) || state.groups.get(m[1]);
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

  // An implicit node with a group's id is a link to that group, not a box.
  for (const [id, n] of state.nodes) if (n.implicit && state.groups.has(id)) state.nodes.delete(id);
  for (const g of state.groups.values()) if (g.parent && !state.groups.has(g.parent)) g.parent = null;
  for (const n of state.nodes.values()) if (n.group && !state.groups.has(n.group)) n.group = null;
  for (const id of [...state.pos.keys()]) if (!state.nodes.has(id)) state.pos.delete(id);
  return { warnings };
}

function removeItem(id) {
  if (state.nodes.delete(id)) state.pos.delete(id);
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
  const decl = n => { const [o, c] = WRAP[n.shape] || WRAP.box; return `${n.id}${o}${q(n.label)}${c}`; };
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
  for (const x of items) if (x.style && Object.keys(x.style).length) L.push(`  style ${x.id} ${propsText(x.style)}`);
  const marked = items.filter(x => x.marked).map(x => x.id);
  if (marked.length) {
    L.push('  classDef marked fill:#ffe066,stroke:#e0a800,stroke-width:2px');
    L.push(`  class ${marked.join(',')} marked`);
  }
  return L.join('\n');
}

// ---------- layout ----------

const measure = document.createElement('canvas').getContext('2d');
function textWidth(s, size = 14, weight = 500) {
  measure.font = `${weight} ${size}px ${FONT}`;
  return measure.measureText(s).width;
}

function nodeSize(n) {
  const lines = n.label.split('\n');
  const tw = Math.max(...lines.map(l => textWidth(l)));
  let w = Math.max(100, tw + 32), h = Math.max(44, lines.length * 18 + 24);
  if (n.shape === 'circle') w = h = Math.max(w, h, 64);
  else if (n.shape === 'diamond') { w = Math.max(110, tw * 1.35 + 52); h = Math.max(64, lines.length * 18 + 46); }
  else if (n.shape === 'hexagon' || n.shape === 'flag') w += 24;
  else if (n.shape === 'cylinder') h += 14;
  return { w, h };
}

function chainOf(id) {
  const c = [];
  let g = state.nodes.get(id)?.group;
  while (g && !c.includes(g)) { c.unshift(g); g = state.groups.get(g)?.parent; }
  return c;
}

function layout() {
  const ids = [...state.nodes.keys()];
  const size = new Map(ids.map(id => [id, nodeSize(state.nodes.get(id))]));
  const out = new Map(ids.map(id => [id, []]));
  for (const e of state.edges) if (e.from !== e.to && out.has(e.from) && out.has(e.to)) out.get(e.from).push(e.to);

  // Break cycles, then longest-path ranks.
  const color = new Map(), dag = [];
  const visit = u => {
    color.set(u, 1);
    for (const v of out.get(u)) { if (color.get(v) === 1) continue; dag.push([u, v]); if (!color.get(v)) visit(v); }
    color.set(u, 2);
  };
  ids.forEach(id => color.get(id) || visit(id));
  const rank = new Map(ids.map(id => [id, 0]));
  for (let k = 0; k < ids.length; k++) {
    let changed = false;
    for (const [u, v] of dag) if (rank.get(v) < rank.get(u) + 1) { rank.set(v, rank.get(u) + 1); changed = true; }
    if (!changed) break;
  }
  const layers = [];
  ids.forEach(id => (layers[rank.get(id)] ||= []).push(id));
  for (let r = 0; r < layers.length; r++) layers[r] ||= [];

  const chains = new Map(ids.map(id => [id, chainOf(id)]));
  const preds = new Map(ids.map(id => [id, []])), succs = new Map(ids.map(id => [id, []]));
  for (const [u, v] of dag) { succs.get(u).push(v); preds.get(v).push(u); }
  const index = new Map();
  const reindex = () => layers.forEach(l => l.forEach((id, i) => index.set(id, i)));
  reindex();
  const order = (layer, nbrs) => {
    const bary = new Map(layer.map(id => {
      const ns = nbrs.get(id).filter(n => index.has(n));
      return [id, ns.length ? ns.reduce((s, n) => s + index.get(n), 0) / ns.length : index.get(id)];
    }));
    const gsum = new Map(), gcnt = new Map();
    for (const id of layer) for (const g of chains.get(id)) { gsum.set(g, (gsum.get(g) || 0) + bary.get(id)); gcnt.set(g, (gcnt.get(g) || 0) + 1); }
    const gavg = g => gsum.get(g) / gcnt.get(g);
    layer.sort((a, b) => {
      const ca = chains.get(a), cb = chains.get(b);
      for (let i = 0; ; i++) {
        const ga = ca[i], gb = cb[i];
        if (ga && ga === gb) continue;
        const va = ga ? gavg(ga) : bary.get(a), vb = gb ? gavg(gb) : bary.get(b);
        return va - vb || ((ga || a) < (gb || b) ? -1 : 1);
      }
    });
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let r = 1; r < layers.length; r++) { order(layers[r], preds); reindex(); }
    for (let r = layers.length - 2; r >= 0; r--) { order(layers[r], succs); reindex(); }
  }
  if (layers[0]) { order(layers[0], succs); reindex(); }

  const horiz = state.dir === 'LR' || state.dir === 'RL';
  const main = id => horiz ? size.get(id).w : size.get(id).h;
  const cross = id => horiz ? size.get(id).h : size.get(id).w;
  const GAP_MAIN = horiz ? 90 : 70, GAP_CROSS = horiz ? 26 : 34, GAP_BAND = 40;
  // Cross-axis padding of a group box: the title side gets more room in left-to-right layouts.
  const PAD_START = horiz ? 30 : 18, PAD_END = 18;

  // Main axis: one slot per rank.
  const along = new Map();
  let m = 0;
  for (const layer of layers) {
    const thick = Math.max(0, ...layer.map(main));
    layer.forEach(id => along.set(id, m + thick / 2));
    m += thick + GAP_MAIN;
  }

  // Cross axis: every group is a band that runs through all ranks, so group boxes never overlap.
  // Within a group, its direct boxes share one band and each subgroup gets a band of its own.
  const rankOf = id => rank.get(id);
  const members = new Map();
  for (const id of ids) for (const g of chains.get(id)) (members.get(g) || members.set(g, []).get(g)).push(id);
  const avgIndex = list => list.reduce((s, id) => s + index.get(id) / Math.max(1, layers[rankOf(id)].length), 0) / list.length;
  const bandsMemo = new Map();
  const bandsOf = gid => {
    if (bandsMemo.has(gid)) return bandsMemo.get(gid);
    const bands = [];
    const direct = ids.filter(id => (state.nodes.get(id).group || null) === gid);
    if (direct.length) {
      const per = new Map();
      for (const id of direct) (per.get(rankOf(id)) || per.set(rankOf(id), []).get(rankOf(id))).push(id);
      let size = 0;
      for (const list of per.values()) size = Math.max(size, list.reduce((s, id) => s + cross(id), 0) + GAP_CROSS * (list.length - 1));
      bands.push({ kind: 'direct', per, size, key: avgIndex(direct) });
    }
    for (const g of state.groups.values()) {
      if ((g.parent || null) !== gid || !members.has(g.id)) continue;
      bands.push({ kind: 'group', id: g.id, size: PAD_START + innerSize(g.id) + PAD_END, key: avgIndex(members.get(g.id)) });
    }
    bands.sort((a, b) => a.key - b.key);
    bandsMemo.set(gid, bands);
    return bands;
  };
  const innerSize = gid => { const b = bandsOf(gid); return b.reduce((s, x) => s + x.size, 0) + GAP_BAND * Math.max(0, b.length - 1); };
  const across = new Map();
  const place = (gid, offset) => {
    let off = offset;
    for (const band of bandsOf(gid)) {
      if (band.kind === 'direct') {
        for (const list of band.per.values()) {
          list.sort((a, b) => index.get(a) - index.get(b));
          const used = list.reduce((s, id) => s + cross(id), 0) + GAP_CROSS * (list.length - 1);
          let c = off + (band.size - used) / 2;
          for (const id of list) { across.set(id, c + cross(id) / 2); c += cross(id) + GAP_CROSS; }
        }
      } else place(band.id, off + PAD_START);
      off += band.size + GAP_BAND;
    }
  };
  place(null, -innerSize(null) / 2);

  const result = new Map();
  for (const id of ids) {
    const [x, y] = horiz ? [along.get(id), across.get(id)] : [across.get(id), along.get(id)];
    result.set(id, { x: state.dir === 'RL' ? -x : x, y: state.dir === 'BT' ? -y : y });
  }

  boxes = new Map();
  for (const id of ids) {
    const p = state.pos.get(id) || result.get(id);
    boxes.set(id, { ...p, ...size.get(id), shape: state.nodes.get(id).shape });
  }
  computeGroupBoxes();
}

function computeGroupBoxes() {
  groupBoxes = new Map();
  const depth = g => { let d = 0, p = state.groups.get(g)?.parent; while (p && d < 20) { d++; p = state.groups.get(p)?.parent; } return d; };
  const gs = [...state.groups.keys()].sort((a, b) => depth(b) - depth(a));
  for (const gid of gs) {
    const rects = [];
    for (const n of state.nodes.values()) if (n.group === gid && boxes.has(n.id)) rects.push(boxes.get(n.id));
    for (const c of state.groups.values()) if (c.parent === gid && groupBoxes.has(c.id)) rects.push(groupBoxes.get(c.id));
    if (!rects.length) continue;
    const pad = 18, top = 30;
    const x0 = Math.min(...rects.map(r => r.x - r.w / 2)) - pad, x1 = Math.max(...rects.map(r => r.x + r.w / 2)) + pad;
    const y0 = Math.min(...rects.map(r => r.y - r.h / 2)) - top, y1 = Math.max(...rects.map(r => r.y + r.h / 2)) + pad;
    groupBoxes.set(gid, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 });
  }
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
    default: return `<rect class="node-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`;
  }
}

function textSvg(label, dy = 0) {
  const lines = label.split('\n');
  const start = -(lines.length - 1) * 9 + dy;
  return `<text text-anchor="middle" dominant-baseline="central">${lines.map((l, i) => `<tspan x="0" y="${start + i * 18}">${esc(l)}</tspan>`).join('')}</text>`;
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
  const depth = g => { let d = 0, p = state.groups.get(g)?.parent; while (p && d < 20) { d++; p = state.groups.get(p)?.parent; } return d; };
  for (const gid of [...groupBoxes.keys()].sort((a, b) => depth(a) - depth(b))) {
    const g = state.groups.get(gid), b = groupBoxes.get(gid);
    const cls = ['group', g.marked && 'marked', sel?.type === 'group' && sel.id === gid && 'sel'].filter(Boolean).join(' ');
    html += `<g class="${cls}" data-group="${esc(gid)}"${colorVars(g)}><rect x="${b.x - b.w / 2}" y="${b.y - b.h / 2}" width="${b.w}" height="${b.h}" rx="10"/>` +
      `<text x="${b.x - b.w / 2 + 12}" y="${b.y - b.h / 2 + 18}">${esc(g.title)}</text></g>`;
  }
  // Labels already placed, and the boxes, so labels can step aside from them.
  const taken = [...boxes.values()].map(b => ({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, y0: b.y - b.h / 2, y1: b.y + b.h / 2 }));
  const hits = r => taken.some(t => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
  state.edges.forEach((e, i) => {
    const a = anchorBox(e.from), b = anchorBox(e.to);
    if (!a || !b) return;
    // A link that also runs the other way bends to its own side, so the pair doesn't overlap.
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const bulge = state.edges.some(o => o.from === e.to && o.to === e.from) ? 34 : 0;
    const c = { x: (a.x + b.x) / 2 + nx * bulge, y: (a.y + b.y) / 2 + ny * bulge };
    const s = clip(a, c.x, c.y), t = clip(b, c.x, c.y);
    const at = u => ({ x: (1 - u) ** 2 * s.x + 2 * (1 - u) * u * c.x + u * u * t.x, y: (1 - u) ** 2 * s.y + 2 * (1 - u) * u * c.y + u * u * t.y });
    const isSel = sel?.type === 'edge' && sel.i === i;
    const d = bulge ? `M${s.x},${s.y} Q${c.x},${c.y} ${t.x},${t.y}` : `M${s.x},${s.y} L${t.x},${t.y}`;
    const marker = e.arrow ? ` marker-end="url(#${isSel ? 'arrow-sel' : 'arrow'})"` : '';
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
    html += `<g class="edge ${e.style}${isSel ? ' sel' : ''}" data-edge="${i}"><path class="hit" d="${d}"/><path class="line" d="${d}"${marker}/>${label}</g>`;
  });
  for (const [id, b] of boxes) {
    const n = state.nodes.get(id);
    const cls = ['node', n.marked && 'marked', sel?.type === 'node' && sel.id === id && 'sel', flash.has(id) && `flash-${flash.get(id)}`].filter(Boolean).join(' ');
    html += `<g class="${cls}" data-node="${esc(id)}" transform="translate(${b.x},${b.y})"${colorVars(n)}>${shapeSvg(b)}${textSvg(n.label, n.shape === 'cylinder' ? 4 : 0)}</g>`;
  }
  if (drag?.kind === 'connect' && drag.to) {
    const a = boxes.get(drag.from);
    html += `<path class="ghost" d="M${a.x},${a.y} L${drag.to.x},${drag.to.y}"/>`;
  }
  vp.innerHTML = html;
  updateEmpty();
}

function fit() {
  const all = [...boxes.values(), ...groupBoxes.values()];
  const svg = $('#board'), W = svg.clientWidth, H = svg.clientHeight;
  if (!all.length) { view = { x: W / 2, y: H / 2, k: 1 }; render(); return; }
  const x0 = Math.min(...all.map(b => b.x - b.w / 2)), x1 = Math.max(...all.map(b => b.x + b.w / 2));
  const y0 = Math.min(...all.map(b => b.y - b.h / 2)), y1 = Math.max(...all.map(b => b.y + b.h / 2));
  const k = Math.min(1.4, (W - 80) / (x1 - x0 || 1), (H - 80) / (y1 - y0 || 1));
  view = { k, x: W / 2 - (x0 + x1) / 2 * k, y: H / 2 - (y0 + y1) / 2 * k };
  render();
}

// ---------- changes ----------

const snapshot = () => JSON.stringify({ src: toMermaid(), pos: [...state.pos] });
function pushUndo(snap = snapshot()) {
  if (undoStack[undoStack.length - 1] !== snap) undoStack.push(snap);
  if (undoStack.length > 100) undoStack.shift();
}
function undo() {
  const snap = undoStack.pop();
  if (!snap) { toast('Nothing to undo'); return; }
  const { src, pos } = JSON.parse(snap);
  parseInto(src, { replace: true });
  state.pos = new Map(pos);
  commit('undo', 'Undid the last change');
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
  src = src.trim();
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

function save() {
  lastSaved = JSON.stringify({ src: toMermaid(), pos: [...state.pos] });
  try { localStorage.setItem(STORE_KEY, lastSaved); } catch { /* storage unavailable */ }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    lastSaved = raw;
    const { src, pos } = JSON.parse(raw);
    parseInto(src, { replace: true });
    state.pos = new Map(pos || []);
    return state.nodes.size > 0;
  } catch { return false; }
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
    ...[...state.nodes.values()].map(n => `Box ${names.get(n.id)} (${n.id}, ${n.shape})${n.group ? ` in ${names.get(n.group)}` : ''}.`),
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

svg.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  closeEditor(true);
  const p = toWorld(e);
  const nodeEl = e.target.closest('[data-node]'), groupEl = e.target.closest('[data-group]'), edgeEl = e.target.closest('[data-edge]');
  const key = nodeEl ? `n:${nodeEl.dataset.node}` : edgeEl ? `e:${edgeEl.dataset.edge}` : groupEl ? `g:${groupEl.dataset.group}` : 'empty';
  const now = performance.now();
  const isDouble = now - lastDown.t < 400 && key === lastDown.key && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
  lastDown = isDouble ? { t: 0, key: '' } : { t: now, key, x: e.clientX, y: e.clientY };
  if (isDouble && !markMode) { e.preventDefault(); doubleClick(key, p); return; }
  if (nodeEl) {
    const id = nodeEl.dataset.node;
    if (markMode) { toggleMark(state.nodes.get(id), 'box'); return; }
    select({ type: 'node', id });
    const b = boxes.get(id);
    drag = e.shiftKey ? { kind: 'connect', from: id, to: null } : { kind: 'move', ids: [id], start: [{ x: b.x, y: b.y }], p0: p, snap: snapshot(), moved: false };
  } else if (edgeEl) {
    select({ type: 'edge', i: +edgeEl.dataset.edge });
  } else if (groupEl) {
    const id = groupEl.dataset.group;
    if (markMode) { toggleMark(state.groups.get(id), 'group'); return; }
    select({ type: 'group', id });
    const ids = descendantsOf(id);
    drag = { kind: 'move', ids, start: ids.map(n => ({ x: boxes.get(n).x, y: boxes.get(n).y })), p0: p, snap: snapshot(), moved: false, group: id };
  } else {
    select(null);
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  }
  svg.setPointerCapture(e.pointerId);
});

svg.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.kind === 'pan') { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; render(); return; }
  const p = toWorld(e);
  if (drag.kind === 'connect') { drag.to = p; render(); return; }
  const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
  if (!drag.moved && Math.hypot(dx, dy) * view.k < 3) return;
  drag.moved = true;
  drag.ids.forEach((id, i) => {
    const pos = { x: drag.start[i].x + dx, y: drag.start[i].y + dy };
    state.pos.set(id, pos);
    Object.assign(boxes.get(id), pos);
  });
  computeGroupBoxes();
  render();
});

svg.addEventListener('pointerup', e => {
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.kind === 'connect') {
    const target = doc().elementFromPoint(e.clientX, e.clientY)?.closest('[data-node],[data-group]');
    const to = target?.dataset.node || target?.dataset.group;
    if (to && to !== d.from) {
      pushUndo();
      if (!state.edges.some(x => x.from === d.from && x.to === to)) state.edges.push({ from: d.from, to, label: '', style: 'solid', arrow: true });
      commit('board', `Linked ${d.from} → ${to}`);
    } else render();
  } else if (d.kind === 'move' && d.moved) {
    pushUndo(d.snap);
    save();
    log('board', `Moved ${d.group ? `group ${d.group}` : d.ids[0]}`);
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
  else {
    let k = state.nodes.size + 1;
    while (state.nodes.has(`n${k}`)) k++;
    const id = `n${k}`;
    pushUndo();
    state.nodes.set(id, { id, label: 'New box', shape: 'box', group: null, marked: false });
    state.pos.set(id, p);
    commit('board', `Added ${id}`);
    sel = { type: 'node', id };
    openEditor(sel);
  }
}

let editor = null;
function openEditor(target) {
  closeEditor(true);
  let text, b;
  if (target.type === 'node') { text = state.nodes.get(target.id).label; b = boxes.get(target.id); }
  else if (target.type === 'group') { text = state.groups.get(target.id).title; const g = groupBoxes.get(target.id); b = { x: g.x, y: g.y - g.h / 2 + 18, w: Math.max(160, g.w * 0.6), h: 30 }; }
  else {
    const e = state.edges[target.i], a = anchorBox(e.from), c = anchorBox(e.to);
    text = e.label; b = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2, w: 160, h: 30 };
  }
  const ta = document.createElement('textarea');
  ta.className = 'editor'; ta.value = text;
  const w = Math.max(120, b.w * view.k), h = Math.max(32, b.h * view.k);
  Object.assign(ta.style, { left: `${view.x + b.x * view.k - w / 2}px`, top: `${view.y + b.y * view.k - h / 2}px`, width: `${w}px`, height: `${h}px` });
  $('.board-wrap').append(ta);
  ta.focus(); ta.select();
  editor = { ta, target };
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); closeEditor(true); }
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
  const item = target.type === 'node' ? state.nodes.get(target.id) : target.type === 'group' ? state.groups.get(target.id) : state.edges[target.i];
  if (!item) return;
  const field = target.type === 'node' ? 'label' : target.type === 'group' ? 'title' : 'label';
  if (item[field] === value || (!value && field !== 'label')) return;
  pushUndo();
  item[field] = value || (target.type === 'node' ? item.id : '');
  commit('board', `Edited ${target.type === 'edge' ? `link ${item.from} → ${item.to}` : target.id}`);
}

function deleteSelection() {
  if (!sel) return;
  pushUndo();
  if (sel.type === 'edge') { const e = state.edges[sel.i]; state.edges.splice(sel.i, 1); commit('board', `Removed link ${e.from} → ${e.to}`); }
  else { removeItem(sel.id); commit('board', `Removed ${sel.id}`); }
  sel = null; render();
}

const typing = el => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);

onDoc('keydown', e => {
  if (typing(doc().activeElement)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
  else if (e.key === 'Escape') { select(null); if (markMode) setMarkMode(false); }
  else if (!mod && e.key.toLowerCase() === 'm') setMarkMode(!markMode);
  else if (!mod && e.key.toLowerCase() === 'f') fit();
});

const looksLikeDiagram = text => /-->|---|==>|-\.->|^\s*(flowchart|graph|subgraph)\b|^\s*(remove|delete|rename|mark|unmark)\s+\S/im.test(text);

onDoc('paste', e => {
  if (typing(e.target)) return;
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!looksLikeDiagram(text) && !/\[|\(/.test(text)) { toast('That paste does not look like a diagram'); return; }
  e.preventDefault();
  applyText(text, 'paste');
});

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
- Boundaries: subgraph azure[Azure subscription] ... end.
- Colours: style web fill:#dbeafe,stroke:#2563eb (fill, stroke and color only), or classDef blue fill:#dbeafe,stroke:#2563eb plus class web,api blue.
- Keep the ids the diagram already has. "class x marked" means I highlighted x: my request is about those.

In the link, put ; between lines and percent-encode everything else, in the note too: space %20, > %3E, | %7C, [ %5B, ] %5D, ( %28, ) %29, { %7B, } %7D, " %22, & %26, # %23. Example:
[Open in Kiertotie](${exampleLink()})`;

function starterText(request = '') {
  return `You are my diagram assistant. I draw on the Kiertotie board at ${BASE}
You can't open the board yourself: you answer with a link that I click, and the board shows the diagram.
Later I paste the diagram back from the board, with my highlights and my next request.

${RULES()}

My first request: ${request}`;
}

// After the starter, a paste carries only the data: the diagram, highlights and the request.
function donePacket(request = '') {
  const marked = markedItems();
  const names = marked.map(x => `${x.id} (${(x.label || x.title).replace(/\n/g, ' ')})`);
  return `My Kiertotie diagram now${marked.length ? `, with ${names.join(', ')} highlighted` : ''}:

\`\`\`mermaid
${toMermaid()}
\`\`\`

Reply in the same Kiertotie format.
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
  else return null;
  return { note: note.trim(), text: decode(m) };
}

async function readHash() {
  const link = parseHash(location.hash.slice(1));
  if (!link) return;
  history.replaceState(null, '', BASE);
  if (!pipWin && await handOff(link)) return;
  const r = applyText(link.text, 'link');
  showNote(link.note, r.warnings || []);
  updateEmpty();
}

// ---------- tabs ----------

// A tab opened from the assistant's link: Done closes it and the browser returns to the chat.
// Browsers let a page close a tab that a link opened, but not bring another tab to the front.
const openedByLink = /^#(m|note)=/.test(location.hash);
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
  if (e.key !== STORE_KEY || !e.newValue || e.newValue === lastSaved) return;
  pushUndo();
  if (!load()) return;
  layout(); render(); $('#source').value = toMermaid(); updateReadout(); updateEmpty();
  log('board', 'Updated from another Kiertotie tab');
});

// ---------- floating board ----------

// The board floats above every window (Document Picture-in-Picture, Chrome and Edge), so it stays
// in view while you work in the Copilot tab. This tab has to stay open: closing it closes the float.
const canFloat = 'documentPictureInPicture' in window;

async function floatBoard() {
  if (pipWin) { pipWin.focus(); return; }
  if (!canFloat) { toast('This browser cannot float a window. Chrome and Edge can.', 4000); return; }
  let w;
  try { w = await documentPictureInPicture.requestWindow({ width: 560, height: 640 }); }
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

function closeMore() { $('#more').open = false; }

$('#btn-mark').addEventListener('click', () => setMarkMode(!markMode));
$('#btn-undo').addEventListener('click', undo);
$('#btn-done').addEventListener('click', done);
$('#ask').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(); } });
$('#first').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startLoop(); } });
$('#btn-start').addEventListener('click', startLoop);
$('#wait-copy').addEventListener('click', copyStarter);
$('#wait-back').addEventListener('click', startOver);
$('#btn-theme').addEventListener('click', () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]));

// Start over: delete the diagram, after asking, and go back to the start card. Undo still brings it back.
function startOver() {
  const hasDiagram = state.nodes.size || state.groups.size;
  if (hasDiagram && !(pipWin || window).confirm('Delete this diagram and start over?')) return;
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
  if (act === 'tidy') { pushUndo(); state.pos.clear(); commit('board', 'Tidied up the layout'); fit(); }
  if (act === 'fit') fit();
  if (act === 'starter') copyStarter();
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
$('#btn-float').addEventListener('click', floatBoard);
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
  load();
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
