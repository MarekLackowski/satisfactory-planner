import type { Dir, Pt } from './layout';
import type { Settings } from './solver';

/** a saved factory: its production choices + layout; unlocks and options stay global */
export type Factory = {
  id: string;
  name: string;
  icon: string; // display name, resolved with icon()
  outputs: Settings['outputs'];
  inputs: Settings['inputs'];
  powerBudget?: number; // MW limit for this factory
  selfPowered?: boolean; // builds its own power plants
  dir: Dir;
  moved: Record<string, Pt>;
  updated: number;
};
export type Factories = { list: Factory[]; active: string };

const STORE = 'satisfactory-factories';
const uid = () => Math.random().toString(36).slice(2, 10);

export const newFactory = (name: string, base?: Partial<Factory>): Factory => ({
  id: uid(), name, icon: 'Constructor', outputs: [], inputs: [], dir: 'TB', moved: {}, updated: Date.now(), ...base,
});

export function loadFactories(seed: Pick<Factory, 'outputs' | 'inputs'>): Factories {
  try {
    const f = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Factories | null;
    if (f?.list) return f; // may be empty: the user deleted every factory
  } catch { /* corrupt or unavailable storage: start fresh */ }
  const first = newFactory('My factory', seed);
  return { list: [first], active: first.id };
}
export const saveFactories = (f: Factories) => {
  try { localStorage.setItem(STORE, JSON.stringify(f)); } catch { /* storage unavailable */ }
};
