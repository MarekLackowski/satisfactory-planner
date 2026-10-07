import { importWeight, recipeById, recipes, WATER } from './game';
import { buildPlan } from './plan';
import { solveClean, type Settings } from './solver';

export type Option = {
  recipes: string[]; // every recipe the plan uses: the new factory is limited to these
  alts: string[]; // alternates among them
  raw: [string, number][]; // raw resource -> /min, most first
  types: number; // raw resource types to mine (water not counted)
  weighted: number; // raw resources weighted by world scarcity
  power: number;
  machines: number;
  score: number; // lower is better: weighted resources, with a penalty for every extra resource type
  tags: string[];
};

const GOALS: Settings['weights'][] = [
  { resources: 1, power: 0, buildings: 0 },
  { resources: 1, power: 0.05, buildings: 1 },
  { resources: 0, power: 1, buildings: 0 },
  { resources: 0, power: 0, buildings: 1 },
];

/**
 * A few different ways to make `rate`/min of `item` with the unlocked recipes: the optimizer's pick for each goal,
 * then the same with one or two raw resources banned (which is what finds plans that mine fewer kinds of resources).
 * Ranked by scarcity-weighted resources, each extra resource type counting +50%.
 */
export async function autoplan(item: string, rate: number, s: Settings, count = 5): Promise<Option[]> {
  const base: Settings = {
    ...s, outputs: [{ item, rate, maximize: false }], inputs: [], unlimitedRaw: true, unlimitedWater: true,
    powerBudget: undefined, selfPowered: false, extraPower: undefined, exclude: undefined, only: undefined,
  };
  const found = new Map<string, Option>();
  const bannedFor = new Map<Option, string[]>(); // what each plan was solved without
  const tried = new Set<string>();
  const run = async (weights: Settings['weights'], banned: string[]) => {
    const k = `${JSON.stringify(weights)}|${[...banned].sort().join()}`;
    if (tried.has(k)) return;
    tried.add(k);
    const exclude = recipes.filter((r) => r.inputs.some((f) => banned.includes(f.item))).map((r) => r.id);
    const st = { ...base, weights, exclude };
    try {
      const sol = await solveClean(st);
      if ((sol.produced.get(item) ?? 0) < rate * 0.99) return;
      const used = [...sol.rates].filter(([, x]) => x > 1e-6).map(([id]) => id).sort();
      if (found.has(used.join())) return;
      const raw = [...sol.imports].filter(([, v]) => v > 1e-6).sort((a, b) => b[1] - a[1]);
      const weighted = raw.reduce((a, [id, v]) => a + v * importWeight(id), 0);
      const types = raw.filter(([id]) => id !== WATER).length;
      const plan = buildPlan(sol, st);
      const o: Option = {
        recipes: used,
        alts: used.filter((id) => recipeById[id]?.alt),
        raw, types, weighted,
        power: plan.power,
        machines: plan.groups.filter((g) => g.kind === 'recipe').reduce((a, g) => a + g.machines.length, 0),
        score: weighted * (1 + 0.5 * Math.max(0, types - 1)),
        tags: [],
      };
      found.set(used.join(), o);
      bannedFor.set(o, banned);
    } catch {
      // can't be made that way
    }
  };
  for (const w of GOALS) await run(w, []);
  // ban the resources the plans found so far use, one and then two at a time
  for (let depth = 0; depth < 2; depth++) {
    for (const o of [...found.values()]) {
      const banned = bannedFor.get(o)!;
      if (banned.length !== depth) continue;
      // ponytail: capped at 30 solves, plenty to show a handful of options for one product
      for (const [id] of o.raw) if (id !== WATER && id !== item && tried.size < 30) await run(GOALS[0], [...banned, id]);
    }
  }
  // the same resources in about the same amounts is the same option to the player: keep the better one
  const all: Option[] = [];
  for (const o of [...found.values()].sort((a, b) => a.score - b.score)) {
    const same = (p: Option) => p.raw.map(([id]) => id).sort().join() === o.raw.map(([id]) => id).sort().join() && Math.abs(p.weighted - o.weighted) <= 0.05 * o.weighted;
    if (!all.some(same)) all.push(o);
  }
  const best = (f: (o: Option) => number, tag: string) => {
    const m = Math.min(...all.map(f));
    all.find((o) => f(o) === m)?.tags.push(tag);
  };
  best((o) => o.score, 'Recommended');
  best((o) => o.types, 'Fewest resources');
  best((o) => o.weighted, 'Least mining');
  best((o) => o.power, 'Least power');
  best((o) => o.machines, 'Fewest machines');
  // the tagged ones first, then the rest by score
  return [...all.filter((o) => o.tags.length), ...all.filter((o) => !o.tags.length)].slice(0, count);
}

