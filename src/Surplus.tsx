import { useEffect, useState } from 'react';
import { fromResources, type Made } from './autoplan';
import { amount, fmt, itemIcon, nameOf, POWER, unit } from './game';
import type { Settings } from './solver';
import { Icon } from './ui';

type Flow = { item: string; rate: number };
type Props = { s: Settings; left: Flow[]; onUse: (m: Made, rate: number) => void; onClose: () => void };

/** what a factory's leftovers can still become: pick one and it's added as an output, made from the leftover */
export default function SurplusPanel({ s, left, onUse, onClose }: Props) {
  const [pick, setPick] = useState(left[0]);
  const [list, setList] = useState<{ key: string; made: Made[] } | null>(null);
  const key = `${pick.item}|${pick.rate}`;
  useEffect(() => {
    let off = false;
    fromResources([pick], s, undefined, !s.selfPowered).then((made) => !off && setList({ key, made }));
    return () => { off = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const made = list?.key === key ? list.made : null;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Use the surplus" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>Put the surplus to use</b>
          <button className="x" aria-label="Close" onClick={onClose}>×</button>
        </header>
        {left.length > 1 && (
          <div className="seg">
            {left.map((f) => (
              <button key={f.item} className={f.item === pick.item ? 'on' : ''} onClick={() => setPick(f)}>
                <Icon src={itemIcon(f.item)} size={18} /> {nameOf(f.item)}
              </button>
            ))}
          </div>
        )}
        <p className="hint">{amount(pick.item, pick.rate)} left over. Everything it can still become with your unlocks (water is free) – pick one to add it to this factory.</p>
        {!made ? <p className="hint">Looking…</p> : !made.length ? <p className="hint">Nothing can be made from it alone with what's unlocked.</p> : (
          <ul className="made">
            {made.map((m) => {
              const rate = Math.floor(m.rate * 100) / 100; // a hair under the maximum, so it surely fits
              return (
                <li key={m.item}>
                  <Icon src={itemIcon(m.item)} size={28} />
                  <span>
                    <b>{nameOf(m.item)}</b>
                    <small>{fmt(rate, 2)} {unit(m.item)}{m.item === POWER && s.selfPowered ? ' to spare' : ''}</small>
                  </span>
                  <button onClick={() => onUse(m, rate)}>Use for this</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
