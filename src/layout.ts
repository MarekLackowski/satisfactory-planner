import dagre from '@dagrejs/dagre';
import { items, type Conveyor } from './game';
import { buildings, extractors } from './game';
import { conveyorsFor, type Group, type Plan } from './plan';
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
};
export type MachineBox = { x: number; y: number; w: number; h: number; clock: number; shards: number };
export type NodeBox = {
  group: Group; x: number; y: number; w: number; h: number; machines: MachineBox[];
  inPort: Record<string, Pt>; outPort: Record<string, Pt>;
  titleX: number; // header text starts here (TB: right of the input buses that pass through the header)
};
export type Layout = { x: number; y: number; w: number; h: number; nodes: NodeBox[]; segs: Segment[] };
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

function segment(raw: Pt[], item: string, rate: number, s: Settings, edge?: string): Segment {
  const pts = raw.filter((p, i) => !i || p.x !== raw[i - 1].x || p.y !== raw[i - 1].y);
  const fluid = items[item].fluid;
  const conv = conveyorsFor(rate, fluid, s);
  const lanes = conv.map((_, k) => path(offset(pts, (k - (conv.length - 1) / 2) * LANE_GAP)));
  return { ...path(pts), lanes, item, rate, fluid, conv, edge };
}

export const titleOf = (g: Group) =>
  g.kind === 'recipe' ? `${g.label} · ${g.machines.length}× ${(buildings[g.building!] ?? extractors[g.building!]).name}` : g.label;
const TITLE_CHAR = 7; // ≈ px per char of the 12px semibold header font
const NOTE_CHAR = 6; // 11px info line of simple boxes
const INFO_LINE = 15; // must match the canvas' simple-box line height

/** spacing between belts of different items: wide enough for the most parallel belts this group carries */
function lane(g: Group, s: Settings) {
  const most = Math.max(1, ...[...g.inputs, ...g.outputs].map((f) => conveyorsFor(f.rate, items[f.item].fluid, s).length));
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

/** internal geometry of a group: machines, input bus → manifold → machines → collector → output bus */
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
  const seg = (pts: [number, number][], item: string, rate: number) => segs.push(segment(pts.map(([a, b]) => at(a, b)), item, rate, s));
  const busIn = g.inputs.map((_, i) => [PAD + rin[i] * L + L / 2, bIn] as [number, number]);
  const busOut: ([number, number] | undefined)[] = [];
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
      const busA = busIn[i][0];
      const busRate = g.lines.slice(l).reduce((acc, ln) => acc + ln.inputs[i].segs[0], 0);
      seg([busIn[i], [busA, b]], f.item, busRate);
      busIn[i] = [busA, b];
      let prev: [number, number] = [busA, b];
      boxes.forEach((a, k) => {
        const da = a + port(rin[i], ni);
        seg([prev, [da, b]], f.item, f.segs[k]);
        seg([[da, b], [da, mb]], f.item, f.segs[k] - (f.segs[k + 1] ?? 0));
        prev = [da, b];
      });
    });
    line.outputs.forEach((f, j) => {
      const b = mb + MW + 10 + rout[j] * L;
      const busA = A - PAD - rout[j] * L - L / 2;
      let prev: [number, number] | null = null;
      boxes.forEach((a, k) => {
        const ua = a + port(rout[j], no);
        seg([[ua, mb + MW], [ua, b]], f.item, f.segs[k] - (f.segs[k - 1] ?? 0));
        if (prev) seg([prev, [ua, b]], f.item, f.segs[k - 1]);
        prev = [ua, b];
      });
      const last = f.segs[f.segs.length - 1];
      seg([prev!, [busA, b]], f.item, last);
      const acc = g.lines.slice(0, l + 1).reduce((t, ln) => t + ln.outputs[j].segs[ln.outputs[j].segs.length - 1], 0);
      if (busOut[j]) seg([busOut[j]!, [busA, b]], f.item, acc - last);
      busOut[j] = [busA, b];
    });
  });
  g.outputs.forEach((f, j) => seg([busOut[j]!, [A - PAD - rout[j] * L - L / 2, bOut]], f.item, f.rate));
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
  for (const e of plan.edges) {
    const a = byId[e.from].outPort[e.item];
    const b = byId[e.to].inPort[e.item];
    const mid = moved[e.from] || moved[e.to] ? [] : arr.routes[e.id];
    segs.push(segment(manhattan([a, stub(a, 1), ...mid, stub(b, -1), b], dir), e.item, e.rate, s, e.id));
  }
  const x = Math.min(...nodes.map((n) => n.x)) - 40;
  const y = Math.min(...nodes.map((n) => n.y)) - 40;
  return {
    x, y,
    w: Math.max(...nodes.map((n) => n.x + n.w)) + 40 - x,
    h: Math.max(...nodes.map((n) => n.y + n.h)) + 40 - y,
    nodes, segs,
  };
}

export const layout = (plan: Plan, s: Settings, dir: Dir = 'TB') => geometry(plan, s, arrange(plan, s, dir), {});
