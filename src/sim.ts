import type { Layout, Pt, Segment } from './layout';

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
  v: number; // px/s
  next: number[];
  prev: number[];
  lanes: Item[][]; // one queue per parallel belt, front (largest d) first
  sent: number[]; // items handed to each next belt (splitter balance)
  total: number;
  acc: number; // fractional items waiting to spawn (sources only)
  rr: number; // round robin over lanes
  sunk: number; // items delivered into a machine / output (sinks only)
};
export type Junction = Pt & { kind: 'splitter' | 'merger' };
export type Sim = { belts: Belt[]; junctions: Junction[] };

const key = (p: Pt, item: string) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)},${item}`;

export function buildSim(layout: Layout, old?: Sim): Sim {
  const belts: Belt[] = layout.segs
    .filter((s) => !s.fluid && s.len > 0.5)
    .map((seg) => ({ seg, v: (seg.conv[0].rate / 60) * ITEM_GAP, next: [], prev: [], lanes: seg.lanes.map(() => []), sent: [], total: 0, acc: 0, rr: 0, sunk: 0 }));
  const starts = new Map<string, number[]>();
  const ends = new Map<string, number>();
  belts.forEach((b, i) => {
    const k = key(b.seg.pts[0], b.seg.item);
    starts.set(k, [...(starts.get(k) ?? []), i]);
    const e = key(b.seg.pts[b.seg.pts.length - 1], b.seg.item);
    ends.set(e, (ends.get(e) ?? 0) + 1);
  });
  belts.forEach((b, i) => {
    b.next = starts.get(key(b.seg.pts[b.seg.pts.length - 1], b.seg.item)) ?? [];
    b.sent = b.next.map(() => 0);
    for (const j of b.next) belts[j].prev.push(i);
  });
  const junctions: Junction[] = [];
  const seen = new Set<string>();
  for (const b of belts) {
    const s = b.seg.pts[0];
    const k = key(s, b.seg.item);
    if (!seen.has(k) && (starts.get(k)?.length ?? 0) > 1) junctions.push({ ...s, kind: 'splitter' });
    seen.add(k);
    const e = b.seg.pts[b.seg.pts.length - 1];
    const ke = key(e, b.seg.item);
    if (!seen.has(ke) && (ends.get(ke) ?? 0) > 1) junctions.push({ ...e, kind: 'merger' });
    seen.add(ke);
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
function enter(b: Belt, d: number) {
  for (let k = 0; k < b.lanes.length; k++) {
    const lane = b.lanes[(b.rr + k) % b.lanes.length];
    const tail = lane.length ? lane[lane.length - 1].d : Infinity;
    if (tail < ITEM_GAP) continue;
    lane.push({ d: Math.min(d, tail - ITEM_GAP, b.seg.len) });
    b.rr = (b.rr + k + 1) % b.lanes.length;
    return true;
  }
  return false;
}

/** splitter: the next belt furthest behind its planned share that has room */
function handOff(sim: Sim, b: Belt, over: number) {
  const rates = b.next.map((j) => sim.belts[j].seg.rate);
  const sum = rates.reduce((a, r) => a + r, 0) || 1;
  const order = b.next
    .map((j, k) => ({ j, k, deficit: (rates[k] / sum) * (b.total + 1) - b.sent[k] }))
    .sort((p, q) => q.deficit - p.deficit);
  for (const { j, k } of order) {
    if (enter(sim.belts[j], over)) {
      b.sent[k]++;
      b.total++;
      return true;
    }
  }
  return false;
}

export function step(sim: Sim, dt: number) {
  for (const b of sim.belts) {
    const len = b.seg.len;
    for (const lane of b.lanes) {
      for (let i = 0; i < lane.length; i++) {
        const it = lane[i];
        let d = it.d + b.v * dt;
        if (i > 0) d = Math.min(d, lane[i - 1].d - ITEM_GAP);
        if (i === 0 && d >= len) {
          // reached the end: into a machine/output (sink) or onto the next belt
          if (!b.next.length) b.sunk++;
          if (!b.next.length || handOff(sim, b, d - len)) {
            lane.shift();
            i--;
            continue;
          }
          d = len;
        }
        it.d = Math.max(it.d, d);
      }
    }
    if (!b.prev.length) {
      // source: machine output or factory input, spawning at the planned rate
      b.acc = Math.min(b.acc + (b.seg.rate / 60) * dt, 3 + (b.seg.rate / 60) * dt);
      while (b.acc >= 1 && enter(b, 0)) b.acc--;
    }
  }
}
