import highsLoader from 'highs';
import { belts, buildings, extractors, importWeight, items, pipes, POWER, PURITY, recipes, WATER, WATER_PUMP, type Purity, type Recipe } from './game';

export type Output = { item: string; rate: number; maximize: boolean };
export type Input =
  | { kind: 'rate'; item: string; rate: number }
  | { kind: 'miner'; extractor: string; item: string; purity: Purity; count: number; clock: number };

export type Settings = {
  outputs: Output[];
  inputs: Input[];
  unlimitedRaw: boolean;
  unlimitedWater: boolean;
  alts: string[]; // enabled alternate recipe ids
  buildings: string[]; // enabled production buildings + extractors
  beltMk: number[]; // enabled belt tiers
  pipeMk: number[];
  weights: { resources: number; power: number; buildings: number };
  cheapBelts: boolean;
  underclockLast: boolean;
  overclock: number; // max clock for production machines, 1..2.5
  shards: number; // power shards available
  sinkSurplus: boolean;
  powerBudget?: number; // MW the whole factory may draw from the grid (0/undefined = no limit)
  selfPowered?: boolean; // build power plants in this factory for its own consumption
  extraPower?: number; // internal: MW drawn by things outside the LP (sink), added when self-powered
  exclude?: string[]; // internal: recipe ids left out (trace amounts dropped by solveClean)
};

export type Solution = {
  rates: Map<string, number>; // recipe id -> machine count (at 100%)
  imports: Map<string, number>; // item -> /min taken from inputs
  surplus: Map<string, number>; // item -> /min left over (not a requested output)
  produced: Map<string, number>; // requested outputs -> /min
};

let highsP: ReturnType<typeof highsLoader> | undefined;
// in Node (checks) the loader finds the wasm itself; in the browser Vite serves it as an asset
const highs = () =>
  (highsP ??=
    typeof window === 'undefined'
      ? highsLoader()
      : import('highs/runtime?url').then((m) => highsLoader({ locateFile: () => m.default })));

export const minerRate = (i: Extract<Input, { kind: 'miner' }>) =>
  extractors[i.extractor].rate * PURITY[i.purity] * i.clock * i.count;

/** what one extractor can actually ship: its rate capped by the best unlocked belt/pipe */
export function minerCap(i: Extract<Input, { kind: 'miner' }>, s: Settings) {
  const fluid = items[i.item].fluid;
  const list = (fluid ? pipes : belts).filter((b) => (fluid ? s.pipeMk : s.beltMk).includes(b.mk));
  const cap = list.length && !items[i.item].power ? list[list.length - 1].rate : Infinity; // geothermal power isn't on a belt
  return { one: minerRate({ ...i, count: 1 }), cap, total: Math.min(minerRate({ ...i, count: 1 }), cap) * i.count };
}

/** /min available per item from the input list (Infinity = unlimited) */
export function availability(s: Settings) {
  const avail = new Map<string, number>();
  for (const i of s.inputs) {
    if (i.kind === 'miner' && !s.buildings.includes(i.extractor)) continue; // locked extractor
    avail.set(i.item, (avail.get(i.item) ?? 0) + (i.kind === 'rate' ? i.rate : minerCap(i, s).total));
  }
  for (const id of Object.keys(items)) {
    if (id === WATER ? s.unlimitedWater : s.unlimitedRaw && items[id].raw) avail.set(id, Infinity);
  }
  return avail;
}

export const enabledRecipes = (s: Settings) => {
  const on = new Set(s.buildings);
  const alts = new Set(s.alts);
  const out = new Set(s.exclude ?? []);
  return recipes.filter((r) => on.has(r.building) && (!r.alt || alts.has(r.id)) && !out.has(r.id));
};

const recipePower = (r: Recipe) => r.power ?? buildings[r.building].power;

/**
 * solve, then drop recipes used in trace amounts (< 1% of one machine) and solve again: when several plans are
 * equally good the LP may sprinkle in a recipe at ~0.0005 machines, which in game is a whole idle building.
 * The cleaner plan is kept only if the outputs drop by at most 0.5%.
 */
export async function solveClean(s: Settings): Promise<Solution> {
  let sol = await solve(s);
  const total = (x: Solution) => [...x.produced.values()].reduce((a, b) => a + b, 0);
  for (let i = 0; i < 3; i++) {
    const tiny = [...sol.rates].filter(([, x]) => x < 0.01).map(([id]) => id);
    if (!tiny.length) break;
    try {
      const next = await solve({ ...s, exclude: [...(s.exclude ?? []), ...tiny] });
      if (total(next) < total(sol) * 0.995) break;
      sol = next;
      s = { ...s, exclude: [...(s.exclude ?? []), ...tiny] };
    } catch {
      break; // the trace recipe was actually needed
    }
  }
  return sol;
}

/** Linear program over recipe machine counts; maximize outputs scale `t` first (if any), then minimize weighted cost. */
export async function solve(s: Settings): Promise<Solution> {
  const rs = enabledRecipes(s);
  const avail = availability(s);
  const max = s.outputs.filter((o) => o.maximize);
  const fixed = new Map<string, number>();
  for (const o of s.outputs) if (!o.maximize) fixed.set(o.item, (fixed.get(o.item) ?? 0) + o.rate);
  if (s.selfPowered && s.extraPower) fixed.set(POWER, (fixed.get(POWER) ?? 0) + s.extraPower);

  // item balance rows: production - consumption + import - surplus - target = 0
  const rows = new Map<string, string[]>();
  const term = (item: string, coef: number, v: string) => {
    if (!rows.has(item)) rows.set(item, []);
    rows.get(item)!.push(`${coef >= 0 ? '+' : '-'} ${Math.abs(coef)} ${v}`);
  };
  rs.forEach((r, i) => {
    for (const x of r.outputs) term(x.item, x.rate, `r${i}`);
    for (const x of r.inputs) term(x.item, -x.rate, `r${i}`);
  });
  for (const o of s.outputs) if (!rows.has(o.item)) rows.set(o.item, []);
  // self-powered: every machine's draw (at 100%; underclocked ones draw less) must come from plants built here
  if (s.selfPowered) {
    if (!rows.has(POWER)) rows.set(POWER, []);
    rs.forEach((r, i) => recipePower(r) > 0 && term(POWER, -recipePower(r), `r${i}`));
  }
  const itemIds = [...rows.keys()];
  const bounds: string[] = [];
  const cost: string[] = [];
  const eps = 1e-4;
  const w = s.weights;
  itemIds.forEach((id, k) => {
    term(id, -1, `s${k}`);
    const a = avail.get(id) ?? 0;
    if (a > 0) {
      term(id, 1, `i${k}`);
      if (a !== Infinity) bounds.push(`0 <= i${k} <= ${a}`);
      cost.push(`+ ${(w.resources + eps) * importWeight(id)} i${k}`);
    }
    // tiny surplus penalty keeps the solver from overproducing for free
    cost.push(`+ ${eps} s${k}`);
  });
  rs.forEach((r, i) => cost.push(`+ ${w.power * recipePower(r) + (w.buildings + eps)} r${i}`));
  // MW per 1/min taken from an input: extractors placed by the plan (miners from the inputs, water extractors)
  const extractMW = (id: string) => {
    const per = s.inputs
      .filter((i): i is Extract<Input, { kind: 'miner' }> => i.kind === 'miner' && i.item === id && s.buildings.includes(i.extractor))
      .map((i) => {
        const e = extractors[i.extractor];
        return (e.power * i.clock ** e.exp) / minerCap({ ...i, count: 1 }, s).total;
      });
    if (id === WATER && s.unlimitedWater && s.buildings.includes(WATER_PUMP)) per.push(extractors[WATER_PUMP].power / extractors[WATER_PUMP].rate);
    return per.length ? Math.min(...per) : 0;
  };
  // power: machines at 100% (underclocked machines draw less, so the plan stays within) + extraction
  const powerTerms = [
    ...rs.map((r, i) => `+ ${recipePower(r)} r${i}`),
    ...itemIds.flatMap((id, k) => ((avail.get(id) ?? 0) > 0 && extractMW(id) > 0 ? [`+ ${extractMW(id)} i${k}`] : [])),
  ];
  itemIds.forEach((id, k) => {
    if ((avail.get(id) ?? 0) > 0 && extractMW(id) > 0) {
      cost.push(`+ ${w.power * extractMW(id)} i${k}`);
      if (s.selfPowered) term(POWER, -extractMW(id), `i${k}`); // miners and water extractors need power too
    }
  });
  for (const o of max) term(o.item, -o.rate || -1, 't');

  const constraints = itemIds.map((id, k) => `c${k}: ${rows.get(id)!.join(' ')} = ${fixed.get(id) ?? 0}`);
  if (!s.selfPowered && s.powerBudget && s.powerBudget > 0) constraints.push(`pw: ${powerTerms.join(' ')} <= ${s.powerBudget}`);
  const lp = (obj: string, extra: string[] = []) =>
    `${obj}\nSubject To\n${[...constraints, ...extra].join('\n')}\nBounds\n${bounds.join('\n')}\nEnd`;

  const h = await highs();
  const run = (model: string) => {
    const res = h.solve(model);
    if (res.Status !== 'Optimal') {
      throw new Error(
        res.Status === 'Infeasible'
          ? `No feasible factory: inputs, unlocked recipes or buildings cannot produce the requested outputs${s.selfPowered ? ' and fuel its own power plants' : s.powerBudget ? ' within the power budget' : ''}.`
          : res.Status === 'Unbounded'
            ? 'Output is unbounded – limit the raw resources (turn off "unlimited") to maximize.'
            : `Solver status: ${res.Status}`,
      );
    }
    return res;
  };

  const extra: string[] = [];
  if (max.length) {
    const r1 = run(lp('Maximize\n obj: t'));
    const t = r1.Columns.t.Primal;
    if (t < 1e-6) throw new Error('Nothing can be produced for the maximized outputs with these inputs.');
    extra.push(`tfix: t >= ${t * (1 - 1e-6)}`);
  }
  const res = run(lp(`Minimize\n obj: ${cost.join(' ')}`, extra));
  const col = (v: string) => res.Columns[v]?.Primal ?? 0;

  const sol: Solution = { rates: new Map(), imports: new Map(), surplus: new Map(), produced: new Map() };
  rs.forEach((r, i) => col(`r${i}`) > 1e-7 && sol.rates.set(r.id, col(`r${i}`)));
  const t = col('t');
  itemIds.forEach((id, k) => {
    if (col(`i${k}`) > 1e-6) sol.imports.set(id, col(`i${k}`));
    if (col(`s${k}`) > 1e-6) sol.surplus.set(id, col(`s${k}`));
  });
  for (const o of s.outputs) {
    const v = o.maximize ? (o.rate || 1) * t : o.rate;
    sol.produced.set(o.item, (sol.produced.get(o.item) ?? 0) + v);
  }
  return sol;
}
