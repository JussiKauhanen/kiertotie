'use strict';
// Kiertotie: a small diagram board any assistant can feed.
// Channels in: #m= / #z= links, paste, the command box (also a declarative WebMCP form),
// imperative WebMCP tools, and window.kiertotie. Channels out: copy for Copilot, copy link,
// and a text readout of the diagram for assistants that read the page.

const $ = s => document.querySelector(s);
const FONT = getComputedStyle(document.body).fontFamily;
const STORE_KEY = 'kiertotie.v1';
const BASE = location.origin + location.pathname;

const state = { dir: 'LR', nodes: new Map(), groups: new Map(), edges: [], pos: new Map() };
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

// Parses text into the current state. replace: start from an empty diagram (manual positions are kept).
function parseInto(text, { replace }) {
  if (replace) { state.nodes = new Map(); state.groups = new Map(); state.edges = []; }
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
    if (/^(classDef|style|linkStyle|click|direction)\b/.test(line)) continue;
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
        if (item) item.marked = m[2] === 'marked';
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
    let left = left0, i = left0.end, ok = true;
    left.list.forEach(touch);
    for (;;) {
      const e = readEdge(line, i);
      if (!e) break;
      const right = readNodeList(line, e.end);
      if (!right) { ok = false; break; }
      right.list.forEach(touch);
      const style = edgeStyle(e.tok), arrow = e.tok.endsWith('>');
      for (const a of left.list) for (const b of right.list) {
        addEdge(a.id, b.id, e.label, style, arrow);
        if (e.back) addEdge(b.id, a.id, '', style, true);
      }
      left = right; i = right.end;
    }
    const tail = line.slice(i).trim();
    if (!ok || (tail && !tail.startsWith('%%'))) warnings.push(`Partly read: ${line}`);
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
  const marked = [...state.nodes.values(), ...state.groups.values()].filter(x => x.marked).map(x => x.id);
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
    html += `<g class="${cls}" data-group="${esc(gid)}"><rect x="${b.x - b.w / 2}" y="${b.y - b.h / 2}" width="${b.w}" height="${b.h}" rx="10"/>` +
      `<text x="${b.x - b.w / 2 + 12}" y="${b.y - b.h / 2 + 18}">${esc(g.title)}</text></g>`;
  }
  state.edges.forEach((e, i) => {
    const a = anchorBox(e.from), b = anchorBox(e.to);
    if (!a || !b) return;
    let off = 0;
    if (state.edges.some(o => o.from === e.to && o.to === e.from)) off = 9;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / len * off, ny = (b.x - a.x) / len * off;
    const p1 = clip(a, b.x + nx, b.y + ny), p2 = clip(b, a.x + nx, a.y + ny);
    const s = { x: p1.x + nx, y: p1.y + ny }, t = { x: p2.x + nx, y: p2.y + ny };
    const isSel = sel?.type === 'edge' && sel.i === i;
    const d = `M${s.x},${s.y} L${t.x},${t.y}`;
    const marker = e.arrow ? ` marker-end="url(#${isSel ? 'arrow-sel' : 'arrow'})"` : '';
    let label = '';
    if (e.label) {
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2, lw = textWidth(e.label.replace(/\n/g, ' '), 12, 400) + 10;
      label = `<rect class="label-bg" x="${mx - lw / 2}" y="${my - 10}" width="${lw}" height="20" rx="4"/>` +
        `<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central">${esc(e.label.replace(/\n/g, ' '))}</text>`;
    }
    html += `<g class="edge ${e.style}${isSel ? ' sel' : ''}" data-edge="${i}"><path class="hit" d="${d}"/><path class="line" d="${d}"${marker}/>${label}</g>`;
  });
  for (const [id, b] of boxes) {
    const n = state.nodes.get(id);
    const cls = ['node', n.marked && 'marked', sel?.type === 'node' && sel.id === id && 'sel', flash.has(id) && `flash-${flash.get(id)}`].filter(Boolean).join(' ');
    html += `<g class="${cls}" data-node="${esc(id)}" transform="translate(${b.x},${b.y})">${shapeSvg(b)}${textSvg(n.label, n.shape === 'cylinder' ? 4 : 0)}</g>`;
  }
  if (drag?.kind === 'connect' && drag.to) {
    const a = boxes.get(drag.from);
    html += `<path class="ghost" d="M${a.x},${a.y} L${drag.to.x},${drag.to.y}"/>`;
  }
  vp.innerHTML = html;
  $('#empty').hidden = state.nodes.size > 0 || state.groups.size > 0;
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
  if (message) log(channel, message);
}

function itemFingerprint(n) { return `${n.label}|${n.shape}|${n.group}|${n.marked}`; }

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
  // A new diagram gets a fresh layout; merged lines keep what the user arranged by hand.
  if (replace) state.pos.clear();
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
    '', 'Instructions for an assistant reading this page:', copilotSetup(),
  ];
  $('#readout').textContent = lines.join('\n');
}

// ---------- activity log, status, toast ----------

function log(channel, message) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.innerHTML = `<time>${time}</time><span class="tag ${esc(channel)}">${esc(channel)}</span><span>${esc(message)}</span>`;
  $('#log').prepend(li);
  while ($('#log').children.length > 80) $('#log').lastChild.remove();
}

const channels = new Map();
function setStatus(key, ok, text) {
  channels.set(key, { ok, text });
  $('#status').innerHTML = [...channels.values()].map(c => `<li class="${c.ok ? 'ok' : 'off'}">${esc(c.text)}</li>`).join('');
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copy(text, done) {
  // Our own copies are not news for auto-paste.
  if (typeof rememberClip === 'function') rememberClip(text);
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    toast(ok ? done : 'Copy failed: select the source text and copy it by hand');
  }
}

// ---------- links ----------

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function compress(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return b64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}
async function decompress(s) {
  const stream = new Blob([unb64url(s)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

async function makeLink() {
  const src = toMermaid();
  const plain = `${BASE}#m=${encodeURIComponent(src)}`;
  if (plain.length < 1800 || typeof CompressionStream === 'undefined') return plain;
  return `${BASE}#z=${await compress(src)}`;
}

// initial: this tab was just opened by the link. If a board tab is already open, the link is
// handed to it and this tab closes, so clicking Copilot's links does not pile up tabs.
async function readHash({ initial = false } = {}) {
  const h = location.hash.slice(1);
  if (!h) return;
  let text = null;
  try {
    if (h.startsWith('m=')) { const raw = h.slice(2); try { text = decodeURIComponent(raw); } catch { text = raw; } }
    else if (h.startsWith('z=')) text = await decompress(h.slice(2));
  } catch (err) { log('error', `Could not read the link: ${err.message}`); }
  if (text == null) return;
  history.replaceState(null, '', BASE);
  if (initial && await relay(text)) return;
  applyLink(text);
}

function applyLink(text) {
  const r = applyText(text, 'link');
  setStatus('link', true, `Link: last opened ${new Date().toLocaleTimeString()} (${r.message || 'ok'})`);
  return r;
}

// ---------- tabs ----------

const TAB_ID = Math.random().toString(36).slice(2);
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('kiertotie') : null;
let lastActive = document.hasFocus() ? Date.now() : 0;
let relaying = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

window.addEventListener('focus', () => { lastActive = Date.now(); document.title = 'Kiertotie'; });

if (bc) bc.addEventListener('message', ({ data }) => {
  if (!data || data.from === TAB_ID) return;
  if (data.type === 'hello' && !relaying) bc.postMessage({ type: 'here', from: TAB_ID, to: data.from, active: lastActive });
  if (data.type === 'apply' && data.to === TAB_ID) {
    const r = applyLink(data.text);
    if (!document.hasFocus()) document.title = '● Updated · Kiertotie';
    bc.postMessage({ type: 'applied', from: TAB_ID, to: data.from, message: r.message || 'Applied' });
  }
});

async function relay(text) {
  if (!bc) return false;
  relaying = true;
  const replies = [];
  const onHere = ({ data }) => { if (data?.type === 'here' && data.to === TAB_ID) replies.push(data); };
  bc.addEventListener('message', onHere);
  bc.postMessage({ type: 'hello', from: TAB_ID });
  await sleep(350);
  bc.removeEventListener('message', onHere);
  if (!replies.length) { relaying = false; return false; }
  // The board tab used most recently gets it.
  const target = replies.sort((a, b) => b.active - a.active)[0];
  const ack = new Promise(resolve => {
    const onApplied = ({ data }) => {
      if (data?.type === 'applied' && data.to === TAB_ID) { bc.removeEventListener('message', onApplied); resolve(data); }
    };
    bc.addEventListener('message', onApplied);
    setTimeout(() => { bc.removeEventListener('message', onApplied); resolve(null); }, 2000);
  });
  bc.postMessage({ type: 'apply', from: TAB_ID, to: target.from, text });
  const done = await ack;
  if (!done) { relaying = false; return false; }
  showRelayed(done.message);
  log('link', `Sent to the open board tab: ${done.message}`);
  // Browsers let a page close a tab that a link opened and that has no history of its own.
  window.close();
  return true;
}

function showRelayed(message) {
  const el = document.createElement('div');
  el.className = 'relay';
  el.innerHTML = `<div class="card" role="dialog" aria-labelledby="relay-title">
    <strong id="relay-title">Sent to your open Kiertotie tab</strong>
    <p class="muted small">${esc(message)}</p>
    <div class="row"><button class="primary" data-act="close">Close this tab</button><button data-act="here">Use this tab instead</button></div>
  </div>`;
  el.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { window.close(); toast('The browser kept this tab open: close it with Ctrl+W'); }
    if (act === 'here') location.reload();
  });
  document.body.append(el);
}

// A board tab coming back into view picks up what another tab saved meanwhile.
let lastSaved = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || relaying) return;
  const raw = stored(STORE_KEY);
  if (!raw || raw === lastSaved) return;
  pushUndo();
  if (load()) { lastSaved = raw; layout(); render(); $('#source').value = toMermaid(); updateReadout(); log('board', 'Updated from another Kiertotie tab'); }
});

// ---------- WebMCP ----------

const TOOLS = [
  {
    name: 'get_diagram',
    description: 'Read the diagram on the Kiertotie board: its Mermaid flowchart source and the ids the user highlighted (the items they want changed or are asking about).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    run: () => ({ mermaid: toMermaid(), highlighted: markedItems().map(x => x.id), selected: sel?.type === 'edge' ? null : sel?.id ?? null }),
  },
  {
    name: 'set_diagram',
    description: 'Replace the whole diagram with a Mermaid flowchart. Start with "flowchart LR" or "flowchart TD". Use subgraph ... end for boundaries, A[Label] boxes, A[(Label)] databases, A{Label} decisions, A -->|text| B links.',
    inputSchema: { type: 'object', properties: { mermaid: { type: 'string', description: 'Mermaid flowchart text starting with "flowchart".' } }, required: ['mermaid'] },
    run: ({ mermaid }) => applyText(/^\s*(flowchart|graph)\b/i.test(mermaid) ? mermaid : `flowchart LR\n${mermaid}`, 'webmcp'),
  },
  {
    name: 'update_diagram',
    description: 'Change part of the diagram. Give Mermaid lines without the "flowchart" header; they are merged in: new ids are added, existing ids are relabelled. Extra commands: "remove A, B", "remove A --> B", "rename A: New label", "mark A", "unmark all".',
    inputSchema: { type: 'object', properties: { lines: { type: 'string', description: 'Mermaid lines to merge, one per line.' } }, required: ['lines'] },
    run: ({ lines }) => applyText(String(lines).replace(/^\s*(flowchart|graph)\b[^\n]*\n?/i, ''), 'webmcp'),
  },
  {
    name: 'remove_items',
    description: 'Remove boxes or groups from the diagram by id, together with their links.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    run: ({ ids }) => applyText(`remove ${(ids || []).join(', ')}`, 'webmcp'),
  },
];

async function registerWebMCP() {
  const mc = document.modelContext || navigator.modelContext;
  const where = document.modelContext ? 'document.modelContext' : navigator.modelContext ? 'navigator.modelContext' : null;
  if (!mc) { setStatus('webmcp', false, 'WebMCP: not in this browser (no document.modelContext)'); return; }
  const wrapped = TOOLS.map(({ run, ...t }) => ({
    ...t,
    execute: async args => {
      log('webmcp', `${t.name} called`);
      try { const r = await run(args || {}); return typeof r === 'string' ? r : JSON.stringify(r); }
      catch (err) { log('error', `${t.name}: ${err.message}`); throw err; }
    },
  }));
  let count = 0;
  try {
    if (typeof mc.registerTool === 'function') {
      for (const t of wrapped) { try { await mc.registerTool(t); count++; } catch (err) { log('error', `WebMCP ${t.name}: ${err.message}`); } }
    } else if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools: wrapped }); count = wrapped.length;
    }
  } catch (err) { log('error', `WebMCP: ${err.message}`); }
  setStatus('webmcp', count > 0, count ? `WebMCP: ${count} tools on ${where}, waiting for calls` : `WebMCP: ${where} found but registering failed`);
  if (count) log('webmcp', `Registered ${count} tools on ${where}`);
}

// ---------- copying out ----------

function copilotPacket() {
  const marked = markedItems();
  const names = marked.map(x => `${x.id} ("${(x.label || x.title).replace(/\n/g, ' ')}")`);
  return [
    'This is my current Kiertotie diagram.',
    marked.length ? `I highlighted: ${names.join(', ')}. My request is about those.` : 'Nothing is highlighted.',
    '',
    '```mermaid',
    toMermaid(),
    '```',
    '',
    'My request: ',
  ].join('\n');
}

function copilotSetup() {
  return `You help me draw diagrams on my Kiertotie board at ${BASE}
You cannot change the board yourself. You answer with a link that I click, and the board applies it.

Keep answers short: one line saying what you changed, then the link. No other explanation unless I ask.

The link is ${BASE}#m= followed by diagram text, with ; between lines, %20 for spaces and %3E for >. Example:
${BASE}#m=flowchart%20LR;web[Web%20app]%20--%3E%20api[API];api%20--%3E%20db[(SQL)]

New diagram: Mermaid flowchart text starting with "flowchart LR" (or "flowchart TD"). Short ids, labels in brackets: web[Web app]. Shapes: [box], (rounded), ([pill]), [(database)], ((circle)), {decision}. Links: a --> b, with text a -->|HTTPS| b, dotted a -.-> b. Boundaries: subgraph azure[Azure subscription] ... end.

Change to the diagram I have: only the lines that change, no "flowchart" line, and keep the ids already in use. A line with an existing id updates that item. Commands: remove a, b · remove a --> b · rename a: New label · mark a · unmark all.

Items marked with "class ... marked" (or listed as highlighted) are the ones my request is about.

If the link would be longer than about 1500 characters, also give the same text in a plain text code block (not a mermaid block) so I can copy it.`;
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
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node],[data-group]');
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

document.addEventListener('keydown', e => {
  if (typing(document.activeElement)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
  else if (e.key === 'Escape') { select(null); if (markMode) setMarkMode(false); }
  else if (!mod && e.key.toLowerCase() === 'm') setMarkMode(!markMode);
  else if (!mod && e.key.toLowerCase() === 'f') fit();
});

const looksLikeDiagram = text => /-->|---|==>|-\.->|^\s*(flowchart|graph|subgraph)\b|^\s*(remove|delete|rename|mark|unmark)\s+\S/im.test(text);

document.addEventListener('paste', e => {
  if (typing(e.target)) return;
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!looksLikeDiagram(text) && !/\[|\(/.test(text)) { toast('That paste does not look like a diagram'); return; }
  e.preventDefault();
  applyText(text, 'paste');
});

// Auto-paste: when the tab comes back into view, apply new diagram text from the clipboard.
// Opt-in, because reading the clipboard needs the browser's permission.
const CLIP_KEY = 'kiertotie.clip';
let autoClip = false;
const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const stored = k => { try { return localStorage.getItem(k); } catch { return null; } };
let lastClip = stored(`${CLIP_KEY}.last`);

function rememberClip(text) { lastClip = text; store(`${CLIP_KEY}.last`, text.length < 20000 ? text : null); }

async function readClip() {
  try { return await navigator.clipboard.readText(); }
  catch (err) { setStatus('clipboard', false, `Auto-paste: the browser blocked reading the clipboard (${err.name})`); return null; }
}

async function checkClipboard() {
  if (!autoClip || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  const text = await readClip();
  if (!text || text === lastClip) return;
  rememberClip(text);
  if (looksLikeDiagram(text)) applyText(text, 'clipboard');
}

async function setAutoClip(on) {
  autoClip = on;
  $('#btn-clip').setAttribute('aria-pressed', String(on));
  store(CLIP_KEY, on ? '1' : null);
  if (!on) { setStatus('clipboard', false, 'Auto-paste: off'); return; }
  // What is on the clipboard when it is switched on is not new, so it is not applied.
  const text = await readClip();
  if (text == null) return;
  rememberClip(text);
  setStatus('clipboard', true, 'Auto-paste: on, applies diagram text you copy when you come back to this tab');
}

$('#btn-clip').addEventListener('click', () => setAutoClip(!autoClip).then(() => toast(autoClip ? 'Auto-paste on: copy Copilot\'s answer, then come back here' : 'Auto-paste off')));
window.addEventListener('focus', () => setTimeout(checkClipboard, 50));
document.addEventListener('visibilitychange', () => setTimeout(checkClipboard, 50));

function setMarkMode(on) {
  markMode = on;
  $('#btn-mark').setAttribute('aria-pressed', String(on));
  svg.classList.toggle('marking', on);
  if (on) toast('Click boxes or group titles to highlight them. Esc to stop.');
}

$('#btn-mark').addEventListener('click', () => setMarkMode(!markMode));
$('#btn-undo').addEventListener('click', undo);
$('#btn-fit').addEventListener('click', fit);
$('#btn-tidy').addEventListener('click', () => { pushUndo(); state.pos.clear(); commit('board', 'Tidied up the layout'); fit(); });
$('#btn-link').addEventListener('click', async () => copy(await makeLink(), 'Link copied'));
$('#btn-copy').addEventListener('click', () => copy(copilotPacket(), 'Copied: paste it into Copilot and add your request'));
$('#btn-setup').addEventListener('click', () => copy(copilotSetup(), 'Setup copied: paste it into Copilot once per chat'));
$('#btn-sample').addEventListener('click', () => applyText(SAMPLE, 'sample'));

$('#cmd-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#cmd').value;
  // An agent filling the declarative WebMCP form submits it without a user click.
  const channel = e.agentInvoked ? 'webmcp' : 'command';
  const r = applyText(text, channel);
  if (r.ok) $('#cmd').value = '';
  if (typeof e.respondWith === 'function') e.respondWith(Promise.resolve(JSON.stringify(r)));
});
$('#cmd').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#cmd-form').requestSubmit(); }
});

let sourceTimer;
$('#source').addEventListener('input', () => {
  clearTimeout(sourceTimer);
  sourceTimer = setTimeout(() => {
    const text = $('#source').value;
    pushUndo();
    const { warnings } = parseInto(text, { replace: true });
    $('#source-msg').textContent = warnings.length ? warnings.slice(0, 3).join(' · ') : '';
    commit('source', 'Edited the source', { fromSource: true });
  }, 450);
});

window.addEventListener('hashchange', readHash);
window.addEventListener('resize', () => render());

// For console testing and for any agent that can run page scripts.
window.kiertotie = {
  get: () => TOOLS[0].run(),
  set: mermaid => TOOLS[1].run({ mermaid }),
  update: lines => TOOLS[2].run({ lines }),
  remove: ids => TOOLS[3].run({ ids }),
  tools: TOOLS,
};

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

(async function start() {
  const restored = load();
  layout();
  $('#source').value = toMermaid();
  updateReadout();
  setStatus('link', true, `Link: ${BASE}#m=… or #z=…`);
  setStatus('paste', true, 'Paste: Mermaid anywhere on the page');
  setStatus('command', true, 'Command box: ready (also a declarative WebMCP form)');
  if (stored(CLIP_KEY)) { autoClip = true; $('#btn-clip').setAttribute('aria-pressed', 'true'); setStatus('clipboard', true, 'Auto-paste: on'); }
  else setStatus('clipboard', false, 'Auto-paste: off (button in the toolbar)');
  if (restored) log('board', 'Restored the last diagram from this browser');
  fit();
  await registerWebMCP();
  await readHash({ initial: true });
})();
