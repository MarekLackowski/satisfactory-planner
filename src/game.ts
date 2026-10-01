import data from './data/game.json';

export type Flow = { item: string; rate: number };
export type Item = { id: string; name: string; fluid: boolean; raw: boolean; sink: number; color: number[] | null };
export type Building = { id: string; name: string; power: number; variable?: boolean; exp: number };
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
  id === WATER ? 0.001 : WORLD[id] ? avgWorld / WORLD[id] : 1 + items[id].sink / 100;

export const icon = (name: string) => `${import.meta.env.BASE_URL}icons/${name.replace(/[^\w.-]+/g, '_')}.png`;
export const itemIcon = (id: string) => icon(items[id]?.name ?? id);
const EXTRA: Record<string, string> = {
  [SPLITTER]: 'Conveyor Splitter', [MERGER]: 'Conveyor Merger', [JUNCTION]: 'Pipeline Junction',
};
export const nameOf = (id: string) => items[id]?.name ?? buildings[id]?.name ?? extractors[id]?.name ?? EXTRA[id] ?? id;

/** items that some recipe can produce, sorted by name */
export const producible = [...new Set(recipes.flatMap((r) => r.outputs.map((o) => o.item)))]
  .sort((a, b) => items[a].name.localeCompare(items[b].name));
export const rawItems = Object.values(items).filter((i) => i.raw).map((i) => i.id);

export const fmt = (n: number, d = 2) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(d)).replace(/\.?0+$/, '');
