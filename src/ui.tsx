import { useState } from 'react';
import { itemIcon, nameOf } from './game';

export const Icon = ({ src, size = 22 }: { src: string; size?: number }) => (
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
export function ItemSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
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

