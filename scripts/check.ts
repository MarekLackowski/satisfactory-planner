// Self-check of solver + plan. Run: npx tsx scripts/check.ts
import assert from 'node:assert/strict';
import { buildings, extractors, recipes } from '../src/game';
import { layout } from '../src/layout';
import { buildPlan, conveyorFor, solvePlan } from '../src/plan';
import { buildSim, step } from '../src/sim';
import { solve, type Settings } from '../src/solver';

const base: Settings = {
  outputs: [], inputs: [], unlimitedRaw: true, unlimitedWater: true, alts: [],
  buildings: [...Object.keys(buildings), ...Object.keys(extractors)],
  beltMk: [1, 2, 3, 4, 5, 6], pipeMk: [1, 2],
  weights: { resources: 1, power: 0, buildings: 0 },
  cheapBelts: false, underclockLast: true, overclock: 1, shards: 0, sinkSurplus: true,
};
const id = (name: string) => recipes.find((r) => r.outputs[0].item.includes(name))!.outputs[0].item;
const near = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-3, `${msg}: ${a} != ${b}`);

// 1) 20 Iron Plate/min, no alts: 30 iron ore, 1 smelter, 1 constructor, 2 machines total
{
  const s = { ...base, outputs: [{ item: 'Desc_IronPlate_C', rate: 20, maximize: false }] };
  const sol = await solve(s);
  near(sol.imports.get('Desc_OreIron_C')!, 30, 'iron ore');
  const p = buildPlan(sol, s);
  near(p.power, 8, 'power');
  assert.equal(p.buildingCount.get('Build_SmelterMk1_C'), 1);
}

// 2) maximize Reinforced Iron Plate from 2 normal Mk.1 iron miners (120 ore) with Mk.1 belts only
{
  const s: Settings = {
    ...base, unlimitedRaw: false, beltMk: [1],
    outputs: [{ item: id('IronPlateReinforced'), rate: 1, maximize: true }],
    inputs: [{ kind: 'miner', extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 'normal', count: 2, clock: 1 }],
  };
  const sol = await solve(s);
  // 120 ore -> 120 ingot; RIP = 6 plate + 12 screw per 1 (12s) => 5/min uses 30 plate(45 ingot) + 60 screw(15 rod = 15 ingot)
  near(sol.produced.get('Desc_IronPlateReinforced_C')!, 120 / 12, 'RIP max');
  const p = buildPlan(sol, s);
  for (const e of p.edges) for (const b of e.belts) assert.ok(b.rate + 1e-6 >= e.rate / e.belts.length, `belt overloaded ${e.id}`);
  for (const g of p.groups) for (const l of g.lines) for (const f of [...l.inputs, ...l.outputs]) for (const v of f.segs) assert.ok(v <= 60 + 1e-6, `manifold over Mk.1 in ${g.label}`);
}

// 2b) pure Mk.1 miner (120/min) on Mk.1 belts ships only 60/min and nothing else appears from nowhere
{
  const s: Settings = {
    ...base, unlimitedRaw: false, beltMk: [1],
    outputs: [{ item: 'Desc_IronIngot_C', rate: 1, maximize: true }],
    inputs: [{ kind: 'miner', extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 'pure', count: 1, clock: 1 }],
  };
  const sol = await solve(s);
  near(sol.imports.get('Desc_OreIron_C')!, 60, 'capped miner');
  assert.ok(!buildPlan(sol, s).groups.some((g) => g.kind === 'input'), 'no phantom input');
}

// 2c) item simulation delivers the planned rate through manifolds, splitters and parallel belts
{
  const s: Settings = { ...base, beltMk: [1], outputs: [{ item: 'Desc_IronPlateReinforced_C', rate: 10, maximize: false }] };
  const l = layout(buildPlan(await solve(s), s), s);
  const sim = buildSim(l);
  const out = sim.belts.filter((b) => b.seg.edge?.includes('>out_'));
  const before = out.reduce((a, b) => a + b.sunk, 0);
  for (let t = 0; t < 600; t += 0.05) step(sim, 0.05);
  const per = ((out.reduce((a, b) => a + b.sunk, 0) - before) / 600) * 60;
  assert.ok(Math.abs(per - 10) < 0.5, `simulated output ${per.toFixed(2)}/min, planned 10`);
  for (const b of sim.belts) for (const lane of b.lanes) for (let i = 1; i < lane.length; i++) assert.ok(lane[i - 1].d - lane[i].d >= 14 - 1e-6, 'items overlap');
  // every manifold machine except the last sits behind a splitter, every collector join is a merger
  const plan = buildPlan(await solve(s), s);
  const splits = plan.groups.reduce((a, g) => a + g.lines.reduce((x, ln) => x + ln.inputs.length * (ln.machines.length - 1), 0), 0);
  const merges = plan.groups.reduce((a, g) => a + g.lines.reduce((x, ln) => x + ln.outputs.length * (ln.machines.length - 1), 0), 0);
  assert.ok(sim.junctions.filter((j) => j.kind === 'splitter').length >= splits, 'splitters shown');
  assert.ok(sim.junctions.filter((j) => j.kind === 'merger').length >= merges, 'mergers shown');
}

// 2d) n parallel belts feeding n lines go straight in: no splitter at that port
{
  const s: Settings = {
    ...base, unlimitedRaw: false, beltMk: [1],
    outputs: [{ item: 'Desc_IronIngot_C', rate: 1, maximize: true }],
    inputs: [{ kind: 'miner', extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 'impure', count: 4, clock: 1 }],
  };
  const l = layout(buildPlan(await solve(s), s), s);
  const smelt = l.nodes.find((n) => n.group.id === 'Recipe_IngotIron_C')!;
  assert.equal(smelt.group.lines.length, 2);
  const port = smelt.inPort.Desc_OreIron_C;
  assert.ok(!buildSim(l).junctions.some((j) => Math.hypot(j.x - port.x, j.y - port.y) < 1), 'no splitter where 2 belts feed 2 lines');
}

// 2e) build recipe at a port: the user's RIP factory splits only line 2 of the smelters, 30/30;
// the simulation sends items onto exactly those belts
{
  const s: Settings = {
    ...base, unlimitedRaw: false, beltMk: [1], cheapBelts: true, alts: ['Recipe_Alternate_Screw_C'],
    outputs: [{ item: 'Desc_IronPlateReinforced_C', rate: 10, maximize: true }],
    inputs: [{ kind: 'miner', extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 'impure', count: 4, clock: 1 }],
  };
  const p = buildPlan(await solve(s), s);
  const w = p.wirings.find((x) => x.key === 'out:Recipe_IngotIron_C:Desc_IronIngot_C')!;
  assert.equal(w.splitters, 1);
  assert.equal(w.mergers, 0);
  assert.ok(w.steps.some((t) => t.includes('even split')), w.steps.join(' | '));
  assert.ok(!p.wirings.find((x) => x.key === 'in:Recipe_IngotIron_C:Desc_OreIron_C')!.splitters, 'ore goes straight in');
  const l = layout(p, s);
  const sim = buildSim(l);
  const plate = sim.belts.find((b) => b.seg.edge?.startsWith('Recipe_IngotIron_C>Recipe_IronPlate_C'))!;
  const f0 = [...plate.fed];
  for (let t = 0; t < 600; t += 0.05) step(sim, 0.05);
  const per = plate.fed.map((n, i) => ((n - f0[i]) / 600) * 60);
  const want = p.edges.find((e) => e.id === plate.seg.edge)!.laneRates;
  per.forEach((r, i) => assert.ok(Math.abs(r - want[i]) < 1, `lane ${i}: ${r.toFixed(1)}/min, recipe ${want[i]}`));
}

// 2f) 3 available normal Mk.1 miners but only ~half a miner of ore needed: place 1, underclocked
{
  const s: Settings = {
    ...base, unlimitedRaw: false, beltMk: [1],
    outputs: [{ item: 'Desc_IronPlate_C', rate: 20, maximize: false }],
    inputs: [{ kind: 'miner', extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 'normal', count: 3, clock: 1 }],
  };
  const p = buildPlan(await solve(s), s);
  const g = p.groups.find((x) => x.kind === 'extract')!;
  assert.equal(g.machines.length, 1);
  near(g.machines[0].clock, 0.5, 'miner clock'); // 30 ore of 60
  assert.equal(p.buildingCount.get('Build_MinerMk1_C'), 1);
  assert.ok(g.note?.includes('2 spare'), g.note);
}

// 2g) power budget: max Smart Plating from 3 normal Mk.1 miners within 60 MW
{
  const s: Settings = {
    ...base, unlimitedRaw: false, unlimitedWater: false, beltMk: [1, 2], sinkSurplus: false, buildings: ['Build_ConstructorMk1_C', 'Build_SmelterMk1_C', 'Build_AssemblerMk1_C', 'Build_MinerMk1_C'],
    outputs: [{ item: 'Desc_SpaceElevatorPart_1_C', rate: 1, maximize: true }],
    inputs: [{ kind: 'miner', extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 'normal', count: 3, clock: 1 }],
    powerBudget: 60,
  };
  const p = buildPlan(await solve(s), s);
  assert.ok(p.power <= 60 + 1e-6, `power ${p.power}`);
  assert.ok(p.power > 50, `budget mostly used: ${p.power}`);
}

// 2h) cheapest belts: every parallel belt gets the tier of its own flow (rotor screws: 100/min Mk.2 next to 33/min Mk.1)
{
  const s: Settings = {
    ...base, unlimitedRaw: false, beltMk: [1, 2], cheapBelts: true, alts: ['Recipe_Alternate_Screw_C'],
    buildings: ['Build_ConstructorMk1_C', 'Build_SmelterMk1_C', 'Build_AssemblerMk1_C', 'Build_MinerMk1_C'],
    outputs: [{ item: 'Desc_Rotor_C', rate: 1, maximize: true }],
    inputs: [{ kind: 'miner', extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 'normal', count: 1, clock: 1 }],
  };
  const l = layout(await solvePlan(s), s);
  for (const sg of l.segs) {
    sg.conv.forEach((c, i) => {
      assert.ok(sg.laneRates[i] <= c.rate + 0.01, `overloaded belt: ${sg.laneRates[i]} on Mk.${c.mk}`);
      assert.equal(c.mk, conveyorFor(sg.laneRates[i], sg.fluid, s).mk, `${sg.edge ?? 'internal'}: ${sg.laneRates[i]}/min should use the cheapest tier`);
    });
  }
  const screws = l.segs.find((x) => x.edge?.includes('Desc_IronScrew_C') && x.edge.includes('Rotor'))!;
  assert.deepEqual(screws.conv.map((c) => c.mk).sort(), [1, 2]);
}

// 2i) belts inside groups: feeds never cross the manifold rows of earlier items (rotor: 5 -> 1 crossing)
{
  const s: Settings = {
    ...base, unlimitedRaw: false, beltMk: [1, 2], cheapBelts: true, alts: ['Recipe_Alternate_Screw_C'],
    buildings: ['Build_ConstructorMk1_C', 'Build_SmelterMk1_C', 'Build_AssemblerMk1_C', 'Build_MinerMk1_C'],
    outputs: [{ item: 'Desc_Rotor_C', rate: 1, maximize: true }],
    inputs: [{ kind: 'miner', extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 'normal', count: 1, clock: 1 }],
  };
  const l = layout(await solvePlan(s), s);
  const h: { y: number; x1: number; x2: number }[] = [];
  const v: { x: number; y1: number; y2: number }[] = [];
  for (const sg of l.segs.filter((x) => !x.edge)) {
    for (let i = 1; i < sg.pts.length; i++) {
      const [a, b] = [sg.pts[i - 1], sg.pts[i]];
      if (a.y === b.y) h.push({ y: a.y, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x) });
      else v.push({ x: a.x, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) });
    }
  }
  const n = h.reduce((t, p) => t + v.filter((q) => q.x > p.x1 + 1 && q.x < p.x2 - 1 && p.y > q.y1 + 1 && p.y < q.y2 - 1).length, 0);
  assert.ok(n <= 1, `${n} crossings inside groups`);
}

// 2j) plutonium needs Uranium Waste, which only a Nuclear Power Plant burning uranium rods makes
for (const item of ['Desc_PlutoniumPellet_C', 'Desc_PlutoniumFuelRod_C', 'Desc_NonFissibleUranium_C']) {
  const s: Settings = { ...base, outputs: [{ item, rate: 1, maximize: false }] };
  const p = await solvePlan(s);
  const plant = p.groups.find((g) => g.building === 'Build_GeneratorNuclear_C');
  assert.ok(plant, `${item}: nuclear plant in the plan`);
  assert.ok(p.generated > 0 && plant!.note?.startsWith('Generates'), 'reports generated power');
  await assert.rejects(solvePlan({ ...s, buildings: s.buildings.filter((b) => b !== 'Build_GeneratorNuclear_C') }), /No feasible/);
}

// 2k) power planning
{
  const coalOnly = (s: Settings): Settings => ({ ...s, buildings: s.buildings.filter((b) => !b.startsWith('Build_Generator') || b === 'Build_GeneratorCoal_C') });
  // a 600 MW coal plant: 8 generators (75 MW), 120 coal/min, 360 m³ water/min
  {
    const s = coalOnly({ ...base, outputs: [{ item: 'MW', rate: 600, maximize: false }] });
    const p = await solvePlan(s);
    const gen = p.groups.find((g) => g.building === 'Build_GeneratorCoal_C')!;
    assert.equal(gen.machines.length, 8);
    near(gen.inputs.find((f) => f.item === 'Desc_Coal_C')!.rate, 120, 'coal');
    near(gen.inputs.find((f) => f.item === 'Desc_Water_C')!.rate, 360, 'water');
    near(p.generated, 600, 'generated');
    assert.ok(!p.edges.some((e) => e.item === 'MW'), 'power is never a belt');
  }
  // self-powered: plants are added for the factory's own draw (machines + miners + water extractors)
  {
    const s = coalOnly({ ...base, selfPowered: true, outputs: [{ item: 'Desc_IronPlate_C', rate: 60, maximize: false }] });
    const p = await solvePlan(s);
    assert.ok(p.groups.some((g) => g.building === 'Build_GeneratorCoal_C'), 'coal plant built');
    assert.ok(p.generated >= p.power - 0.5, `generated ${p.generated} for ${p.power}`);
    assert.ok(!p.warnings.some((w) => w.includes('need')), p.warnings.join());
    await assert.rejects(solvePlan({ ...s, buildings: s.buildings.filter((b) => !b.startsWith('Build_Generator')) }), /fuel its own power plants/);
  }
  // self-powered with an AWESOME Sink (its 30 MW only appears in the plan): still fully covered
  {
    const s: Settings = { ...base, selfPowered: true, cheapBelts: true, beltMk: [1, 2, 3, 4], buildings: base.buildings.filter((b) => b !== 'Build_GeneratorNuclear_C' && b !== 'Build_Converter_C'), outputs: [{ item: 'Desc_IronPlateReinforced_C', rate: 10, maximize: false }] };
    const p = await solvePlan(s);
    assert.ok(p.generated >= p.power - 0.5, `generated ${p.generated.toFixed(1)} for ${p.power.toFixed(1)} MW`);
  }
  // geothermal on 2 pure geysers: 800 MW, nothing on belts
  {
    const s: Settings = {
      ...base, unlimitedRaw: false,
      outputs: [{ item: 'MW', rate: 1, maximize: true }],
      inputs: [{ kind: 'miner', extractor: 'Build_GeneratorGeoThermal_C', item: 'MW', purity: 'pure', count: 2, clock: 1 }],
    };
    const p = await solvePlan(s);
    near(p.generated, 800, 'geothermal');
    assert.equal(p.edges.length, 0);
  }
}

// 3) infeasible: no buildings
await assert.rejects(solve({ ...base, buildings: [], outputs: [{ item: 'Desc_IronPlate_C', rate: 10, maximize: false }] }));

// 4) unbounded maximize with unlimited raw
await assert.rejects(solve({ ...base, outputs: [{ item: 'Desc_IronPlate_C', rate: 1, maximize: true }] }), /unbounded/);

// 5) heavy chain solves and every recipe group is fed
{
  const s = { ...base, alts: recipes.filter((r) => r.alt).map((r) => r.id), outputs: [{ item: id('ModularFrameHeavy'), rate: 10, maximize: false }] };
  const p = buildPlan(await solve(s), s);
  for (const g of p.groups.filter((g) => g.kind === 'recipe')) {
    for (const f of g.inputs) {
      const fed = p.edges.filter((e) => e.to === g.id && e.item === f.item).reduce((a, e) => a + e.rate, 0);
      near(fed, f.rate, `${g.label} fed ${f.item}`);
    }
  }
  const l = layout(p, s);
  assert.ok(l.nodes.every((n) => Number.isFinite(n.x + n.y + n.w + n.h)), 'layout positions');
  assert.ok(l.segs.every((g) => Number.isFinite(g.len)), 'segment lengths');
  assert.ok(layout(p, s, 'LR').segs.every((g) => Number.isFinite(g.len)), 'LR segment lengths');
  // links between groups: few bends, never through another group
  for (const dir of ['TB', 'LR'] as const) {
    const L = layout(p, s, dir);
    for (const sg of L.segs.filter((x) => x.edge)) {
      const [from, rest] = sg.edge!.split('>');
      const to = rest.slice(0, rest.lastIndexOf(':'));
      assert.ok(sg.pts.length - 2 <= 4, `${dir} ${sg.edge}: ${sg.pts.length - 2} bends`);
      for (const n of L.nodes.filter((n) => n.group.id !== from && n.group.id !== to)) {
        for (let i = 1; i < sg.pts.length; i++) {
          const [a, b] = [sg.pts[i - 1], sg.pts[i]];
          const inside = Math.max(a.x, b.x) > n.x && Math.min(a.x, b.x) < n.x + n.w && Math.max(a.y, b.y) > n.y && Math.min(a.y, b.y) < n.y + n.h;
          assert.ok(!inside, `${dir} ${sg.edge} crosses ${n.group.label}`);
        }
      }
    }
  }
  console.log('HMF with all alts:', p.groups.length, 'groups,', p.power.toFixed(0), 'MW');
}
console.log('all checks passed');
