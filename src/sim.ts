import type { Layout, Pt, Segment } from './layout';
import type { Wiring } from './wiring';

/**
 * Discrete item simulation on the belt network.
 * Segments are joined where one ends and another starts (same item, same point): several outgoing = splitter,
 * several incoming = merger. Items spawn at machine outputs / inputs at the planned rate, move at the belt tier's
 * speed, never overlap (a full belt is packed at ITEM_GAP), split in planned proportions and vanish into machines.
 */
export const ITEM_GAP = 14; // px between items on a belt running at full capacity

type Item = { d: number }; // distance travelled along the belt
export type Belt = {
  seg: Segment;
  v: number[]; // px/s per parallel belt (tiers can differ)
  next: number[];
  prev: number[];
  lanes: Item[][]; // one queue per parallel belt, front (largest d) first
  sent: number[]; // items handed to each next belt (splitter balance)
  total: number;
  acc: number; // fractional items waiting to spawn (sources only)
  rr: number; // round robin over lanes
  sunk: number; // items delivered into a machine / output (sinks only)
  route?: { belt: number; lane: number; rate: number }[][]; // at a wired port: per lane, where items go (recipe)
  rsent?: number[][];
  fed: number[]; // items that entered each lane (for checks / stats)
};
export type Junction = Pt & { kind: 'splitter' | 'merger' | 'junction'; wiring?: Wiring }; // junction = pipeline junction (fluids)
export type Sim = { belts: Belt[]; junctions: Junction[] };

const key = (p: Pt, item: string) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)},${item}`;
// where a segment begins / ends in the network: its group port if attached to one, else its end point
const startKey = (s: Segment) => s.join?.start ?? key(s.pts[0], s.item);
const endKey = (s: Segment) => s.join?.end ?? key(s.pts[s.pts.length - 1], s.item);

export function buildSim(layout: Layout, old?: Sim): Sim {
  const belts: Belt[] = layout.segs
    .filter((s) => !s.fluid && s.len > 0.5)
    .map((seg) => ({ seg, v: seg.conv.map((c) => (c.rate / 60) * ITEM_GAP), next: [], prev: [], lanes: seg.lanes.map(() => []), sent: [], total: 0, acc: 0, rr: 0, sunk: 0, fed: seg.lanes.map(() => 0) }));
  const starts = new Map<string, number[]>();
  belts.forEach((b, i) => {
    const k = startKey(b.seg);
    starts.set(k, [...(starts.get(k) ?? []), i]);
  });
  belts.forEach((b, i) => {
    b.next = starts.get(endKey(b.seg)) ?? [];
    b.sent = b.next.map(() => 0);
    for (const j of b.next) belts[j].prev.push(i);
  });
  // splitters / mergers (and pipe junctions) where belts branch or join. A port where n parallel belts simply
  // continue as n line belts (or the other way round) needs none.
  type Node = { at: Pt; ins: number; outs: number; lanesIn: number; lanesOut: number; fluid: boolean };
  const nodes = new Map<string, Node>();
  const node = (k: string, at: Pt, fluid: boolean) => {
    if (!nodes.has(k)) nodes.set(k, { at, ins: 0, outs: 0, lanesIn: 0, lanesOut: 0, fluid });
    return nodes.get(k)!;
  };
  for (const s of layout.segs) {
    if (s.len <= 0.5) continue;
    const a = node(startKey(s), s.pts[0], s.fluid);
    a.outs++;
    a.lanesOut += s.lanes.length;
    if (s.edge) a.at = s.pts[0]; // port junctions sit on the port, where links leave
    const e = node(endKey(s), s.pts[s.pts.length - 1], s.fluid);
    e.ins++;
    e.lanesIn += s.lanes.length;
    if (s.edge) e.at = s.pts[s.pts.length - 1]; // ... and where links arrive
  }
  const junctions: Junction[] = [];
  const wiringOf = new Map(layout.wirings.map((w) => [w.key, w]));
  for (const [k, nd] of nodes) {
    const w = wiringOf.get(k);
    if (w) {
      // a port: a block only where its recipe needs a splitter or merger
      if (w.splitters || w.mergers) junctions.push({ ...nd.at, kind: nd.fluid ? 'junction' : w.splitters ? 'splitter' : 'merger', wiring: w });
      continue;
    }
    if (!nd.ins || !nd.outs) continue; // pure source or sink
    if ((nd.ins === 1 || nd.outs === 1) && nd.lanesIn === nd.lanesOut) continue; // belts just continue
    junctions.push({ ...nd.at, kind: nd.fluid ? 'junction' : nd.lanesOut > nd.lanesIn || nd.outs > nd.ins ? 'splitter' : 'merger' });
  }
  // ports: send items exactly as the build recipe says
  for (const w of layout.wirings) {
    const enders = belts.map((b, i) => ({ b, i })).filter(({ b }) => endKey(b.seg) === w.key);
    const starters = belts.map((b, i) => ({ b, i })).filter(({ b }) => startKey(b.seg) === w.key);
    const sinkBelt = (ref: string) =>
      starters.find(({ b }) => (ref.startsWith('edge:') ? `edge:${b.seg.edge}` === ref : `line:${b.seg.join?.line}` === ref))?.i;
    for (const { b } of enders) {
      b.route = b.lanes.map((_, li) => {
        const ref = b.seg.edge ? `edge:${b.seg.edge}#${li}` : `line:${b.seg.join?.line}`;
        const from = w.sources.findIndex((s) => s.ref === ref);
        return w.pieces
          .filter((p) => p.from === from)
          .map((p) => ({ belt: sinkBelt(w.sinks[p.to].ref) ?? -1, lane: p.lane, rate: p.rate }))
          .filter((r) => r.belt >= 0);
      });
      b.rsent = b.route.map((r) => r.map(() => 0));
    }
  }
  const sim = { belts, junctions };
  if (old && old.belts.length === belts.length && old.belts.every((o, i) => o.seg.item === belts[i].seg.item && o.lanes.length === belts[i].lanes.length)) {
    // same plan, groups only moved: keep every item at the same relative spot
    belts.forEach((b, i) => {
      const o = old.belts[i];
      b.lanes = o.lanes.map((lane) => lane.map((it) => ({ d: (it.d / o.seg.len) * b.seg.len })));
      Object.assign(b, { sent: o.sent.length === b.next.length ? o.sent : b.sent, total: o.total, acc: o.acc, rr: o.rr });
    });
  } else {
    // start with a running factory instead of empty belts
    // (Mk.1 crawls realistically, so long chains need a few simulated minutes to fill)
    const t0 = performance.now();
    for (let t = 0; t < 300 && performance.now() - t0 < 120; t += 0.2) step(sim, 0.2);
  }
  return sim;
}

/** put an item at the entry of belt b if one of its lanes has room; d = how far in it already got */
function enter(b: Belt, d: number, prefer = -1, only = false) {
  const first = prefer >= 0 ? prefer : b.rr;
  for (let k = 0; k < (only ? 1 : b.lanes.length); k++) {
    const lane = b.lanes[(first + k) % b.lanes.length];
    const tail = lane.length ? lane[lane.length - 1].d : Infinity;
    if (tail < ITEM_GAP) continue;
    lane.push({ d: Math.min(d, tail - ITEM_GAP, b.seg.len) });
    b.fed[(first + k) % b.lanes.length]++;
    b.rr = (first + k + 1) % b.lanes.length;
    return true;
  }
  return false;
}

/** splitter: the next belt furthest behind its planned share that has room; lane k of n belts → n line belts goes straight to belt k */
function handOff(sim: Sim, b: Belt, over: number, lane: number, self: number) {
  const route = b.route?.[lane];
  if (route?.length) {
    // wired port: the output of this belt's splitter furthest behind its share, onto its exact belt
    const sent = b.rsent![lane];
    const total = sent.reduce((a, x) => a + x, 0);
    const sum = route.reduce((a, r) => a + r.rate, 0) || 1;
    const order = route.map((r, k) => ({ r, k, deficit: (r.rate / sum) * (total + 1) - sent[k] })).sort((p, q) => q.deficit - p.deficit);
    for (const { r, k } of order) {
      if (enter(sim.belts[r.belt], over, r.lane, true)) {
        sent[k]++;
        return true;
      }
    }
    return false;
  }
  const rates = b.next.map((j) => sim.belts[j].seg.rate);
  const sum = rates.reduce((a, r) => a + r, 0) || 1;
  const order = b.next
    .map((j, k) => ({ j, k, deficit: (rates[k] / sum) * (b.total + 1) - b.sent[k] }))
    .sort((p, q) => q.deficit - p.deficit);
  if (b.next.length === b.lanes.length && b.lanes.length > 1) order.unshift(...order.splice(order.findIndex((o) => o.k === lane), 1));
  for (const { j, k } of order) {
    const t = sim.belts[j];
    const pos = t.prev.indexOf(self);
    if (enter(t, over, t.prev.length === t.lanes.length && t.lanes.length > 1 ? pos : -1)) {
      b.sent[k]++;
      b.total++;
      return true;
    }
  }
  return false;
}

export function step(sim: Sim, dt: number) {
  sim.belts.forEach((b, self) => {
    const len = b.seg.len;
    b.lanes.forEach((lane, li) => {
      for (let i = 0; i < lane.length; i++) {
        const it = lane[i];
        let d = it.d + b.v[li] * dt;
        if (i > 0) d = Math.min(d, lane[i - 1].d - ITEM_GAP);
        if (i === 0 && d >= len) {
          // reached the end: into a machine/output (sink) or onto the next belt
          if (!b.next.length) b.sunk++;
          if (!b.next.length || handOff(sim, b, d - len, li, self)) {
            lane.shift();
            i--;
            continue;
          }
          d = len;
        }
        it.d = Math.max(it.d, d);
      }
    });
    if (!b.prev.length) {
      // source: machine output or factory input, spawning at the planned rate
      b.acc = Math.min(b.acc + (b.seg.rate / 60) * dt, 3 + (b.seg.rate / 60) * dt);
      while (b.acc >= 1 && enter(b, 0)) b.acc--;
    }
  });
}
