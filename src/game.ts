import data from './data/game.json';
import tierData from './data/tiers.json';
import tierSources from './data/tier-sources.json';

export type Flow = { item: string; rate: number };
export type Item = { id: string; name: string; fluid: boolean; raw: boolean; sink: number; color: number[] | null; power?: boolean };
export type Building = { id: string; name: string; power: number; variable?: boolean; exp: number; generates?: number }; // generates: MW of a power plant
export type Extractor = { id: string; name: string; power: number; exp: number; rate: number; resources: string[] };
export type Conveyor = { id: string; name: string; mk: number; rate: number };
export type Recipe = {
  id: string; name: string; alt: boolean; building: string; duration: number;
  inputs: Flow[]; outputs: Flow[]; power?: number;
};

export const items = data.items as Record<string, Item>;
export const buildings = data.buildings as Record<string, Building>;
export const extractors = data.extractors as Record<string, Extractor>;
export const belts = data.belts as Conveyor[];
export const pipes = data.pipes as Conveyor[];
export const recipes = data.recipes as Recipe[];
export const costs = data.costs as Record<string, { item: string; amount: number }[]>;
export const recipeById = Object.fromEntries(recipes.map((r) => [r.id, r]));

export const SPLITTER = 'Build_ConveyorAttachmentSplitter_C';
export const MERGER = 'Build_ConveyorAttachmentMerger_C';
export const JUNCTION = 'Build_PipelineJunction_Cross_C';
export const WATER = 'Desc_Water_C';
export const POWER = 'MW'; // electricity as an item: made by power plants, used by machines (rates in MW, not /min)
export const WATER_PUMP = 'Build_WaterPump_C';

export const PURITY = { impure: 0.5, normal: 1, pure: 2 } as const;
export type Purity = keyof typeof PURITY;

// ponytail: world node totals (/min, 1.0 map, Mk.3 @250%) used as scarcity weights – update if the map changes
const WORLD: Record<string, number> = {
  Desc_OreIron_C: 92100, Desc_OreCopper_C: 36900, Desc_Stone_C: 69900, Desc_Coal_C: 42300, Desc_OreGold_C: 15000,
  Desc_RawQuartz_C: 13500, Desc_Sulfur_C: 10800, Desc_OreBauxite_C: 12300, Desc_OreUranium_C: 2100,
  Desc_LiquidOil_C: 12600, Desc_NitrogenGas_C: 12000, Desc_SAM_C: 10200,
};
const avgWorld = Object.values(WORLD).reduce((a, b) => a + b, 0) / Object.keys(WORLD).length;
/** cost of importing 1/min of an item: scarcity for raw, small for water, sink-value based for intermediates */
export const importWeight = (id: string) =>
  id === WATER || id === POWER ? 0.001 : WORLD[id] ? avgWorld / WORLD[id] : 1 + items[id].sink / 100;

export const icon = (name: string) => `${import.meta.env?.BASE_URL ?? "/"}icons/${name.replace(/[^\w.-]+/g, '_')}.png`;
export const itemIcon = (id: string) => icon(id === POWER ? 'Power Shard' : (items[id]?.name ?? id));
/** "12.5/min Iron Plate" or "600 MW" */
export const amount = (id: string, rate: number) => (id === POWER ? `${fmt(rate)} MW` : `${fmt(rate)}/min ${nameOf(id)}`);
export const unit = (id: string) => (id === POWER ? 'MW' : '/min');
const EXTRA: Record<string, string> = {
  [SPLITTER]: 'Conveyor Splitter', [MERGER]: 'Conveyor Merger', [JUNCTION]: 'Pipeline Junction',
};
export const nameOf = (id: string) => items[id]?.name ?? buildings[id]?.name ?? extractors[id]?.name ?? EXTRA[id] ?? id;

/** items that some recipe can produce, sorted by name */
export const producible = [...new Set(recipes.flatMap((r) => r.outputs.map((o) => o.item)))]
  .sort((a, b) => items[a].name.localeCompare(items[b].name));
export const rawItems = Object.values(items).filter((i) => i.raw).map((i) => i.id);

export const fmt = (n: number, d = 2) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(d)).replace(/\.?0+$/, '');

/** belt/pipe tier colours (pipes Mk.1/2 reuse the first two) – distinct from the load colours */
export const TIER_COLORS = ['#a3a8b3', '#2fb8c7', '#3b82f6', '#8b5cf6', '#e046c8', '#f2f2f2'];
export type ColorBy = 'load' | 'tier';

// ---- alternate recipe tier list (computed by scripts/tiers.ts from the whole production chain)
export type TierInfo = {
  tier: 'S' | 'A' | 'B' | 'C' | 'D' | 'F' | 'N';
  score: number;
  item: string; // the product it is rated for
  resources: number | null; // % change vs the standard recipe's chain (negative = needs less)
  power: number | null;
  buildings: number | null;
  raw: Record<string, number>; // raw resources per item with this recipe
  baseRaw: Record<string, number> | null; // … with the standard recipe
  math: TierInfo['tier']; // our own whole-chain rating
  community: Record<string, TierInfo['tier']>; // tier list id -> its tier
};
export const TIER_SOURCES = tierSources as { id: string; name: string; url: string }[];
export const tierOf = (recipeId: string) => (tierData as Record<string, TierInfo>)[recipeId] as TierInfo | undefined;
export const TIERS: Record<TierInfo['tier'], { color: string; meaning: string }> = {
  S: { color: '#ff6b6b', meaning: 'Much cheaper chain – get it' },
  A: { color: '#ff9f43', meaning: 'Clearly better than standard' },
  B: { color: '#feca57', meaning: 'Somewhat better' },
  C: { color: '#d4d96a', meaning: 'About the same – situational' },
  D: { color: '#7ed6a5', meaning: 'Somewhat worse, useful for specific resources' },
  F: { color: '#74b9ff', meaning: 'Costs more than standard' },
  N: { color: '#b8a9e8', meaning: 'Makes something no standard recipe can' },
};
