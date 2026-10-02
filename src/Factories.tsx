import { useEffect, useRef, useState } from 'react';
import { buildings, extractors, icon, items, nameOf } from './game';
import type { Factories, Factory } from './storage';

// every item and building that has an icon, for the picker
const ICONS = [...new Set([
  ...Object.values(items).map((i) => i.name),
  ...Object.values(buildings).map((b) => b.name),
  ...Object.values(extractors).map((e) => e.name),
])].sort();

function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  return (
    <div className="icon-picker">
      <button className="icon-btn" title="Choose icon" aria-label="Choose icon" onClick={() => setOpen(!open)}>
        <img src={icon(value)} width={40} height={40} alt="" />
      </button>
      {open && (
        <div className="icon-pop">
          <input type="search" ref={(el) => el?.focus({ preventScroll: true })} placeholder="Search icons…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="icon-grid">
            {ICONS.filter((n) => n.toLowerCase().includes(q.toLowerCase())).map((n) => (
              <button key={n} title={n} aria-label={n} className={n === value ? 'on' : ''} onClick={() => { onChange(n); setOpen(false); }}>
                <img src={icon(n)} width={28} height={28} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type Props = {
  f: Factories;
  naming: string; // id of a factory just created: focus its name
  onStart: () => void;
  onRename: (patch: Partial<Pick<Factory, 'name' | 'icon'>>) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
};

export default function FactoriesPanel({ f, naming, onStart, onRename, onOpen, onNew, onDuplicate, onDelete }: Props) {
  const cur = f.list.find((x) => x.id === f.active);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (naming && naming === f.active) nameRef.current?.select();
  }, [naming, f.active]);
  return (
    <div className="panel">
      {!cur ? (
        <section>
          <h2>No factories</h2>
          <p className="hint">You deleted every factory. Unlocks and options are still saved.</p>
          <button className="primary" onClick={onNew}>+ New factory</button>
        </section>
      ) : <section>
        <h2>Current factory</h2>
        <div className="row current">
          <IconPicker value={cur.icon} onChange={(v) => onRename({ icon: v })} />
          <input className="name" ref={nameRef} value={cur.name} aria-label="Factory name" onChange={(e) => onRename({ name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && onStart()} />
        </div>
        <p className="hint">Changes are saved automatically. Unlocks and options are shared by all factories; outputs, inputs and the power limit belong to this one.</p>
        <div className="row">
          <button className="primary" onClick={onStart}>Plan production →</button>
          <button onClick={onNew}>+ New factory</button>
        </div>
      </section>}
      {f.list.length > 0 && <section>
        <h2>Saved factories <small>({f.list.length})</small></h2>
        <ul className="factories">
          {[...f.list].sort((a, b) => b.updated - a.updated).map((x) => (
            <li key={x.id} className={x.id === f.active ? 'active' : ''}>
              <img src={icon(x.icon)} width={32} height={32} alt="" />
              <span>
                <b>{x.name || 'Untitled'}</b>
                <small>
                  {x.outputs.length ? x.outputs.map((o) => nameOf(o.item)).join(', ') : 'No outputs yet'} · {new Date(x.updated).toLocaleDateString()}
                </small>
              </span>
              {x.id !== f.active && <button onClick={() => onOpen(x.id)}>Open</button>}
              <button onClick={() => onDuplicate(x.id)} title="Duplicate">⧉</button>
              <button className="x" aria-label={`Delete ${x.name}`} onClick={() => { if (confirm(`Delete "${x.name}"?`)) onDelete(x.id); }}>×</button>
            </li>
          ))}
        </ul>
      </section>}
    </div>
  );
}
