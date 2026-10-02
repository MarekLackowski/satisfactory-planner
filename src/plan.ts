import {
  belts, buildings, costs, extractors, items, JUNCTION, MERGER, nameOf, pipes, recipeById, SPLITTER, WATER, WATER_PUMP,
  type Conveyor, type Flow,
} from './game';
import { minerCap, type Settings, type Solution } from './solver';

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
export type Edge = { id: string; from: string; to: string; item: string; rate: number; belts: Conveyor[] };
export type Plan = {
  groups: Group[];
  edges: Edge[];
  power: number;
  cost: Map<string, number>;
  buildingCount: Map<string, number>;
  warnings: string[];
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
      const g: Group = {
        id: `ex${k}`, kind: 'extract', label: `${e.name} · ${inp.purity} ${nameOf(inp.item)}`, building: e.id,
        machines: Array.from({ length: inp.count }, () => ({ clock: inp.clock, shards: Math.max(0, Math.ceil((inp.clock - 1) / 0.5 - EPS)) })),
        lines: [], inputs: [], outputs: [{ item: inp.item, rate: used }],
        power: inp.count * e.power * inp.clock ** e.exp,
        note: total - used > 0.05 ? `${(total - used).toFixed(1)}/min unused` : undefined,
      };
      buildLines(g, () => ({ inputs: [], outputs: [{ item: inp.item, rate: used / inp.count }] }), s);
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
          edges.push({ id: `${from}>${c.g.id}:${item}`, from, to: c.g.id, item, rate: v, belts: conveyorsFor(v, items[item].fluid, s) });
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
  // at each port the links (with their parallel belts) meet one belt per line: nothing is needed when n belts
  // just continue as n belts, otherwise splitters/mergers to go from one count to the other
  const portJoins = (links: Edge[], lines: number, kind: string, item: string) => {
    const belts = links.reduce((a, e) => a + e.belts.length, 0);
    const sides = Math.max(lines, 1);
    if (links.length <= 1 && belts === sides) return;
    add(items[item].fluid ? JUNCTION : kind, Math.max(belts, sides) - 1);
  };
  for (const g of groups) {
    for (const f of g.inputs) portJoins(edges.filter((e) => e.to === g.id && e.item === f.item), g.lines.length, g.lines.length > 1 ? SPLITTER : MERGER, f.item);
    for (const f of g.outputs) portJoins(edges.filter((e) => e.from === g.id && e.item === f.item), g.lines.length, edges.filter((e) => e.from === g.id && e.item === f.item).length > 1 ? SPLITTER : MERGER, f.item);
  }

  const cost = new Map<string, number>();
  for (const [id, n] of count) for (const c of costs[id] ?? []) cost.set(c.item, (cost.get(c.item) ?? 0) + c.amount * n);
  const power = groups.reduce((a, g) => a + g.power, 0);
  if (shardsLeft.n < 0) warnings.push('Not enough power shards.');
  return { groups, edges, power, cost, buildingCount: count, warnings };
}
