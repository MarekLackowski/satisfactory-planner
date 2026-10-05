// Rates every alternate recipe S..F against the standard recipe for the same product, over the whole chain.
// For each alternate: cheapest chain for 1/min of its product using only standard recipes, vs the cheapest
// chain that must make the product with this alternate (everything upstream still standard).
// Compared: raw resources weighted by world scarcity (55%), power incl. extraction (25%), buildings (10%),
// simplicity (10%): how many different raw resources the chain has to mine.
// Run: npx tsx scripts/tiers.ts  -> src/data/tiers.json
import fs from 'node:fs';
import highsLoader from 'highs';
import { buildings, importWeight, items, POWER, recipes, WATER, type Recipe } from '../src/game';

const EXTRACT_MW: Record<string, number> = { solid: 15 / 120, fluid: 40 / 120 }; // Miner Mk.2 / Oil Extractor at normal purity
const extractMW = (id: string) => (id === WATER ? 20 / 120 : items[id].fluid ? EXTRACT_MW.fluid : EXTRACT_MW.solid);
const power = (r: Recipe) => r.power ?? buildings[r.building].power;
// standard chain = every non-alternate recipe, except the Converter turning one ore into another (would distort ore costs)
const usable = (r: Recipe) => !(r.building === 'Build_Converter_C' && r.outputs.some((o) => items[o.item].raw));
// what can be taken from the world: ores/fluids, plus things no recipe makes (wood, leaves, mycelia, alien remains)
const made = new Set(recipes.flatMap((r) => r.outputs.map((o) => o.item)));
const importable = (id: string) => id !== POWER && (items[id].raw || !made.has(id));
// scarcity counts, but softened (sqrt) so e.g. copper isn't 2.5× the cost of iron. Hand-gathered things can't be
// automated (wood, leaves, mycelia, remains) and power slugs are finite, so they are expensive.
const weight = (id: string) =>
  items[id].raw ? Math.sqrt(importWeight(id)) : /Power Slug/.test(items[id].name) ? 100 : 10;
const standard = recipes.filter((r) => !r.alt && usable(r));

const h = await highsLoader();
type Cost = { res: number; power: number; machines: number; raw: Record<string, number>; rawTypes: number; steps: number };

function cheapest(target: string, pool: Recipe[], force?: Recipe): Cost | null {
  const rows = new Map<string, string[]>();
  const term = (item: string, coef: number, v: string) => (rows.get(item) ?? rows.set(item, []).get(item)!).push(`${coef >= 0 ? '+' : '-'} ${Math.abs(coef)} ${v}`);
  pool.forEach((r, i) => {
    for (const x of r.outputs) term(x.item, x.rate, `r${i}`);
    for (const x of r.inputs) term(x.item, -x.rate, `r${i}`);
  });
  if (!rows.has(target)) return null;
  const ids = [...rows.keys()];
  const obj: string[] = [];
  ids.forEach((id, k) => {
    term(id, -1, `s${k}`); // surplus allowed (byproducts get no credit)
    if (importable(id)) {
      term(id, 1, `i${k}`);
      obj.push(`+ ${weight(id) + 1e-4 * extractMW(id)} i${k}`);
    }
  });
  pool.forEach((r, i) => obj.push(`+ ${1e-4 * (power(r) + 1)} r${i}`)); // tie-break: less power, fewer machines
  const cons = ids.map((id, k) => `c${k}: ${rows.get(id)!.join(' ')} = ${id === target ? 1 : 0}`);
  if (force) {
    const f = pool.indexOf(force);
    cons.push(`force: ${force.outputs.find((o) => o.item === target)!.rate} r${f} >= 1`);
  }
  const res = h.solve(`Minimize\n obj: ${obj.join(' ')}\nSubject To\n${cons.join('\n')}\nEnd`);
  if (res.Status !== 'Optimal') {
    if (process.env.DEBUG) console.log('  ', target, force?.name ?? 'standard', res.Status);
    return null;
  }
  const col = (v: string) => res.Columns[v]?.Primal ?? 0;
  const raw: Record<string, number> = {};
  let r = 0;
  let pw = 0;
  ids.forEach((id, k) => {
    const v = col(`i${k}`);
    if (v > 1e-9) {
      raw[id] = v;
      r += weight(id) * v;
      pw += extractMW(id) * v;
    }
  });
  let machines = 0;
  let steps = 0;
  pool.forEach((rec, i) => {
    machines += col(`r${i}`);
    pw += power(rec) * col(`r${i}`);
    if (col(`r${i}`) > 1e-6) steps++;
  });
  // simplicity: how many different things must be mined (water is everywhere) and how many recipe steps
  const rawTypes = Object.keys(raw).filter((id) => id !== WATER).length;
  return { res: r, power: pw, machines, raw, rawTypes, steps };
}

/** the product an alternate is "for": the output named like the recipe, else the first that isn't water */
const product = (r: Recipe) =>
  r.outputs.find((o) => r.name.toLowerCase().includes(items[o.item].name.toLowerCase()))?.item ??
  (r.outputs.find((o) => o.item !== WATER) ?? r.outputs[0]).item;

const TIERS = [['S', 0.45], ['A', 0.2], ['B', 0.05], ['C', -0.05], ['D', -0.25], ['F', -Infinity]] as const;
const out: Record<string, unknown> = {};
const standardMade = new Set(standard.flatMap((r) => r.outputs.map((o) => o.item)));
const unlockOnly = recipes.filter((r) => r.alt && usable(r) && !standardMade.has(product(r)));
const base = new Map<string, Cost | null>();
for (const alt of recipes.filter((r) => r.alt && usable(r))) {
  const item = product(alt);
  if (!base.has(item)) base.set(item, cheapest(item, standard));
  const b = base.get(item)!;
  // some alternates need an ingredient that only another alternate makes (e.g. Packaged Turbofuel): allow those
  const a = cheapest(item, [...standard, alt], alt) ?? cheapest(item, [...standard, ...unlockOnly, alt], alt);
  if (!a) {
    console.log('cannot rate', alt.name);
    continue;
  }
  const ratio = (x: number, y: number) => Math.log2(Math.max(x, 1e-9) / Math.max(y, 1e-9));
  // weights: resources, power, buildings, simplicity, share of "raw types" (vs production steps) in simplicity.
  // Tuned against a community tier list: more weight on simplicity (or counting steps) lowered the agreement.
  const W = (process.env.W ?? '0.55,0.25,0.1,0.1,1').split(',').map(Number);
  const simple = b ? W[4] * ratio(b.rawTypes, a.rawTypes) + (1 - W[4]) * ratio(b.steps, a.steps) : 0;
  const score = b ? W[0] * ratio(b.res, a.res) + W[1] * ratio(b.power, a.power) + W[2] * ratio(b.machines, a.machines) + W[3] * simple : 0;
  const pct = (x: number, y: number) => Math.round((x / y - 1) * 100); // alt vs standard: -30 = 30% less
  out[alt.id] = {
    tier: b ? TIERS.find(([, t]) => score >= t)![0] : 'N', // N: no standard recipe makes it – unlocks something new
    score: +score.toFixed(3),
    item,
    resources: b ? pct(a.res, b.res) : null,
    power: b ? pct(a.power, b.power) : null,
    buildings: b ? pct(a.machines, b.machines) : null,
    rawTypes: [b?.rawTypes ?? null, a.rawTypes], // standard -> alternate
    steps: [b?.steps ?? null, a.steps],
    raw: Object.fromEntries(Object.entries(a.raw).map(([k, v]) => [k, +v.toFixed(3)])),
    baseRaw: b ? Object.fromEntries(Object.entries(b.raw).map(([k, v]) => [k, +v.toFixed(3)])) : null,
  };
}
fs.writeFileSync('src/data/tiers.json', JSON.stringify(out));
const list = Object.entries(out) as [string, { tier: string; score: number }][];
console.log(list.length, 'alternates rated:', Object.fromEntries([...TIERS.map(([t]) => t), 'N'].map((t) => [t, list.filter(([, v]) => v.tier === t).length])));
for (const [id, v] of list.sort((x, y) => y[1].score - x[1].score)) console.log(v.tier, v.score.toFixed(2).padStart(6), recipes.find((r) => r.id === id)!.name);
