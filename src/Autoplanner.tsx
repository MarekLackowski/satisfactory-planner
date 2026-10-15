import { useState } from 'react';
import { autoplan, fromResources, type Made, type Option } from './autoplan';
import { fmt, itemIcon, nameOf, recipeById, unit, WATER } from './game';
import type { Settings } from './solver';
import { Icon, ItemSelect } from './ui';

type Flow = { item: string; rate: number };
type Props = {
  s: Settings;
  options: string[]; // products the unlocks can make
  inputItems: string[]; // anything that can be an input
  onPick: (targets: Flow[], o: Option) => void;
  onPickMade: (inputs: Flow[], m: Made) => void;
};

/** rows of item + rate, with add / remove */
function Flows({ list, options, onChange, add }: { list: Flow[]; options: string[]; onChange: (l: Flow[]) => void; add: string }) {
  return (
    <>
      {list.map((f, k) => (
        <div className="row" key={k}>
          <ItemSelect value={f.item} options={options} onChange={(item) => onChange(list.map((x, i) => (i === k ? { ...x, item } : x)))} />
          <input type="number" min={0} step="any" value={f.rate} aria-label="Rate" onChange={(e) => onChange(list.map((x, i) => (i === k ? { ...x, rate: Math.max(0, +e.target.value) } : x)))} />
          <span className="unit">{unit(f.item)}</span>
          {list.length > 1 && <button className="x" aria-label="Remove" onClick={() => onChange(list.filter((_, i) => i !== k))}>×</button>}
        </div>
      ))}
      <button onClick={() => onChange([...list, { item: options.find((o) => !list.some((f) => f.item === o)) ?? options[0], rate: list[list.length - 1].rate }])}>{add}</button>
    </>
  );
}

/**
 * two ways in: pick products and get a few ways to make them, or pick the resources you have (nodes nearby)
 * and see everything they can become
 */
export default function Autoplanner({ s, options, inputItems, onPick, onPickMade }: Props) {
  const [mode, setMode] = useState<'make' | 'use'>('make');
  const [targets, setTargets] = useState<Flow[]>([{ item: '', rate: 1 }]);
  const [inputs, setInputs] = useState<Flow[]>([{ item: 'Desc_OreIron_C', rate: 60 }]);
  const [found, setFound] = useState<{ key: string; list: Option[] } | null>(null);
  const [made, setMade] = useState<{ key: string; list: Made[] } | null>(null);
  const [busy, setBusy] = useState('');
  const want = targets.map((t) => ({ ...t, item: t.item || options[0] }));
  const unlocks = `${s.alts.join()}|${s.buildings.join()}`;
  const key = mode === 'make' ? `${JSON.stringify(want)}|${unlocks}` : `${JSON.stringify(inputs)}|${unlocks}`;
  const run = async () => {
    setBusy('Looking…');
    try {
      if (mode === 'make') setFound({ key, list: await autoplan(want, s) });
      else setMade({ key, list: await fromResources(inputs, s, (d, n) => setBusy(`Checking ${d + 1}/${n}…`)) });
    } finally {
      setBusy('');
    }
  };
  // results go stale once the products, resources or unlocks change
  const list = found?.key === key ? found.list : null;
  const can = made?.key === key ? made.list : null;

  return (
    <section>
      <h2>Autoplanner</h2>
      {!options.length ? (
        <p className="hint">Unlock buildings in the Unlocks tab first.</p>
      ) : (
        <>
          <div className="seg" role="radiogroup" aria-label="Autoplanner mode">
            <button role="radio" aria-checked={mode === 'make'} className={mode === 'make' ? 'on' : ''} onClick={() => setMode('make')}>I want to make…</button>
            <button role="radio" aria-checked={mode === 'use'} className={mode === 'use' ? 'on' : ''} onClick={() => setMode('use')}>I have these resources…</button>
          </div>
          {mode === 'make' ? (
            <Flows list={want} options={options} onChange={setTargets} add="+ Add product" />
          ) : (
            <>
              <Flows list={inputs} options={inputItems} onChange={setInputs} add="+ Add resource" />
              <p className="hint">Ores, fluids or items you can bring in, per minute. Water is always available.</p>
            </>
          )}
          <button className="primary" disabled={!!busy || [...(mode === 'make' ? want : inputs)].some((f) => !(f.rate > 0))} onClick={run}>
            {busy || (mode === 'make' ? 'Find ways to make it' : 'What can I make?')}
          </button>

          {mode === 'make' && list && !list.length && <p className="hint">Can't be made with what's unlocked.</p>}
          {mode === 'make' && list?.map((o, k) => (
            <div key={k} className="way">
              <div className="way-tags">{o.tags.map((t) => <span key={t}>{t}</span>)}{!o.tags.length && <span className="dim">Option {k + 1}</span>}</div>
              <div className="way-raw" title="Raw resources per minute">
                {o.raw.map(([id, v]) => (
                  <span key={id} className={id === WATER ? 'dim' : ''} title={nameOf(id)}><Icon src={itemIcon(id)} size={22} />{fmt(v, 1)}</span>
                ))}
              </div>
              <div className="way-stats">
                <b>{o.types}</b> resource{o.types === 1 ? '' : 's'} · <b>{fmt(o.power, 0)}</b> MW · <b>{o.machines}</b> machines
              </div>
              {o.alts.length > 0 && (
                <div className="way-alts" title="Alternate recipes used">
                  {o.alts.map((id) => <span key={id} title={recipeById[id].name}><Icon src={itemIcon(recipeById[id].outputs[0].item)} size={18} />{recipeById[id].name.replace(/^Alternate: /, '')}</span>)}
                </div>
              )}
              <button onClick={() => onPick(want, o)}>Create factory →</button>
            </div>
          ))}

          {mode === 'use' && can && !can.length && <p className="hint">Nothing can be made from only these with what's unlocked.</p>}
          {mode === 'use' && can && can.length > 0 && (
            <ul className="made">
              {can.map((m) => (
                <li key={m.item}>
                  <Icon src={itemIcon(m.item)} size={28} />
                  <span>
                    <b>{nameOf(m.item)}</b>
                    <small>up to {fmt(m.rate, 1)} {unit(m.item)}</small>
                  </span>
                  <span className="made-uses" title="Resources it uses">
                    {m.uses.map((id) => <Icon key={id} src={itemIcon(id)} size={18} />)}
                  </span>
                  <button onClick={() => onPickMade(inputs, m)} title="New factory making this from your resources">Create →</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
