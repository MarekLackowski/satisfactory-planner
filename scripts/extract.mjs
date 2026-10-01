// Converts the game's CommunityResources/Docs/en-US.json (UTF-16) into src/data/game.json.
// Usage: node scripts/extract.mjs [path-to-en-US.json]
import fs from 'node:fs';

const src = process.argv[2] ?? 'C:/Steam/steamapps/common/Satisfactory/CommunityResources/Docs/en-US.json';
const buf = fs.readFileSync(src);
const docs = JSON.parse(buf[0] === 0xff ? buf.toString('utf16le').slice(1) : buf.toString('utf8').replace(/^\uFEFF/, ''));

const byNative = {};
for (const c of docs) byNative[c.NativeClass.match(/FactoryGame\.(\w+)'/)[1]] = c.Classes;
const all = (...names) => names.flatMap((n) => byNative[n] ?? []);

const num = (s) => parseFloat(s);
const parseList = (s) =>
  [...(s ?? '').matchAll(/ItemClass=".*?\.(\w+)'",Amount=(\d+)/g)].map((m) => ({ item: m[1], amount: +m[2] }));
const producedIn = (s) => [...(s ?? '').matchAll(/\.(\w+)"/g)].map((m) => m[1]);

// ---- items
const items = {};
const itemClasses = all(
  'FGResourceDescriptor', 'FGItemDescriptor', 'FGItemDescriptorBiomass', 'FGItemDescriptorNuclearFuel',
  'FGItemDescriptorPowerBoosterFuel', 'FGConsumableDescriptor', 'FGEquipmentDescriptor', 'FGAmmoTypeProjectile',
  'FGAmmoTypeSpreadshot', 'FGAmmoTypeInstantHit', 'FGPowerShardDescriptor',
);
const resourceIds = new Set(byNative.FGResourceDescriptor.map((c) => c.ClassName));
for (const c of itemClasses) {
  const fluid = c.mForm === 'RF_LIQUID' || c.mForm === 'RF_GAS';
  items[c.ClassName] = {
    id: c.ClassName,
    name: c.mDisplayName,
    fluid,
    raw: resourceIds.has(c.ClassName),
    sink: +c.mResourceSinkPoints || 0,
    color: fluid ? c.mFluidColor.match(/B=(\d+),G=(\d+),R=(\d+)/).slice(1).reverse().map(Number) : null,
  };
}
// building descriptors show up as recipe outputs (build costs) – names only
const buildingDescName = {};
for (const c of byNative.FGBuildingDescriptor) buildingDescName[c.ClassName] = c.mDisplayName;

// ---- production buildings
const buildings = {};
for (const c of all('FGBuildableManufacturer', 'FGBuildableManufacturerVariablePower')) {
  buildings[c.ClassName] = {
    id: c.ClassName,
    name: c.mDisplayName,
    power: num(c.mPowerConsumption),
    variable: c.mPowerConsumption === '0.000000' || undefined,
    exp: num(c.mPowerConsumptionExponent),
  };
}

// ---- extractors (rates per minute at normal purity, 100% clock)
const extractors = {};
for (const c of all('FGBuildableResourceExtractor', 'FGBuildableWaterPump')) {
  const fluid = c.mAllowedResourceForms.includes('RF_LIQUID') || c.mAllowedResourceForms.includes('RF_GAS');
  const allowed = c.ClassName === 'Build_WaterPump_C' ? ['Desc_Water_C'] : producedIn(c.mAllowedResources.replace(/'/g, '"')).filter((r) => resourceIds.has(r));
  extractors[c.ClassName] = {
    id: c.ClassName,
    name: c.mDisplayName,
    power: num(c.mPowerConsumption),
    exp: num(c.mPowerConsumptionExponent),
    rate: (60 / num(c.mExtractCycleTime)) * (+c.mItemsPerCycle / (fluid ? 1000 : 1)),
    resources: allowed.length ? allowed : [...resourceIds].filter((r) => !items[r].fluid && r !== 'Desc_Water_C'),
  };
}

// ---- belts / pipes
const belts = byNative.FGBuildableConveyorBelt
  .map((c) => ({ id: c.ClassName, name: c.mDisplayName, mk: +c.mDisplayName.match(/Mk\.(\d)/)[1], rate: num(c.mSpeed) / 2 }))
  .sort((a, b) => a.mk - b.mk);
const pipes = byNative.FGBuildablePipeline
  .filter((c) => !c.ClassName.includes('NoIndicator'))
  .map((c) => ({ id: c.ClassName, name: c.mDisplayName, mk: +c.mDisplayName.match(/Mk\.(\d)/)[1], rate: num(c.mFlowLimit) * 60 }))
  .sort((a, b) => a.mk - b.mk);

// ---- recipes
const recipes = [];
const buildCost = {}; // Build_X_C -> ingredients
for (const r of byNative.FGRecipe) {
  const where = producedIn(r.mProducedIn);
  const ins = parseList(r.mIngredients);
  const outs = parseList(r.mProduct);
  if (where.includes('BP_BuildGun_C') || where.includes('FGBuildGun')) {
    for (const o of outs) if (o.item in buildingDescName) buildCost[o.item.replace(/^Desc_/, 'Build_')] = ins;
    continue;
  }
  const building = where.find((w) => buildings[w]);
  if (!building || /Xmas|Snow|CandyCane|Fireworks/.test(r.ClassName)) continue; // ponytail: FICSMAS event recipes skipped
  const dur = num(r.mManufactoringDuration);
  const perMin = (l) => l.map(({ item, amount }) => ({ item, rate: ((items[item]?.fluid ? amount / 1000 : amount) * 60) / dur }));
  if ([...ins, ...outs].some((x) => !items[x.item])) continue; // ponytail: skips recipes touching unknown descriptors
  recipes.push({
    id: r.ClassName,
    name: r.mDisplayName.replace(/^Alternate: /, ''),
    alt: r.ClassName.includes('Alternate'),
    building,
    duration: dur,
    inputs: perMin(ins),
    outputs: perMin(outs),
    // variable power machines: average draw = constant + factor/2
    power: buildings[building].variable
      ? num(r.mVariablePowerConsumptionConstant) + num(r.mVariablePowerConsumptionFactor) / 2
      : undefined,
  });
}

// keep only items used by recipes (plus raw)
const used = new Set([...resourceIds]);
for (const r of recipes) for (const x of [...r.inputs, ...r.outputs]) used.add(x.item);
for (const k of Object.keys(items)) if (!used.has(k)) delete items[k];

const costIds = ['Build_ConveyorAttachmentSplitter_C', 'Build_ConveyorAttachmentMerger_C', 'Build_PipelineJunction_Cross_C',
  ...Object.keys(buildings), ...Object.keys(extractors)];
const costs = {};
for (const id of costIds) if (buildCost[id]) costs[id] = buildCost[id];
// name lookup for cost ingredients (building materials are regular items)
for (const list of Object.values(costs)) for (const { item } of list) {
  if (!items[item]) {
    const c = itemClasses.find((x) => x.ClassName === item);
    if (c) items[item] = { id: item, name: c.mDisplayName, fluid: false, raw: false, sink: +c.mResourceSinkPoints || 0, color: null };
  }
}

fs.mkdirSync('src/data', { recursive: true });
fs.writeFileSync('src/data/game.json', JSON.stringify({ items, buildings, extractors, belts, pipes, recipes, costs }));
console.log(`items ${Object.keys(items).length}, recipes ${recipes.length} (alt ${recipes.filter((r) => r.alt).length}), buildings ${Object.keys(buildings).length}, extractors ${Object.keys(extractors).length}, costs ${Object.keys(costs).length}`);
console.log(belts.map((b) => `${b.name}=${b.rate}`).join(', '), '|', pipes.map((b) => `${b.name}=${b.rate}`).join(', '));
console.log(Object.values(extractors).map((e) => `${e.name}=${e.rate} [${e.resources.length}]`).join(', '));
