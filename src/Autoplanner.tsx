import { useState } from 'react';
import { autoplan, type Option } from './autoplan';
import { fmt, itemIcon, nameOf, recipeById, unit, WATER } from './game';
import type { Settings } from './solver';
import { Icon, ItemSelect } from './ui';

type Props = { s: Settings; options: string[]; onPick: (item: string, rate: number, o: Option) => void };

/** pick a product, get a few ways to make it with the unlocked recipes, start a factory from one */
export default function Autoplanner({ s, options, onPick }: Props) {
  const [item, setItem] = useState('');
  const [rate, setRate] = useState(10);
  const [found, setFound] = useState<{ key: string; list: Option[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const target = item || options[0];
  const key = `${target}|${rate}|${s.alts.join()}|${s.buildings.join()}`;
  const search = async () => {
    setBusy(true);
    try {
      setFound({ key, list: await autoplan(target, rate, s) });
    } finally {
      setBusy(false);
    }
  };
  const list = found?.key === key ? found.list : null; // stale after the product or unlocks change

  return (
    <section>
      <h2>Autoplanner</h2>
      {!options.length ? (
        <p className="hint">Unlock buildings in the Unlocks tab first.</p>
      ) : (
        <>
          <div className="row">
            <ItemSelect value={target} options={options} onChange={setItem} />
            <input type="number" min={0} step="any" value={rate} aria-label="Rate" onChange={(e) => setRate(Math.max(0, +e.target.value))} />
            <span className="unit">{unit(target)}</span>
          </div>
          <button className="primary" disabled={busy || !(rate > 0)} onClick={search}>{busy ? 'Looking for ways…' : 'Find ways to make it'}</button>
          {list && !list.length && <p className="hint">Can't be made with what's unlocked.</p>}
          {list?.map((o, k) => (
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
              <button onClick={() => onPick(target, rate, o)}>Create factory →</button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
