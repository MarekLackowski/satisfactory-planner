import { fmt } from './game';

/**
 * Exact belt wiring at a group port: which physical belt goes where, and the splitters/mergers to build.
 * Sources are single belts (a production line, or one belt of an incoming link); sinks are a production line
 * or an outgoing link that may consist of several parallel belts ("lanes").
 */
export type End = { label: string; icon: string; rate: number; lanes: number; cap: number; ref: string }; // ref: line:<l> | edge:<id>[#lane]; icon: display name
export type Piece = { from: number; to: number; lane: number; rate: number };
export type Wiring = {
  key: string; // in:<group>:<item> | out:<group>:<item>, same as the belts' join tags
  title: string;
  sources: End[];
  sinks: End[];
  pieces: Piece[];
  steps: string[];
  splitters: number; // pipeline junctions when fluid
  mergers: number;
  fluid: boolean;
};

// LP results carry ~1e-4/min noise; anything below 0.01/min is the same amount in game
const TOL = 0.01;
const near = (a: number, b: number) => Math.abs(a - b) <= TOL;

/** decide which source belt feeds which sink belt: straight matches first, then as few splits as possible */
export function wire(src: End[], dst: End[]): Piece[] {
  const left = src.map((s) => s.rate);
  const flows: { from: number; to: number; rate: number }[] = [];
  // smallest demands first, each from a single belt where possible (exact match > smallest belt that covers it)
  const order = dst.map((_, j) => j).sort((a, b) => dst[a].rate - dst[b].rate);
  for (const j of order) {
    let need = dst[j].rate;
    while (need > TOL) {
      const avail = left.map((v, i) => ({ v, i })).filter((x) => x.v > TOL);
      if (!avail.length) break;
      const pick =
        avail.find((x) => near(x.v, need)) ??
        avail.filter((x) => x.v >= need).sort((a, b) => a.v - b.v)[0] ??
        avail.sort((a, b) => b.v - a.v)[0];
      const whole = near(pick.v, need);
      const r = whole ? pick.v : Math.min(pick.v, need);
      flows.push({ from: pick.i, to: j, rate: r });
      left[pick.i] = whole ? 0 : left[pick.i] - r;
      need = whole ? 0 : need - r;
    }
  }
  // put each sink's flows on its parallel belts: a free belt each if possible, merge only when out of belts
  const pieces: Piece[] = [];
  dst.forEach((d, j) => {
    const load: number[] = Array(d.lanes).fill(0);
    for (const f of flows.filter((x) => x.to === j).sort((a, b) => b.rate - a.rate)) {
      let rest = f.rate;
      const fits = (k: number) => d.cap - load[k] >= rest - TOL;
      const k = [...load.keys()].find((k) => load[k] === 0 && fits(k)) ?? [...load.keys()].filter(fits).sort((a, b) => load[b] - load[a])[0];
      if (k !== undefined) {
        load[k] += rest;
        pieces.push({ from: f.from, to: j, lane: k, rate: rest });
        continue;
      }
      for (let k = 0; k < d.lanes && rest > TOL; k++) {
        const r = Math.min(rest, d.cap - load[k]);
        if (r <= TOL) continue;
        load[k] += r;
        rest -= r;
        pieces.push({ from: f.from, to: j, lane: k, rate: r });
      }
    }
  });
  return pieces;
}

/**
 * belts into production lines stacked one below the other: fill the lines top to bottom from the belts in turn
 * (a staircase), so each belt feeds neighbouring lines and each line takes from neighbouring belts – nothing
 * crosses and it builds like a manifold. Belts are put in the order needing the fewest splits and merges.
 */
export function staircase(src: End[], dst: End[]): { src: End[]; pieces: Piece[] } {
  const fill = (order: number[]) => {
    const pieces: Piece[] = [];
    let k = 0;
    let left = src[order[0]]?.rate ?? 0;
    dst.forEach((d, j) => {
      let need = d.rate;
      while (need > TOL && k < order.length) {
        const r = Math.min(left, need);
        if (r > TOL) pieces.push({ from: k, to: j, lane: 0, rate: near(left, need) ? left : r });
        need -= r;
        left -= r;
        if (left <= TOL) left = src[order[++k]]?.rate ?? 0;
      }
    });
    return pieces;
  };
  const idx = src.map((_, i) => i);
  // ponytail: every order up to 6 belts (720 tries), beyond that biggest first
  const orders = src.length <= 6 ? perms(idx) : [idx.sort((a, b) => src[b].rate - src[a].rate)];
  let best = { order: idx, pieces: fill(idx) };
  for (const order of orders) {
    const pieces = fill(order);
    if (pieces.length < best.pieces.length) best = { order, pieces };
  }
  return { src: best.order.map((i) => src[i]), pieces: best.pieces };
}

const perms = (a: number[]): number[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

/**
 * how a belt is divided: one splitter for an even 1:1 / 1:1:1 split or an exact 2:1 (3 outputs, 2 merged),
 * a single splitter where one side just fills up (2 outputs), otherwise a manifold: splitters in a row,
 * each taking off what its line needs while the rest flows on (a splitter has at most 3 outputs).
 */
export function splitKind(amounts: number[]): 'even' | '2:1' | 'uneven' | 'manifold' {
  const [a, b] = [...amounts].sort((x, y) => y - x);
  if (amounts.length <= 3 && amounts.every((x) => near(x, amounts[0]))) return 'even';
  if (amounts.length === 2 && near(a, 2 * b)) return '2:1';
  return amounts.length === 2 ? 'uneven' : 'manifold';
}

/** how to build a split giving these amounts (a splitter shares evenly between its connected outputs) */
function splitter(amounts: number[], fluid: boolean) {
  const k = amounts.length;
  if (fluid) {
    // pipes balance themselves: a junction per branch-off (up to 3 outputs each), in a row for more
    return k <= 3
      ? { how: `Pipeline Junction, ${k} outputs`, splitters: 1, mergers: 0 }
      : { how: `${k - 1} Pipeline Junctions in a row, one branch-off per line`, splitters: k - 1, mergers: 0 };
  }
  const kind = splitKind(amounts);
  if (kind === 'even') return { how: `Splitter, ${k} outputs, even split`, splitters: 1, mergers: 0 };
  if (kind === '2:1') return { how: 'Splitter, all 3 outputs; merge 2 of them for the larger share (exact 2:1)', splitters: 1, mergers: 1 };
  if (kind === 'uneven') return { how: 'Splitter, 2 outputs: the side needing less fills up and the rest flows on', splitters: 1, mergers: 0 };
  return { how: `Manifold: ${k - 1} splitters in a row, each takes off what its line needs and passes the rest on`, splitters: k - 1, mergers: 0 };
}

export function describe(title: string, key: string, src: End[], dst: End[], pieces: Piece[], fluid = false): Wiring {
  const per = fluid ? 'm³/min' : '/min';
  const lane = (p: Piece) => `${dst[p.to].label}${dst[p.to].lanes > 1 ? ` (${fluid ? 'pipe' : 'belt'} ${p.lane + 1}/${dst[p.to].lanes})` : ''}`;
  const into = (p: Piece) => pieces.filter((q) => q.to === p.to && q.lane === p.lane);
  const steps: string[] = [];
  let splitters = 0;
  let mergers = 0;
  src.forEach((s, i) => {
    const ps = pieces.filter((p) => p.from === i);
    if (!ps.length) return;
    const head = `${s.label} (${fmt(s.rate)}${per})`;
    if (ps.length === 1) {
      // a belt going whole into a merger is listed in that merger's step
      if (into(ps[0]).length === 1) steps.push(`${head} → straight to ${lane(ps[0])}`);
      return;
    }
    const sp = splitter(ps.map((p) => p.rate), fluid);
    splitters += sp.splitters;
    mergers += sp.mergers;
    steps.push(`${head} → ${sp.how}: ${ps.map((p) => `${fmt(p.rate)}${per} → ${into(p).length > 1 ? (fluid ? 'junction for ' : 'merger for ') : ''}${lane(p)}`).join(', ')}`);
  });
  const done = new Set<string>();
  for (const p of pieces) {
    const k = `${p.to}#${p.lane}`;
    const ins = into(p);
    if (ins.length < 2 || done.has(k)) continue;
    done.add(k);
    mergers += Math.ceil((ins.length - 1) / 2);
    steps.push(`${fluid ? 'Pipeline Junction' : 'Merger'} → ${lane(p)}: ${ins.map((q) => `${fmt(q.rate)}${per} from ${src[q.from].label}`).join(' + ')}`);
  }
  return { key, title, sources: src, sinks: dst, pieces, steps, splitters, mergers, fluid };
}
