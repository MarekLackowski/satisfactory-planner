import dagre from '@dagrejs/dagre';
import { items, type Conveyor } from './game';
import { buildings, extractors } from './game';
import { conveyorsFor, type Group, type Plan } from './plan';
import type { Wiring } from './wiring';
import type { Settings } from './solver';

export type Dir = 'TB' | 'LR';
export type Pt = { x: number; y: number };
export type Path = { pts: Pt[]; cum: number[]; len: number };
export type Segment = {
  lanes: Path[]; // one path per physical parallel belt/pipe, offset side by side
  pts: Pt[];
  item: string;
  rate: number;
  conv: Conveyor[]; // parallel conveyors on this segment
  fluid: boolean;
  len: number;
  cum: number[]; // cumulative length at each point
  edge?: string; // inter-group edge id
  // ends attached to a group port: belts meet there even though parallel lanes start/end side by side
  join?: { start?: string; end?: string; line?: number };
};
export type MachineBox = { x: number; y: number; w: number; h: number; clock: number; shards: number };
export type NodeBox = {
  group: Group; x: number; y: number; w: number; h: number; machines: MachineBox[];
  inPort: Record<string, Pt>; outPort: Record<string, Pt>;
  titleX: number; // header text starts here (TB: right of the input buses that pass through the header)
};
export type Layout = { x: number; y: number; w: number; h: number; nodes: NodeBox[]; segs: Segment[]; wirings: Wiring[] };
/** result of the (expensive) auto-arrangement: node top-left corners + edge routes */
export type Arranged = { dir: Dir; pos: Record<string, Pt>; routes: Record<string, Pt[]> };

export const MW = 60; // machine box
const GAP = 14;
const HEAD = 30;
const PAD = 12;
const EDGE = 8; // LR: margin between node edge and body along the flow axis
const STUB = 14;

export const LANE_GAP = 8; // distance between parallel belts of one segment

function path(pts: Pt[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** polyline shifted sideways by d (mitred corners) */
function offset(pts: Pt[], d: number): Pt[] {
  if (!d || pts.length < 2) return pts;
  const nrm = (a: Pt, b: Pt) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  };
  return pts.map((p, i) => {
    const n1 = i > 0 ? nrm(pts[i - 1], p) : nrm(p, pts[i + 1]);
    const n2 = i < pts.length - 1 ? nrm(p, pts[i + 1]) : n1;
    const mx = n1.x + n2.x;
    const my = n1.y + n2.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) return { x: p.x + n1.x * d, y: p.y + n1.y * d };
    const k = d / ((mx / ml) * n1.x + (my / ml) * n1.y);
    return { x: p.x + (mx / ml) * k, y: p.y + (my / ml) * k };
  });
}

function segment(raw: Pt[], item: string, rate: number, s: Settings, edge?: string, join?: Segment['join']): Segment {
  const pts = raw.filter((p, i) => !i || p.x !== raw[i - 1].x || p.y !== raw[i - 1].y);
  const fluid = items[item].fluid;
  const conv = conveyorsFor(rate, fluid, s);
  const lanes = conv.map((_, k) => path(offset(pts, (k - (conv.length - 1) / 2) * LANE_GAP)));
  return { ...path(pts), lanes, item, rate, fluid, conv, edge, join };
}

export const titleOf = (g: Group) =>
  g.kind === 'recipe' ? `${g.label} · ${g.machines.length}× ${(buildings[g.building!] ?? extractors[g.building!]).name}` : g.label;
const TITLE_CHAR = 7; // ≈ px per char of the 12px semibold header font
const NOTE_CHAR = 6; // 11px info line of simple boxes
const INFO_LINE = 15; // must match the canvas' simple-box line height

/** spacing between belts of different items: room for one belt per line and for the widest incoming link */
function lane(g: Group, s: Settings) {
  const most = Math.max(1, g.lines.length, ...[...g.inputs, ...g.outputs].map((f) => conveyorsFor(f.rate, items[f.item].fluid, s).length));
  return Math.max(12, most * LANE_GAP + 6);
}
const lineLen = (g: Group, L: number) => g.inputs.length * L + MW + g.outputs.length * L + 26;
const titleStart = (g: Group, dir: Dir, L: number) => (dir === 'TB' && g.lines.length && g.inputs.length ? PAD + g.inputs.length * L + 2 : 8);
const titleWidth = (g: Group, dir: Dir, L: number) => titleStart(g, dir, L) + 24 + titleOf(g).length * TITLE_CHAR + 10;

function size(g: Group, dir: Dir, s: Settings) {
  const L = lane(g, s);
  const tw = titleWidth(g, dir, L);
  if (!g.lines.length) {
    const ports = Math.max(g.inputs.length, g.outputs.length) * 28 + 2 * PAD;
    // one info line per flow ("12.5/min Iron Plate")
    const flows = [...g.inputs, ...g.outputs];
    const info = Math.max(...flows.map((x) => `${x.rate.toFixed(1)}/min ${items[x.item].name}`.length)) * NOTE_CHAR + 20;
    const w = Math.max(170, tw, info);
    const h = Math.max(64, 44 + flows.length * INFO_LINE);
    return dir === 'TB' ? { width: Math.max(w, ports), height: h } : { width: w, height: Math.max(h, HEAD + ports) };
  }
  const maxM = Math.max(...g.lines.map((l) => l.machines.length));
  const A = PAD * 2 + (g.inputs.length + g.outputs.length) * L + 16 + maxM * (MW + GAP);
  const B = g.lines.length * lineLen(g, L);
  return dir === 'TB' ? { width: Math.max(170, A, tw), height: HEAD + B + 6 } : { width: Math.max(170, B + 2 * EDGE, tw), height: HEAD + Math.max(170, A) };
}

/** internal geometry of a group: each line has its own feed belt from the input port and its own belt to the output port */
function inner(n: NodeBox, dir: Dir, s: Settings, segs: Segment[], rin: number[], rout: number[]) {
  const g = n.group;
  const ni = g.inputs.length;
  const no = g.outputs.length;
  const tb = dir === 'TB';
  const L = lane(g, s);
  n.titleX = n.x + titleStart(g, dir, L);
  if (!g.lines.length) {
    // simple box: spread ports evenly along the entry / exit side
    const spot = (k: number, c: number, end: boolean): Pt =>
      tb
        ? { x: n.x + ((k + 1) * n.w) / (c + 1), y: end ? n.y + n.h : n.y }
        : { x: end ? n.x + n.w : n.x, y: n.y + HEAD + ((k + 1) * (n.h - HEAD)) / (c + 1) };
    g.inputs.forEach((f, i) => (n.inPort[f.item] = spot(i, ni, false)));
    g.outputs.forEach((f, j) => (n.outPort[f.item] = spot(j, no, true)));
    return;
  }
  // map body coords (a across, b along the flow) to world
  const at = (a: number, b: number): Pt => (tb ? { x: n.x + a, y: n.y + HEAD + b } : { x: n.x + EDGE + b, y: n.y + HEAD + a });
  const bIn = tb ? -HEAD : -EDGE;
  const bOut = tb ? n.h - HEAD : n.w - EDGE;
  const A = tb ? n.w : n.h - HEAD;
  // rin/rout: lane slot of each input/output, ordered so belts from neighbouring groups don't cross
  g.inputs.forEach((f, i) => (n.inPort[f.item] = at(PAD + rin[i] * L + L / 2, bIn)));
  g.outputs.forEach((f, j) => (n.outPort[f.item] = at(A - PAD - rout[j] * L - L / 2, bOut)));
  const lineH = lineLen(g, L);
  const m0 = PAD + ni * L + 12;
  const port = (k: number, count: number) => (MW * (k + 1)) / (count + 1);
  const seg = (pts: [number, number][], item: string, rate: number, join?: Segment['join']) =>
    segs.push(segment(pts.map(([a, b]) => at(a, b)), item, rate, s, undefined, join));
  // line l's belt runs beside the port, line 0 outermost so feeds/collectors of other lines are never crossed
  const nl = g.lines.length;
  const off = (l: number) => ((nl - 1) / 2 - l) * LANE_GAP;
  g.lines.forEach((line, l) => {
    const top = l * lineH;
    const mb = top + ni * L + 10;
    const boxes = line.machines.map((mi, k) => {
      const m = g.machines[mi];
      const a = m0 + k * (MW + GAP);
      const p = at(a, mb);
      n.machines.push({ x: p.x, y: p.y, w: MW, h: MW, clock: m.clock, shards: m.shards });
      return a;
    });
    line.inputs.forEach((f, i) => {
      const b = top + 6 + rin[i] * L;
      const x = PAD + rin[i] * L + L / 2 + off(l);
      // feed from the port straight into this line's manifold
      let prev: [number, number][] = [[x, bIn], [x, b]];
      let join: Segment['join'] = { start: `in:${g.id}:${f.item}`, line: l };
      boxes.forEach((a, k) => {
        const da = a + port(rin[i], ni);
        seg([...prev, [da, b]], f.item, f.segs[k], join);
        seg([[da, b], [da, mb]], f.item, f.segs[k] - (f.segs[k + 1] ?? 0));
        prev = [[da, b]];
        join = undefined;
      });
    });
    line.outputs.forEach((f, j) => {
      const b = mb + MW + 10 + rout[j] * L;
      const x = A - PAD - rout[j] * L - L / 2 + off(l);
      let prev: [number, number] | null = null;
      boxes.forEach((a, k) => {
        const ua = a + port(rout[j], no);
        seg([[ua, mb + MW], [ua, b]], f.item, f.segs[k] - (f.segs[k - 1] ?? 0));
        if (prev) seg([prev, [ua, b]], f.item, f.segs[k - 1]);
        prev = [ua, b];
      });
      // collector straight out to the port
      seg([prev!, [x, b], [x, bOut]], f.item, f.segs[f.segs.length - 1], { end: `out:${g.id}:${f.item}`, line: l });
    });
  });
}

type Rect = { x: number; y: number; w: number; h: number };
type Run = { at: number; from: number; to: number; item: string; half: number }; // straight belt run used by a link

/** drop repeated and collinear points so a route has only real bends */
function simplify(pts: Pt[]) {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1].x === p.x && out[out.length - 1].y === p.y) continue;
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    if (a && ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}

/**
 * Orthogonal link router, in a frame where the flow goes down (LR is transposed by the caller).
 * Tries, in order: straight line, one horizontal jog (2 bends), a detour through a free column (4 bends).
 * A route must not cross any group and must not run alongside a belt of another item.
 */
function route(a: Pt, b: Pt, half: number, item: string, blocks: Rect[], hRuns: Run[], vRuns: Run[], hints: number[]): Pt[] | null {
  const M = 8; // clearance around groups
  const overlap = (p1: number, p2: number, q1: number, q2: number) => Math.max(p1, p2) > Math.min(q1, q2) && Math.min(p1, p2) < Math.max(q1, q2);
  const clash = (runs: Run[], at: number, f: number, t: number) =>
    runs.some((r) => r.item !== item && Math.abs(r.at - at) < r.half + half + 4 && overlap(r.from, r.to, f, t));
  const free = (pts: Pt[]) => {
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      if (p.x === q.x) {
        if (blocks.some((r) => p.x > r.x - M - half && p.x < r.x + r.w + M + half && overlap(p.y, q.y, r.y - M, r.y + r.h + M))) return false;
        if (clash(vRuns, p.x, p.y, q.y)) return false;
      } else {
        if (blocks.some((r) => p.y > r.y - M - half && p.y < r.y + r.h + M + half && overlap(p.x, q.x, r.x - M, r.x + r.w + M))) return false;
        if (clash(hRuns, p.y, p.x, q.x)) return false;
      }
    }
    return true;
  };
  const y0 = a.y + STUB;
  const y1 = b.y - STUB;
  const step = 2 * half + 6;
  // 0 bends
  if (Math.abs(a.x - b.x) < 0.5 && y0 <= y1 && free([a, b])) return [a, { x: a.x, y: b.y }];
  // 2 bends: horizontal jog at some height between the two groups, middle first
  if (y0 <= y1) {
    const mid = (y0 + y1) / 2;
    for (let k = 0; k <= (y1 - y0) / step + 1; k++) {
      for (const ym of k ? [mid - k * step, mid + k * step] : [mid]) {
        if (ym < y0 || ym > y1) continue;
        const p = [a, { x: a.x, y: ym }, { x: b.x, y: ym }, b];
        if (free(p)) return p;
      }
    }
  }
  // 4 bends: leave downwards, run along a free column, come in from above
  const cols = [...new Set([
    ...hints, a.x, b.x,
    ...blocks.flatMap((r) => [r.x - M - half - 6, r.x + r.w + M + half + 6]),
  ])].filter((x) => Number.isFinite(x)).sort((p, q) => Math.abs(p - (a.x + b.x) / 2) - Math.abs(q - (a.x + b.x) / 2));
  let best: Pt[] | null = null;
  let bestLen = Infinity;
  for (const xc of cols.slice(0, 16)) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const ya = y0 + i * step;
        const yb = y1 - j * step;
        const p = [a, { x: a.x, y: ya }, { x: xc, y: ya }, { x: xc, y: yb }, { x: b.x, y: yb }, b];
        const len = Math.abs(ya - a.y) + Math.abs(xc - a.x) + Math.abs(yb - ya) + Math.abs(b.x - xc) + Math.abs(b.y - yb);
        if (len < bestLen && free(p)) {
          best = p;
          bestLen = len;
        }
      }
    }
    if (best) break; // columns are sorted by closeness; the first that works is good enough
  }
  return best;
}

/** orthogonal route: TB bends at mid-y, LR bends at mid-x */
const manhattan = (pts: Pt[], dir: Dir) => {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    if (a.x !== b.x && a.y !== b.y) {
      if (dir === 'TB') out.push({ x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 });
      else out.push({ x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y });
    }
    out.push(b);
  }
  return out;
};

/** auto-arrange groups with dagre (run once per plan / direction) */
export function arrange(plan: Plan, s: Settings, dir: Dir): Arranged {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: dir, nodesep: 70, ranksep: 110, edgesep: 24, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const gr of plan.groups) g.setNode(gr.id, size(gr, dir, s));
  for (const e of plan.edges) g.setEdge(e.from, e.to, {}, e.id);
  dagre.layout(g);
  const pos: Record<string, Pt> = {};
  for (const gr of plan.groups) {
    const p = g.node(gr.id);
    pos[gr.id] = { x: p.x - p.width / 2, y: p.y - p.height / 2 };
  }
  const routes: Record<string, Pt[]> = {};
  for (const e of plan.edges) routes[e.id] = (g.edge(e.from, e.to, e.id).points as Pt[]).slice(1, -1);
  return { dir, pos, routes };
}

/** cheap geometry pass: belts & machines for given node positions (re-run live while dragging) */
export function geometry(plan: Plan, s: Settings, arr: Arranged, moved: Record<string, Pt>): Layout {
  const { dir } = arr;
  const segs: Segment[] = [];
  const nodes: NodeBox[] = plan.groups.map((gr) => {
    const { width, height } = size(gr, dir, s);
    const p = moved[gr.id] ?? arr.pos[gr.id];
    return { group: gr, x: p.x, y: p.y, w: width, h: height, machines: [], inPort: {}, outPort: {}, titleX: p.x + 8 };
  });
  // position across the flow (x for TB, y for LR) of each group's centre
  const across = Object.fromEntries(nodes.map((n) => [n.group.id, dir === 'TB' ? n.x + n.w / 2 : n.y + n.h / 2]));
  const slots = (id: string, flows: { item: string }[], peer: (item: string) => string[], desc: boolean) => {
    const key = flows.map((f, i) => {
      const ps = peer(f.item);
      return { i, k: ps.length ? ps.reduce((a, p) => a + across[p], 0) / ps.length : across[id] };
    });
    key.sort((a, b) => (desc ? b.k - a.k : a.k - b.k) || a.i - b.i);
    const r: number[] = [];
    key.forEach((x, slot) => (r[x.i] = slot));
    return r;
  };
  for (const n of nodes) {
    const id = n.group.id;
    // inputs fill slots from the low side, outputs from the high side
    const rin = slots(id, n.group.inputs, (item) => plan.edges.filter((e) => e.to === id && e.item === item).map((e) => e.from), false);
    const rout = slots(id, n.group.outputs, (item) => plan.edges.filter((e) => e.from === id && e.item === item).map((e) => e.to), true);
    inner(n, dir, s, segs, rin, rout);
  }
  const byId = Object.fromEntries(nodes.map((n) => [n.group.id, n]));
  const stub = (p: Pt, k: number): Pt => (dir === 'TB' ? { x: p.x, y: p.y + k * STUB } : { x: p.x + k * STUB, y: p.y });
  // route in a "flow goes down" frame; LR is the transpose
  const T = (p: Pt): Pt => (dir === 'TB' ? p : { x: p.y, y: p.x });
  const rect = (n: NodeBox): Rect => (dir === 'TB' ? { x: n.x, y: n.y, w: n.w, h: n.h } : { x: n.y, y: n.x, w: n.h, h: n.w });
  const hRuns: Run[] = [];
  const vRuns: Run[] = [];
  // short links first: they have the fewest options, long ones can detour around them
  const order = [...plan.edges].sort((e1, e2) => {
    const d = (e: typeof e1) => Math.abs(byId[e.from].outPort[e.item].y - byId[e.to].inPort[e.item].y) + Math.abs(byId[e.from].outPort[e.item].x - byId[e.to].inPort[e.item].x);
    return d(e1) - d(e2);
  });
  for (const e of order) {
    const a = byId[e.from].outPort[e.item];
    const b = byId[e.to].inPort[e.item];
    const lanes = conveyorsFor(e.rate, items[e.item].fluid, s).length;
    const half = ((lanes - 1) * LANE_GAP) / 2 + 4;
    const blocks = nodes.filter((n) => n !== byId[e.from] && n !== byId[e.to]).map(rect);
    const hints = (arr.routes[e.id] ?? []).map((p) => T(p).x);
    const r = route(T(a), T(b), half, e.item, blocks, hRuns, vRuns, hints);
    const pts = r ? simplify(r).map(T) : simplify(manhattan([a, stub(a, 1), ...(arr.routes[e.id] ?? []), stub(b, -1), b], dir));
    // remember the straight runs (in the routing frame) so later links keep their distance
    const tp = pts.map(T);
    for (let i = 1; i < tp.length; i++) {
      const p = tp[i - 1];
      const q = tp[i];
      if (p.x === q.x) vRuns.push({ at: p.x, from: p.y, to: q.y, item: e.item, half });
      else hRuns.push({ at: p.y, from: p.x, to: q.x, item: e.item, half });
    }
    segs.push(segment(pts, e.item, e.rate, s, e.id, { start: `out:${e.from}:${e.item}`, end: `in:${e.to}:${e.item}` }));
  }
  const x = Math.min(...nodes.map((n) => n.x)) - 40;
  const y = Math.min(...nodes.map((n) => n.y)) - 40;
  return {
    x, y,
    w: Math.max(...nodes.map((n) => n.x + n.w)) + 40 - x,
    h: Math.max(...nodes.map((n) => n.y + n.h)) + 40 - y,
    nodes, segs, wirings: plan.wirings,
  };
}

export const layout = (plan: Plan, s: Settings, dir: Dir = 'TB') => geometry(plan, s, arrange(plan, s, dir), {});
