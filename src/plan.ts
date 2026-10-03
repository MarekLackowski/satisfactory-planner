import {
  belts, buildings, costs, extractors, items, JUNCTION, MERGER, nameOf, pipes, recipeById, SPLITTER, WATER, WATER_PUMP,
  type Conveyor, type Flow,
} from './game';
import { minerCap, solve, type Settings, type Solution } from './solver';
import { describe, wire, type End, type Wiring } from './wiring';

export type Machine = { clock: number; shards: number };
export type Line = {
  machines: number[]; // indexes into group.machines
  inputs: { item: string; segs: number[] }[]; // manifold: segs[j] = flow on the belt feeding machine j onward
  outputs: { item: string; segs: number[] }[]; // collector: segs[j] = flow after machine j merged in
};
export type Group = {
  id: string;
  kind: 'recipe' | 'extract' | 'input' | 'output' | 'sink';
  label: string;
  building?: string; // building / extractor id (for icon + cost)
  recipe?: string;
  machines: Machine[];
  lines: Line[];
  inputs: Flow[];
  outputs: Flow[];
  power: number;
  note?: string;
};
export type Edge = {
  id: string; from: string; to: string; item: string; rate: number; belts: Conveyor[];
  laneRates: number[]; // flow on each parallel belt (set by the wiring at the producer's output)
};
export type Plan = {
  groups: Group[];
  edges: Edge[];
  power: number;
  cost: Map<string, number>;
  buildingCount: Map<string, number>;
  warnings: string[];
  wirings: Wiring[]; // build recipe for every group port where belts branch, join or continue
  generated: number; // MW made by power plants in the plan (not subtracted from power)
};

const EPS = 1e-6;
const MAX_PER_LINE = 12; // ponytail: display/manifold cap; real manifolds can be longer

export function conveyorFor(rate: number, fluid: boolean, s: Settings): Conveyor {
  const list = (fluid ? pipes : belts).filter((b) => (fluid ? s.pipeMk : s.beltMk).includes(b.mk));
  if (!list.length) return (fluid ? pipes : belts)[0];
  const top = list[list.length - 1];
  return s.cheapBelts ? (list.find((b) => b.rate >= rate - EPS) ?? top) : top;
}
export const maxConveyor = (fluid: boolean, s: Settings) => conveyorFor(Infinity, fluid, s);

/** split a flow into parallel conveyors that each fit */
export function conveyorsFor(rate: number, fluid: boolean, s: Settings): Conveyor[] {
  const cap = maxConveyor(fluid, s).rate;
  const n = Math.max(1, Math.ceil(rate / cap - EPS));
  return Array.from({ length: n }, () => conveyorFor(rate / n, fluid, s));
}

function clocks(x: number, s: Settings, shardsLeft: { n: number }): Machine[] {
  const out: Machine[] = [];
  if (s.overclock > 1 + EPS) {
    const perMachine = Math.ceil((s.overclock - 1) / 0.5 - EPS);
    const nOC = Math.min(Math.floor(x / s.overclock + EPS), Math.floor(shardsLeft.n / perMachine));
    for (let i = 0; i < nOC; i++) out.push({ clock: s.overclock, shards: perMachine });
    shardsLeft.n -= nOC * perMachine;
    x -= nOC * s.overclock;
  }
  if (x > EPS) {
    const n = Math.ceil(x - EPS);
    for (let i = 0; i < n; i++) {
      const clock = s.underclockLast ? (i < n - 1 ? 1 : x - (n - 1)) : x / n;
      out.push({ clock: Math.min(1, clock), shards: 0 });
    }
  }
  return out;
}

function buildLines(g: Group, perMachine: (m: Machine) => { inputs: Flow[]; outputs: Flow[] }, s: Settings) {
  const n = g.machines.length;
  let lines = Math.ceil(n / MAX_PER_LINE);
  for (const f of [...g.inputs, ...g.outputs]) {
    lines = Math.max(lines, Math.ceil(f.rate / maxConveyor(items[f.item].fluid, s).rate - EPS));
  }
  const split = (count: number): Line[] => {
    const per = Math.ceil(n / count);
    const out: Line[] = [];
    for (let start = 0; start < n; start += per) {
      const idx = Array.from({ length: Math.min(per, n - start) }, (_, j) => start + j);
      const flows = idx.map((i) => perMachine(g.machines[i]));
      out.push({
        machines: idx,
        inputs: g.inputs.map(({ item }) => {
          const r = flows.map((f) => f.inputs.find((x) => x.item === item)!.rate);
          return { item, segs: r.map((_, j) => r.slice(j).reduce((a, b) => a + b, 0)) };
        }),
        outputs: g.outputs.map(({ item }) => {
          const r = flows.map((f) => f.outputs.find((x) => x.item === item)!.rate);
          return { item, segs: r.map((_, j) => r.slice(0, j + 1).reduce((a, b) => a + b, 0)) };
        }),
      });
    }
    return out;
  };
  const fits = (ls: Line[]) =>
    ls.every((l) => [...l.inputs, ...l.outputs].every((f) => Math.max(...f.segs) <= maxConveyor(items[f.item].fluid, s).rate + EPS));
  // more lines until every manifold segment fits the best conveyor (a single machine over capacity can't be fixed)
  let ls = split(Math.min(lines, n));
  for (let c = lines + 1; !fits(ls) && c <= n; c++) ls = split(c);
  g.lines = ls;
}

export function buildPlan(sol: Solution, s: Settings): Plan {
  const groups: Group[] = [];
  const warnings: string[] = [];
  const shardsLeft = { n: s.shards };

  // ---- sources: miners/extractors, rate inputs, unlimited imports
  const supply = new Map(sol.imports);
  const take = (item: string, max: number) => {
    const v = Math.min(max, supply.get(item) ?? 0);
    supply.set(item, (supply.get(item) ?? 0) - v);
    return v;
  };
  s.inputs.forEach((inp, k) => {
    if (inp.kind === 'miner' && !s.buildings.includes(inp.extractor)) {
      warnings.push(`${nameOf(inp.extractor)} is locked – that input is ignored.`);
    } else if (inp.kind === 'miner') {
      const e = extractors[inp.extractor];
      const fluid = items[inp.item].fluid;
      const { one, cap, total } = minerCap(inp, s);
      if (one > cap + EPS) warnings.push(`${e.name} on ${inp.purity} ${nameOf(inp.item)} makes ${one}/min but best ${fluid ? 'pipe' : 'belt'} carries ${cap}/min – output capped.`);
      const used = take(inp.item, total);
      // the input says how many extractors are available; place only as many as the factory needs
      const per = Math.min(one, cap); // what one extractor ships at the chosen clock
      const need = used / per; // in extractors' worth
      const n = used > 0.01 ? Math.min(inp.count, Math.ceil(need - 1e-6)) : 0;
      if (!n) {
        warnings.push(`${e.name} on ${inp.purity} ${nameOf(inp.item)} isn't needed for these outputs.`);
        return;
      }
      // all at the chosen rate except the last (underclock-last), or all evenly; clocks lowered to what actually ships
      const share = (i: number) => (s.underclockLast ? (i < n - 1 ? 1 : need - (n - 1)) : need / n);
      const machines = Array.from({ length: n }, (_, i) => {
        const clock = inp.clock * ((per * Math.min(1, share(i))) / one);
        return { clock, shards: Math.max(0, Math.ceil((clock - 1) / 0.5 - EPS)) };
      });
      const g: Group = {
        id: `ex${k}`, kind: 'extract', label: `${e.name} · ${inp.purity} ${nameOf(inp.item)}`, building: e.id,
        machines, lines: [], inputs: [], outputs: [{ item: inp.item, rate: used }],
        power: machines.reduce((a, m) => a + e.power * m.clock ** e.exp, 0),
        note: inp.count > n ? `${n} of ${inp.count} available extractors needed (${inp.count - n} spare)` : undefined,
      };
      buildLines(g, (m) => ({ inputs: [], outputs: [{ item: inp.item, rate: (one * m.clock) / inp.clock }] }), s);
      groups.push(g);
    }
  });
  s.inputs.forEach((inp, k) => {
    if (inp.kind !== 'rate') return;
    const used = take(inp.item, inp.rate);
    if (used > EPS) groups.push({ id: `in${k}`, kind: 'input', label: `Input: ${nameOf(inp.item)}`, machines: [], lines: [], inputs: [], outputs: [{ item: inp.item, rate: used }], power: 0 });
  });
  for (const [item, rest] of supply) {
    if (rest <= EPS) continue;
    if (item === WATER && s.buildings.includes(WATER_PUMP)) {
      const e = extractors[WATER_PUMP];
      const g: Group = {
        id: 'water', kind: 'extract', label: 'Water Extractors', building: WATER_PUMP,
        machines: clocks(rest / e.rate, { ...s, overclock: 1 }, shardsLeft), lines: [], inputs: [], outputs: [{ item, rate: rest }], power: 0,
      };
      g.power = g.machines.reduce((a, m) => a + e.power * m.clock ** e.exp, 0);
      buildLines(g, (m) => ({ inputs: [], outputs: [{ item, rate: e.rate * m.clock }] }), s);
      groups.push(g);
    } else {
      groups.push({ id: `raw_${item}`, kind: 'input', label: `Input: ${nameOf(item)}`, machines: [], lines: [], inputs: [], outputs: [{ item, rate: rest }], power: 0 });
    }
  }

  // ---- production groups (most machines first get the power shards)
  const prod = [...sol.rates].sort((a, b) => b[1] - a[1]);
  for (const [rid, x] of prod) {
    const r = recipeById[rid];
    const b = buildings[r.building];
    const base = r.power ?? b.power;
    const machines = clocks(x, s, shardsLeft);
    const g: Group = {
      id: rid, kind: 'recipe', label: r.name, building: r.building, recipe: rid, machines, lines: [],
      inputs: r.inputs.map((f) => ({ item: f.item, rate: f.rate * x })),
      outputs: r.outputs.map((f) => ({ item: f.item, rate: f.rate * x })),
      power: machines.reduce((a, m) => a + base * m.clock ** b.exp, 0),
      note: b.generates ? `Generates ${(machines.reduce((a, m) => a + m.clock, 0) * b.generates).toFixed(0)} MW` : undefined,
    };
    const scale = (l: Flow[], c: number) => l.map((f) => ({ item: f.item, rate: f.rate * c }));
    buildLines(g, (m) => ({ inputs: scale(r.inputs, m.clock), outputs: scale(r.outputs, m.clock) }), s);
    groups.push(g);
  }

  // ---- sinks: requested outputs + surplus
  for (const [item, rate] of sol.produced) {
    groups.push({ id: `out_${item}`, kind: 'output', label: `Output: ${nameOf(item)}`, machines: [], lines: [], inputs: [{ item, rate }], outputs: [], power: 0 });
  }
  const solidSurplus = [...sol.surplus].filter(([i]) => !items[i].fluid);
  const fluidSurplus = [...sol.surplus].filter(([i]) => items[i].fluid);
  if (solidSurplus.length && s.sinkSurplus) {
    groups.push({ id: 'sink', kind: 'sink', label: 'AWESOME Sink', machines: [], lines: [], inputs: solidSurplus.map(([item, rate]) => ({ item, rate })), outputs: [], power: 30 * solidSurplus.length });
  }
  const leftover = s.sinkSurplus ? fluidSurplus : [...solidSurplus, ...fluidSurplus];
  if (leftover.length) {
    groups.push({ id: 'surplus', kind: 'output', label: 'Surplus (byproducts)', machines: [], lines: [], inputs: leftover.map(([item, rate]) => ({ item, rate })), outputs: [], power: 0 });
  }

  // ---- flow allocation (greedy transport, producers in group order)
  const edges: Edge[] = [];
  const allItems = new Set(groups.flatMap((g) => g.outputs.map((o) => o.item)));
  for (const item of allItems) {
    const prods = groups.flatMap((g) => g.outputs.filter((o) => o.item === item && o.rate > EPS).map((o) => ({ g, left: o.rate })));
    const cons = groups.flatMap((g) => g.inputs.filter((o) => o.item === item && o.rate > EPS).map((o) => ({ g, left: o.rate })));
    let p = 0;
    for (const c of cons) {
      while (c.left > EPS && p < prods.length) {
        const v = Math.min(c.left, prods[p].left);
        if (v > EPS) {
          const from = prods[p].g.id;
          const bs = conveyorsFor(v, items[item].fluid, s);
          edges.push({ id: `${from}>${c.g.id}:${item}`, from, to: c.g.id, item, rate: v, belts: bs, laneRates: bs.map(() => v / bs.length) });
        }
        c.left -= v;
        prods[p].left -= v;
        if (prods[p].left <= EPS) p++;
      }
    }
  }

  // ---- buildings & cost
  const count = new Map<string, number>();
  const add = (id: string, n: number) => n > 0 && count.set(id, (count.get(id) ?? 0) + n);
  for (const g of groups) {
    if (g.building && g.kind !== 'input') add(g.building, g.machines.length);
    for (const line of g.lines) {
      for (const f of line.inputs) add(items[f.item].fluid ? JUNCTION : SPLITTER, line.machines.length - 1);
      for (const f of line.outputs) add(items[f.item].fluid ? JUNCTION : MERGER, line.machines.length - 1);
    }
  }
  // ---- port wiring: exactly which belt goes where at every group port with production lines
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const lineName = (g: Group, l: number) => `${g.lines.length > 1 ? `Line ${l + 1}` : 'Line'} (${g.lines[l].machines.length}× ${nameOf(g.building!)})`;
  const groupIcon = (g: Group, item: string) => (g.building ? nameOf(g.building) : g.kind === 'sink' ? 'AWESOME Sink' : nameOf(item));
  const wirings: Wiring[] = [];
  // outputs first: they fix how much each parallel belt of a link carries, which the consumer's input then uses
  for (const g of groups) {
    if (!g.lines.length) continue;
    g.outputs.forEach((f, j) => {
      const links = edges.filter((e) => e.from === g.id && e.item === f.item);
      if (!links.length) return;
      const src: End[] = g.lines.map((ln, l) => ({ label: lineName(g, l), icon: nameOf(g.building!), rate: ln.outputs[j].segs[ln.outputs[j].segs.length - 1], lanes: 1, cap: Infinity, ref: `line:${l}` }));
      const dst: End[] = links.map((e) => ({ label: byId[e.to].label, icon: groupIcon(byId[e.to], f.item), rate: e.rate, lanes: e.belts.length, cap: maxConveyor(items[e.item].fluid, s).rate, ref: `edge:${e.id}` }));
      const pieces = wire(src, dst);
      links.forEach((e, k) => {
        e.laneRates = e.belts.map((_, ln) => pieces.filter((p) => p.to === k && p.lane === ln).reduce((s2, p) => s2 + p.rate, 0));
        e.belts = e.laneRates.map((r) => conveyorFor(r, items[e.item].fluid, s)); // e.g. 100/min on Mk.2 next to 33/min on Mk.1
      });
      wirings.push(describe(`${g.label}: ${nameOf(f.item)} out`, `out:${g.id}:${f.item}`, src, dst, pieces));
    });
  }
  for (const g of groups) {
    if (!g.lines.length) continue;
    g.inputs.forEach((f, i) => {
      const links = edges.filter((e) => e.to === g.id && e.item === f.item);
      if (!links.length) return;
      const src: End[] = links.flatMap((e) =>
        e.belts.map((_, k) => ({ label: `${byId[e.from].label} belt${e.belts.length > 1 ? ` ${k + 1}/${e.belts.length}` : ''}`, icon: groupIcon(byId[e.from], f.item), rate: e.laneRates[k], lanes: 1, cap: Infinity, ref: `edge:${e.id}#${k}` })));
      const dst: End[] = g.lines.map((ln, l) => ({ label: lineName(g, l), icon: nameOf(g.building!), rate: ln.inputs[i].segs[0], lanes: 1, cap: Infinity, ref: `line:${l}` }));
      wirings.push(describe(`${g.label}: ${nameOf(f.item)} in`, `in:${g.id}:${f.item}`, src.filter((x) => x.rate > 0.01), dst, wire(src.filter((x) => x.rate > 0.01), dst)));
    });
  }
  for (const w of wirings) {
    const fluid = items[w.key.slice(w.key.lastIndexOf(':') + 1)]?.fluid;
    add(fluid ? JUNCTION : SPLITTER, w.splitters);
    add(fluid ? JUNCTION : MERGER, w.mergers);
  }
  // input/output boxes have no lines: several links leaving or arriving need a splitter/merger chain
  for (const g of groups) {
    if (g.lines.length) continue;
    for (const f of g.outputs) add(items[f.item].fluid ? JUNCTION : SPLITTER, edges.filter((e) => e.from === g.id && e.item === f.item).length - 1);
    for (const f of g.inputs) add(items[f.item].fluid ? JUNCTION : MERGER, edges.filter((e) => e.to === g.id && e.item === f.item).length - 1);
  }

  const cost = new Map<string, number>();
  for (const [id, n] of count) for (const c of costs[id] ?? []) cost.set(c.item, (cost.get(c.item) ?? 0) + c.amount * n);
  const power = groups.reduce((a, g) => a + g.power, 0);
  if (shardsLeft.n < 0) warnings.push('Not enough power shards.');
  if (s.powerBudget && power > s.powerBudget + 0.05) warnings.push(`Uses ${power.toFixed(1)} MW, over the ${s.powerBudget} MW budget (overclocking or the AWESOME Sink draw more than planned).`);
  const generated = groups.reduce((a, g) => a + (g.building && buildings[g.building]?.generates ? g.machines.reduce((x, m) => x + m.clock, 0) * buildings[g.building].generates! : 0), 0);
  return { groups, edges, power, cost, buildingCount: count, warnings, wirings, generated };
}

/**
 * Solve and plan. With a power budget and a maximized output, the LP's linear power (every machine at 100%)
 * overestimates the real draw of underclocked machines, so loosen the LP limit until the real plan fills the
 * budget without going over it.
 */
export async function solvePlan(s: Settings): Promise<Plan> {
  let best = buildPlan(await solve(s), s);
  const B = s.powerBudget;
  if (!B || !s.outputs.some((o) => o.maximize)) return best;
  let lo = B;
  let hi = B * 1.5;
  for (let i = 0; i < 7 && best.power < B * 0.995; i++) {
    const lp = i === 0 ? Math.min(hi, B * (B / Math.max(best.power, 1e-6))) : (lo + hi) / 2;
    try {
      const p = buildPlan(await solve({ ...s, powerBudget: lp }), s);
      if (p.power <= B + 1e-6) {
        best = p;
        lo = lp;
      } else hi = lp;
    } catch {
      hi = lp;
    }
  }
  return best;
}
