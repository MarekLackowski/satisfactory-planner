import { useEffect, useMemo, useState } from 'react';
import FactoriesPanel from './Factories';
import { loadFactories, newFactory, saveFactories, type Factories, type Factory } from './storage';
import FactoryCanvas from './FactoryCanvas';
import TierList, { TierBadge } from './TierList';
import WiringDiagram from './WiringDiagram';
import {
  POWER, unit, TIER_COLORS, type ColorBy, belts, buildings, extractors, fmt, icon, itemIcon, items, nameOf, pipes, producible, rawItems, recipes, WATER_PUMP, type Purity,
} from './game';
import { autoArrange, geometry, type Dir, type Pt } from './layout';
import { solvePlan, type Plan } from './plan';
import { enabledRecipes, minerCap, minerRate, type Input, type Settings } from './solver';

const STORE = 'satisfactory-calc-v2';
const ALL_BUILDINGS = [...Object.keys(buildings), ...Object.keys(extractors)];
const DEFAULTS: Settings = {
  outputs: [],
  inputs: [],
  unlimitedRaw: true,
  unlimitedWater: true,
  alts: [],
  buildings: [],
  beltMk: [],
  pipeMk: [],
  weights: { resources: 1, power: 0, buildings: 0 },
  cheapBelts: false,
  underclockLast: true,
  overclock: 1,
  shards: 0,
  sinkSurplus: true,
};
const PRESETS: Record<string, Settings['weights']> = {
  Resources: { resources: 1, power: 0, buildings: 0 },
  Power: { resources: 0, power: 1, buildings: 0 },
  Buildings: { resources: 0, power: 0, buildings: 1 },
  Balanced: { resources: 1, power: 0.05, buildings: 1 },
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

const Icon = ({ src, size = 22 }: { src: string; size?: number }) => (
  <img src={src} width={size} height={size} alt="" className="icon" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
);

/** scroll only the picker list (scrollIntoView would also scroll the side panel and make the UI jump) */
function keepVisible(el: HTMLElement | null) {
  const list = el?.parentElement;
  if (!el || !list) return;
  if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
  else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
}

/** searchable item picker: type to filter, arrows + Enter to pick, Esc to close */
function ItemSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const shown = options.filter((id) => nameOf(id).toLowerCase().includes(q.trim().toLowerCase()));
  const close = () => { setOpen(false); setQ(''); setHi(0); };
  const pick = (id: string) => { onChange(id); close(); };
  const locked = !options.includes(value);
  return (
    <span className="item-select picker">
      <button type="button" className="picker-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <Icon src={itemIcon(value)} />
        <span>{nameOf(value)}{locked && ' (locked)'}</span>
        <span className="caret" aria-hidden>▾</span>
      </button>
      {open && (
        <>
          <div className="picker-backdrop" onClick={close} />
          <div className="picker-pop">
            <input
              type="search" ref={(el) => el?.focus({ preventScroll: true })} placeholder={`Search ${options.length} items…`} value={q} aria-label="Search items"
              onChange={(e) => { setQ(e.target.value); setHi(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
                else if (e.key === 'Enter' && shown[hi]) pick(shown[hi]);
                else if (e.key === 'Escape') close();
              }}
            />
            <ul role="listbox">
              {shown.map((id, i) => (
                <li key={id} role="option" aria-selected={id === value} className={`${i === hi ? 'hi' : ''} ${id === value ? 'sel' : ''}`}
                  onMouseEnter={() => setHi(i)} onClick={() => pick(id)}
                  ref={i === hi ? (el) => keepVisible(el) : undefined}>
                  <Icon src={itemIcon(id)} size={24} />{nameOf(id)}
                </li>
              ))}
              {!shown.length && <li className="empty-row">No match</li>}
            </ul>
          </div>
        </>
      )}
    </span>
  );
}

const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

export default function App() {
  // the active factory is the source of truth for outputs/inputs; unlocks & options come from settings
  const [init] = useState(() => {
    const s0 = load();
    const f0 = loadFactories({ outputs: s0.outputs, inputs: s0.inputs });
    const a = f0.list.find((x) => x.id === f0.active);
    return { s: { ...s0, outputs: a?.outputs ?? [], inputs: a?.inputs ?? [], powerBudget: a?.powerBudget, selfPowered: a?.selfPowered, overclock: a?.overclock ?? 1, shards: a?.shards ?? 0 }, f: f0 };
  });
  const [s, setS] = useState<Settings>(init.s);
  const set = (patch: Partial<Settings>) => setS((p) => ({ ...p, ...patch }));
  const [tab, setTab] = useState<'factories' | 'production' | 'unlocks' | 'tiers'>('production');
  const [fac, setFac] = useState<Factories>(init.f);
  const [naming, setNaming] = useState('');
  const active = fac.list.find((x) => x.id === fac.active); // undefined once every factory is deleted
  const [result, setResult] = useState<{ plan: Plan } | { error: string } | { info: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [colorBy, setColorByState] = useState<ColorBy>(() => {
    try { return localStorage.getItem('satisfactory-colorby') === 'tier' ? 'tier' : 'load'; } catch { return 'load'; }
  });
  const setColorBy = (c: ColorBy) => {
    setColorByState(c);
    try { localStorage.setItem('satisfactory-colorby', c); } catch { /* storage unavailable */ }
  };
  const [altQuery, setAltQuery] = useState('');
  const hasFactory = !!active;
  const view = !active && tab === 'production' ? 'factories' : tab; // nothing to edit without a factory
  const [dir, setDir] = useState<Dir>(active?.dir ?? 'TB');
  const [moved, setMoved] = useState<Record<string, Pt>>(active?.moved ?? {});
  const changeDir = (d: Dir) => {
    setDir(d);
    setMoved({});
  };

  // ---- factories: the active one is the live editor state (autosaved); unlocks/options live in `s` and are shared
  const current = useMemo<Factories>(() => ({
    ...fac,
    list: fac.list.map((x) => (x.id === fac.active ? { ...x, outputs: s.outputs, inputs: s.inputs, powerBudget: s.powerBudget, selfPowered: s.selfPowered, overclock: s.overclock, shards: s.shards, dir, moved } : x)),
  }), [fac, s.outputs, s.inputs, s.powerBudget, s.selfPowered, s.overclock, s.shards, dir, moved]);
  useEffect(() => saveFactories(current), [current]);
  const patchActive = (patch: Partial<Factory>) =>
    setFac((f) => ({ ...f, list: f.list.map((x) => (x.id === f.active ? { ...x, ...patch, updated: Date.now() } : x)) }));
  const open = (x: Factory) => {
    setFac({ list: current.list, active: x.id });
    setS((p) => ({ ...p, outputs: x.outputs, inputs: x.inputs, powerBudget: x.powerBudget, selfPowered: x.selfPowered, overclock: x.overclock ?? 1, shards: x.shards ?? 0 }));
    setDir(x.dir);
    setMoved(x.moved);
  };
  const addFactory = (x: Factory) => {
    setFac({ list: [...current.list, x], active: x.id });
    setS((p) => ({ ...p, outputs: x.outputs, inputs: x.inputs, powerBudget: x.powerBudget, selfPowered: x.selfPowered, overclock: x.overclock ?? 1, shards: x.shards ?? 0 }));
    setDir(x.dir);
    setMoved(x.moved);
    setTab('factories');
    setNaming(x.id); // focus the name field so it can be named / given an icon first
  };
  const removeFactory = (id: string) => {
    const rest = current.list.filter((x) => x.id !== id);
    if (!rest.length) {
      setFac({ list: [], active: '' });
      setS((p) => ({ ...p, outputs: [], inputs: [] }));
      setMoved({});
      return setTab('factories');
    }
    if (id === fac.active) open(rest[0]);
    setFac((f) => ({ list: rest, active: id === f.active ? rest[0].id : f.active }));
  };

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage unavailable */ }
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!hasFactory) return setResult(null);
      if (!s.outputs.length) return setResult({ info: 'Add an output in the Production tab to start planning this factory.' });
      if (!s.buildings.length || !s.beltMk.length) {
        setResult({ error: 'Nothing is unlocked yet – pick your buildings, belt tiers and alternate recipes in the Unlocks tab.' });
        return;
      }
      setBusy(true);
      try {
        const plan = await solvePlan(s);
        if (!cancelled) setResult({ plan });
      } catch (e) {
        if (!cancelled) setResult({ error: (e as Error).message });
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [s, hasFactory]);

  const plan = result && 'plan' in result ? result.plan : null;
  const arranged = useMemo(() => (plan ? autoArrange(plan, s, dir) : null), [plan, dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const lay = useMemo(() => (plan && arranged ? geometry(plan, s, arranged, moved) : null), [arranged, moved]); // eslint-disable-line react-hooks/exhaustive-deps

  const updInput = (k: number, patch: Partial<Input>) =>
    set({ inputs: s.inputs.map((x, i) => (i === k ? ({ ...x, ...patch } as Input) : x)) });
  const maxCount = s.outputs.filter((o) => o.maximize).length;
  const inputItems = useMemo(() => [...rawItems, ...Object.keys(items).filter((i) => !items[i].raw && i !== POWER).sort((a, b) => nameOf(a).localeCompare(nameOf(b)))], []);
  const generatorsOn = s.buildings.some((b) => buildings[b]?.generates);
  const enabledExtractors = Object.values(extractors).filter((e) => s.buildings.includes(e.id));
  // only items the unlocked recipes/buildings can make
  const makeable = useMemo(() => {
    const out = new Set(enabledRecipes(s).flatMap((r) => r.outputs.map((o) => o.item)));
    return producible.filter((i) => out.has(i));
  }, [s.buildings, s.alts]); // eslint-disable-line react-hooks/exhaustive-deps
  const alts = recipes.filter((r) => r.alt && (r.name + nameOf(r.outputs[0].item)).toLowerCase().includes(altQuery.toLowerCase()));

  return (
    <div className="app">
      <aside>
        <header>
          <h1>Satisfactory Factory Planner</h1>
          {active && (
            <button className="current-factory" onClick={() => setTab('factories')} title="Manage factories">
              <Icon src={icon(active.icon)} size={20} /> {active.name || 'Untitled'}
            </button>
          )}
          <nav>
            <button className={view === 'factories' ? 'on' : ''} onClick={() => setTab('factories')}>Factories</button>
            <button className={view === 'production' ? 'on' : ''} disabled={!active} onClick={() => setTab('production')}>Production</button>
            <button className={view === 'tiers' ? 'on' : ''} onClick={() => setTab('tiers')}>Tier list</button>
            <button className={view === 'unlocks' ? 'on' : ''} onClick={() => setTab('unlocks')}>Unlocks</button>
          </nav>
        </header>

        {view === 'tiers' ? (
          <div className="panel">
            <section>
              <h2>How recipes are rated</h2>
              <p className="hint tier-help">
                For every alternate recipe the solver builds the cheapest whole production chain for 1 item of its product twice: once with standard recipes only, once making it with this alternate (everything upstream stays standard).
              </p>
              <ul className="hint tier-help">
                <li><b>Resources (60%)</b>: raw ore, oil, gas… per item, rarer resources weigh more; hand-gathered items and power slugs are expensive because they can't be automated.</li>
                <li><b>Power (25%)</b>: machines plus mining/extraction.</li>
                <li><b>Buildings (15%)</b>: machines in the chain.</li>
              </ul>
              <p className="hint tier-help">Each is compared as a ratio to the standard chain; S means a much cheaper chain, F costs more. <b>New</b> recipes make something no standard recipe can. Byproducts get no credit.</p>
              <p className="hint tier-help">Tick a recipe to mark it unlocked – the same list as in Unlocks, used by the planner.</p>
            </section>
          </div>
        ) : view === 'factories' ? (
          <FactoriesPanel f={current} naming={naming} onStart={() => setTab('production')} onRename={patchActive} onOpen={(id) => open(current.list.find((x) => x.id === id)!)}
            onNew={() => addFactory(newFactory(`Factory ${fac.list.length + 1}`, { dir }))}
            onDuplicate={(id) => {
              const src = current.list.find((x) => x.id === id)!;
              addFactory({ ...structuredClone(src), id: newFactory('').id, name: `${src.name} (copy)`, updated: Date.now() });
            }}
            onDelete={removeFactory} />
        ) : view === 'production' ? (
          <div className="panel">
            <section>
              <h2>Outputs</h2>
              {s.outputs.map((o, k) => (
                <div className="row" key={k}>
                  <ItemSelect value={o.item} options={makeable}
                    onChange={(item) => set({ outputs: s.outputs.map((x, i) => (i === k ? { ...x, item } : x)) })} />
                  <input type="number" min={0} step="any" value={o.maximize && maxCount === 1 ? '' : o.rate} placeholder={o.maximize ? 'max' : ''}
                    disabled={o.maximize && maxCount === 1}
                    title={o.maximize ? (maxCount > 1 ? 'Ratio between the maximized outputs' : 'Maximized: as much as possible') : 'Items per minute'}
                    onChange={(e) => set({ outputs: s.outputs.map((x, i) => (i === k ? { ...x, rate: +e.target.value } : x)) })} />
                  <span className={`unit${o.maximize && maxCount === 1 ? ' dim' : ''}`}>{o.maximize ? (maxCount > 1 ? 'ratio' : 'max') : unit(o.item)}</span>
                  <label className="chk" title="Maximize this output with the available inputs">
                    <input type="checkbox" checked={o.maximize}
                      onChange={(e) => set({ outputs: s.outputs.map((x, i) => (i === k ? { ...x, maximize: e.target.checked } : x)) })} />Max
                  </label>
                  <button className="x" aria-label="Remove output" onClick={() => set({ outputs: s.outputs.filter((_, i) => i !== k) })}>×</button>
                </div>
              ))}
              <button disabled={!makeable.length} title={makeable.length ? '' : 'Unlock buildings first'}
                onClick={() => set({ outputs: [...s.outputs, { item: makeable[0], rate: 10, maximize: false }] })}>+ Add output</button>
            </section>

            <section>
              <h2>Power</h2>
              <div className="seg" role="radiogroup" aria-label="Power source">
                <button role="radio" aria-checked={!s.selfPowered} className={s.selfPowered ? '' : 'on'} onClick={() => set({ selfPowered: false })}>From the grid</button>
                <button role="radio" aria-checked={!!s.selfPowered} className={s.selfPowered ? 'on' : ''} onClick={() => set({ selfPowered: true })}>Own power plants</button>
              </div>
              {s.selfPowered ? (
                <p className="hint">
                  Power plants and their fuel are planned inside this factory, covering machines, miners and pumps.
                  {!generatorsOn && <> <b>Unlock a generator</b> in the Unlocks tab first.</>}
                </p>
              ) : (
                <>
                  <div className="row">
                    <input type="number" min={0} step="any" placeholder="No limit" aria-label="Power limit in MW" value={s.powerBudget || ''}
                      onChange={(e) => set({ powerBudget: Math.max(0, +e.target.value) || undefined })} />
                    <span className="unit">MW limit</span>
                    {s.powerBudget ? <button className="x" aria-label="Remove power limit" onClick={() => set({ powerBudget: undefined })}>×</button> : null}
                  </div>
                  <p className="hint">Includes miners. With Max, makes as much as fits.</p>
                </>
              )}
              <p className="hint">To plan a power plant on its own, add <b>Power</b> as an output (in MW).</p>
            </section>

            <section>
              <h2>Overclocking</h2>
              <div className="row">
                <label className="mini">Power shards for machines
                  <input type="number" min={0} step={1} value={s.shards} onChange={(e) => set({ shards: Math.max(0, Math.round(+e.target.value)), overclock: +e.target.value > 0 && s.overclock <= 1 ? 2.5 : s.overclock })} />
                </label>
                <label className="mini">up to
                  <select value={s.overclock} disabled={!s.shards} onChange={(e) => set({ overclock: +e.target.value })}>
                    {[1, 1.5, 2, 2.5].map((c) => <option key={c} value={c}>{c * 100}%</option>)}
                  </select>
                </label>
              </div>
              <p className="hint">Overclocked machines replace extra buildings: each shard adds 50% to one machine (3 shards = 250%), used on the biggest groups first. Miner clocks are set on each miner below.</p>
            </section>

            <section>
              <h2>Inputs</h2>
              {s.inputs.map((inp, k) => (
                <div className="row wrap" key={k}>
                  {inp.kind === 'rate' ? (
                    <>
                      <ItemSelect value={inp.item} options={inputItems} onChange={(item) => updInput(k, { item })} />
                      <input type="number" min={0} step="any" value={inp.rate} onChange={(e) => updInput(k, { rate: +e.target.value })} />
                      <span className="unit">/min</span>
                    </>
                  ) : (
                    <div className="miner">
                      <div className="row">
                        <span className="item-select">
                          <Icon src={icon(nameOf(inp.extractor))} />
                          <select value={inp.extractor} onChange={(e) => {
                            const ex = extractors[e.target.value];
                            updInput(k, { extractor: ex.id, item: ex.resources.includes(inp.item) ? inp.item : ex.resources[0], purity: ex.id === WATER_PUMP ? 'normal' : inp.purity });
                          }}>
                            {!s.buildings.includes(inp.extractor) && <option value={inp.extractor}>{nameOf(inp.extractor)} (locked)</option>}
                            {enabledExtractors.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                        </span>
                        <ItemSelect value={inp.item} options={extractors[inp.extractor].resources} onChange={(item) => updInput(k, { item })} />
                      </div>
                      <div className="row">
                        {inp.extractor !== WATER_PUMP && (
                          <select value={inp.purity} onChange={(e) => updInput(k, { purity: e.target.value as Purity })}>
                            <option value="impure">Impure</option><option value="normal">Normal</option><option value="pure">Pure</option>
                          </select>
                        )}
                        <label className="mini">Count <input type="number" min={1} step={1} value={inp.count} onChange={(e) => updInput(k, { count: Math.max(1, Math.round(+e.target.value)) })} /></label>
                        {inp.item !== POWER && <label className="mini">Clock <input type="number" min={1} max={250} step={1} value={Math.round(inp.clock * 100)} onChange={(e) => updInput(k, { clock: Math.min(2.5, Math.max(0.01, +e.target.value / 100)) })} />%</label>}
                        <span className="unit">= {fmt(minerRate(inp))} {inp.item === POWER ? 'MW (average)' : '/min'}</span>
                        {(() => {
                          const { one, cap } = minerCap(inp, s);
                          return one > cap + 1e-6 ? <span className="warn-inline">Best unlocked {items[inp.item].fluid ? 'pipe' : 'belt'} carries {fmt(cap)}/min, so each one ships {fmt(cap)}/min.</span> : null;
                        })()}
                      </div>
                    </div>
                  )}
                  <button className="x" aria-label="Remove input" onClick={() => set({ inputs: s.inputs.filter((_, i) => i !== k) })}>×</button>
                </div>
              ))}
              <div className="row">
                <button onClick={() => set({ inputs: [...s.inputs, { kind: 'rate', item: 'Desc_OreIron_C', rate: 60 }] })}>+ Resource rate</button>
                <button disabled={!enabledExtractors.length} onClick={() => {
                  const ex = enabledExtractors.find((e) => e.id.includes('Miner')) ?? enabledExtractors[0];
                  set({ inputs: [...s.inputs, { kind: 'miner', extractor: ex.id, item: ex.resources[0], purity: 'normal', count: 1, clock: 1 }] });
                }}>+ Miner / extractor</button>
              </div>
              <label className="chk"><input type="checkbox" checked={s.unlimitedRaw} onChange={(e) => set({ unlimitedRaw: e.target.checked })} />Unlimited raw resources (on top of inputs above)</label>
              <label className="chk"><input type="checkbox" checked={s.unlimitedWater} onChange={(e) => set({ unlimitedWater: e.target.checked })} />Unlimited water (placed as Water Extractors)</label>
            </section>

            <section>
              <h2>Optimize for</h2>
              <div className="row">
                {Object.entries(PRESETS).map(([name, w]) => (
                  <button key={name} className={JSON.stringify(w) === JSON.stringify(s.weights) ? 'on' : ''} onClick={() => set({ weights: w })}>{name}</button>
                ))}
              </div>
              <div className="row weights">
                {(['resources', 'power', 'buildings'] as const).map((k) => (
                  <label key={k} className="mini">{k}
                    <input type="number" min={0} step="any" value={s.weights[k]} onChange={(e) => set({ weights: { ...s.weights, [k]: Math.max(0, +e.target.value) } })} />
                  </label>
                ))}
              </div>
              <p className="hint">Resources are weighted by world scarcity; power in MW; buildings by machine count.</p>
            </section>

            <section>
              <h2>Options</h2>
              <label className="chk"><input type="checkbox" checked={s.cheapBelts} onChange={(e) => set({ cheapBelts: e.target.checked })} />Use cheapest sufficient belt/pipe tier per segment</label>
              <label className="chk"><input type="checkbox" checked={s.underclockLast} onChange={(e) => set({ underclockLast: e.target.checked })} />Underclock only the last machine (otherwise all evenly)</label>
              <label className="chk"><input type="checkbox" checked={s.sinkSurplus} onChange={(e) => set({ sinkSurplus: e.target.checked })} />Send solid surplus to AWESOME Sink</label>
            </section>
          </div>
        ) : (
          <div className="panel">
            <div className="row unlock-all">
              <button onClick={() => set({ buildings: ALL_BUILDINGS, beltMk: belts.map((b) => b.mk), pipeMk: pipes.map((b) => b.mk), alts: recipes.filter((r) => r.alt).map((r) => r.id) })}>Unlock everything</button>
              <button onClick={() => set({ buildings: [], beltMk: [], pipeMk: [], alts: [] })}>Deselect everything</button>
            </div>
            <section>
              <h2>Buildings <span className="h2-actions"><button onClick={() => set({ buildings: ALL_BUILDINGS })}>All</button><button onClick={() => set({ buildings: [] })}>None</button></span></h2>
              <div className="grid">
                {[...Object.values(buildings), ...Object.values(extractors)].map((b) => (
                  <label key={b.id} className="tile">
                    <input type="checkbox" checked={s.buildings.includes(b.id)} onChange={(e) => set({ buildings: toggle(s.buildings, b.id, e.target.checked) })} />
                    <Icon src={icon(b.name)} size={28} />{b.name}
                  </label>
                ))}
              </div>
            </section>
            <section>
              <h2>Conveyor belts <span className="h2-actions"><button onClick={() => set({ beltMk: belts.map((b) => b.mk) })}>All</button><button onClick={() => set({ beltMk: [] })}>None</button></span></h2>
              <div className="grid">
                {belts.map((b) => (
                  <label key={b.id} className="tile">
                    <input type="checkbox" checked={s.beltMk.includes(b.mk)} onChange={(e) => set({ beltMk: toggle(s.beltMk, b.mk, e.target.checked).sort() })} />
                    <Icon src={icon(b.name)} size={28} />Mk.{b.mk} <small>{b.rate}/min</small>
                  </label>
                ))}
              </div>
              <h2>Pipelines <span className="h2-actions"><button onClick={() => set({ pipeMk: pipes.map((b) => b.mk) })}>All</button><button onClick={() => set({ pipeMk: [] })}>None</button></span></h2>
              <div className="grid">
                {pipes.map((b) => (
                  <label key={b.id} className="tile">
                    <input type="checkbox" checked={s.pipeMk.includes(b.mk)} onChange={(e) => set({ pipeMk: toggle(s.pipeMk, b.mk, e.target.checked).sort() })} />
                    <Icon src={icon(b.name)} size={28} />Mk.{b.mk} <small>{b.rate} m³/min</small>
                  </label>
                ))}
              </div>
            </section>
            <section>
              <h2>Alternate recipes <small>({s.alts.length}/{recipes.filter((r) => r.alt).length})</small></h2>
              <div className="row">
                <input type="search" placeholder="Search…" value={altQuery} onChange={(e) => setAltQuery(e.target.value)} />
                <button onClick={() => set({ alts: [...new Set([...s.alts, ...alts.map((r) => r.id)])] })}>All</button>
                <button onClick={() => set({ alts: s.alts.filter((id) => !alts.some((r) => r.id === id)) })}>None</button>
              </div>
              <div className="alts">
                {alts.map((r) => (
                  <label key={r.id} className="alt">
                    <input type="checkbox" checked={s.alts.includes(r.id)} onChange={(e) => set({ alts: toggle(s.alts, r.id, e.target.checked) })} />
                    <TierBadge id={r.id} size={20} />
                    <Icon src={itemIcon(r.outputs[0].item)} />
                    <span>
                      <b>{r.name}</b>
                      <small>
                        {r.inputs.map((f) => `${fmt(f.rate)} ${nameOf(f.item)}`).join(' + ')} → {r.outputs.map((f) => `${fmt(f.rate)} ${nameOf(f.item)}`).join(' + ')} · {nameOf(r.building)}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          </div>
        )}
        <footer>
          <div className="row">
            <button onClick={() => { if (confirm('Reset unlocks and options? Factories are kept.')) setS((p) => ({ ...DEFAULTS, outputs: p.outputs, inputs: p.inputs, powerBudget: p.powerBudget, selfPowered: p.selfPowered, overclock: p.overclock, shards: p.shards })); }}>Reset unlocks & options</button>
            <a className="kofi" href="https://ko-fi.com/mareklackowski" target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a>
          </div>
          <p className="legal">
            Not affiliated with Coffee Stain Studios. Game assets © Coffee Stain Studios.
            Icons courtesy of <a href="https://satisfactory.wiki.gg" target="_blank" rel="noopener noreferrer">satisfactory.wiki.gg</a>
            {' · '}<a href="https://github.com/MarekLackowski/satisfactory-planner" target="_blank" rel="noopener noreferrer">Source</a>
          </p>
        </footer>
      </aside>

      <main>
        {view === 'tiers' ? (
          <TierList alts={s.alts} onToggle={(id, on) => set({ alts: toggle(s.alts, id, on) })} />
        ) : !active ? (
          <div className="empty">
            <img src={icon('Constructor')} width={96} height={96} alt="" />
            <h2>No factories yet</h2>
            <p>Create a factory to plan a production chain. Your unlocks and options are kept.</p>
            <button className="primary" onClick={() => addFactory(newFactory('My factory', { dir }))}>+ Create your first factory</button>
          </div>
        ) : (<>
        <div className="toolbar">
          <button onClick={() => setPlaying(!playing)}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <label className="mini">Speed
            <input type="range" min={0.25} max={4} step={0.25} value={speed} onChange={(e) => setSpeed(+e.target.value)} />
            {speed}×
          </label>
          <span className="seg" role="group" aria-label="Belt colour">
            <button className={colorBy === 'load' ? 'on' : ''} onClick={() => setColorBy('load')} title="Colour belts by how full they are">Load</button>
            <button className={colorBy === 'tier' ? 'on' : ''} onClick={() => setColorBy('tier')} title="Colour belts by Mk tier">Tier</button>
          </span>
          {colorBy === 'load' ? (
            <span className="legend">
              <i style={{ background: '#3fa66a' }} />&lt;70% <i style={{ background: '#c9b33a' }} />70–95% <i style={{ background: '#f5a524' }} />95–100% <i style={{ background: '#e5484d' }} />over
            </span>
          ) : (
            <span className="legend">
              {TIER_COLORS.map((c, i) => <span key={c}><i style={{ background: c }} />Mk.{i + 1} </span>)}
            </span>
          )}
          <span className="seg">
            <button className={dir === 'TB' ? 'on' : ''} onClick={() => changeDir('TB')}>↓ Vertical</button>
            <button className={dir === 'LR' ? 'on' : ''} onClick={() => changeDir('LR')}>→ Horizontal</button>
          </span>
          <button disabled={!Object.keys(moved).length} onClick={() => setMoved({})} title="Discard manual moves">Auto-arrange</button>
          {busy && <span className="busy">Solving…</span>}
        </div>
        {result && 'error' in result && <div className="error">{result.error}</div>}
        {lay && (
          <FactoryCanvas layout={lay} fitKey={arranged} playing={playing} speed={speed} colorBy={colorBy}
            onMoveNode={(id, p) => setMoved((m) => ({ ...m, [id]: p }))} />
        )}
        {result && 'info' in result && <div className="info">{result.info}</div>}
        {plan && <Summary plan={plan} budget={s.selfPowered ? undefined : s.powerBudget} selfPowered={s.selfPowered} />}
        </>)}
      </main>
    </div>
  );
}

const List = ({ rows }: { rows: [string, string, string][] }) => (
  <ul className="list">
    {rows.map(([src, label, v], i) => <li key={i}><Icon src={src} size={20} /><span>{label}</span><b>{v}</b></li>)}
  </ul>
);

function Summary({ plan, budget, selfPowered }: { plan: Plan; budget?: number; selfPowered?: boolean }) {
  const machines = plan.groups.filter((g) => g.kind === 'recipe');
  const sources = plan.groups.filter((g) => g.kind === 'extract' || g.kind === 'input');
  const outs = plan.groups.filter((g) => g.kind === 'output' || g.kind === 'sink');
  const guide = plan.wirings.filter((w) => w.splitters || w.mergers);
  const shards = plan.groups.reduce((a, g) => a + g.machines.reduce((x, m) => x + m.shards, 0), 0);
  return (
    <div className="summary">
      {plan.warnings.map((w) => <div key={w} className="warn">{w}</div>)}
      <div className="stats">
        <div><b>{fmt(plan.power)}</b>{budget ? <> / {fmt(budget)}</> : null} MW power{budget ? <meter min={0} max={budget} value={plan.power} high={budget * 0.95} optimum={budget * 0.5} /> : null}</div>
        {plan.generated > 0 && <div><b>+{fmt(plan.generated)}</b> MW generated</div>}
        <div><b>{machines.reduce((a, g) => a + g.machines.length, 0)}</b> production machines</div>
        <div><b>{plan.edges.length}</b> inter-group belts</div>
        {shards > 0 && <div><b>{shards}</b> power shards</div>}
      </div>
      <div className="cols">
        <div>
          <h3>Inputs used</h3>
          <List rows={sources.flatMap((g) => g.outputs.map((f) => [itemIcon(f.item), g.machines.length ? `${g.label} · ${g.machines.length}× at ${[...new Set(g.machines.map((m) => `${+(m.clock * 100).toFixed(1)}%`))].join(' / ')}` : g.label, `${fmt(f.rate)}/min`] as [string, string, string]))} />
          {plan.generated > 0 && (
            <>
              <h3>Power</h3>
              <List rows={[
                ...plan.groups.filter((g) => g.generates).map((g) => [icon(nameOf(g.building!)), g.label, `+${fmt(g.generates!)} MW`] as [string, string, string]),
                [itemIcon(POWER), 'Used by machines', `−${fmt(plan.power)} MW`],
                [itemIcon(POWER), selfPowered ? (plan.generated >= plan.power ? 'Spare' : 'Missing') : plan.generated >= plan.power ? 'Net to grid' : 'Net from grid', `${fmt(plan.generated - plan.power)} MW`],
              ]} />
            </>
          )}
          <h3>Outputs</h3>
          <List rows={outs.flatMap((g) => g.inputs.map((f) => [itemIcon(f.item), `${g.kind === 'sink' ? 'Sink: ' : g.id === 'surplus' ? 'Surplus: ' : ''}${nameOf(f.item)}`, f.item === POWER ? `${fmt(f.rate)} MW` : `${fmt(f.rate)}/min`] as [string, string, string]))} />
        </div>
        <div>
          <h3>Production</h3>
          <List rows={machines.map((g) => [icon(nameOf(g.building!)), `${g.label} (${nameOf(g.building!)})`, `${g.machines.length}× · ${fmt(g.power)} MW`] as [string, string, string])} />
        </div>
        <div>
          <h3>Buildings to place</h3>
          <List rows={[...plan.buildingCount].map(([id, n]) => [icon(nameOf(id)), nameOf(id), `${n}×`] as [string, string, string])} />
          <h3>Construction cost</h3>
          <List rows={[...plan.cost].sort((a, b) => b[1] - a[1]).map(([id, n]) => [itemIcon(id), nameOf(id), `${n}`] as [string, string, string])} />
        </div>
      </div>
      {guide.length > 0 && (
        <>
          <h3>Build guide: belt splits &amp; merges</h3>
          <p className="hint">Where belts leave or enter a group. Hover or tap a splitter/merger block on the graph to see the same recipe there.</p>
          <div className="guide">
            {guide.map((w) => (
              <div key={w.key} className="recipe">
                <div className="recipe-head">
                  <Icon src={itemIcon(w.key.slice(w.key.lastIndexOf(':') + 1))} size={20} />
                  <b>{w.title}</b>
                  <span className="unit">{w.splitters ? `${w.splitters} splitter${w.splitters > 1 ? 's' : ''}` : ''}{w.splitters && w.mergers ? ' · ' : ''}{w.mergers ? `${w.mergers} merger${w.mergers > 1 ? 's' : ''}` : ''}</span>
                </div>
                <WiringDiagram w={w} />
                <details>
                  <summary>Text version</summary>
                  <ul>{w.steps.map((s) => <li key={s}>{s}</li>)}</ul>
                </details>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
