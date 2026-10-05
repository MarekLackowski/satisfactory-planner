import { useMemo, useState } from 'react';
import { buildings, fmt, icon, itemIcon, nameOf, recipeById, TIERS, tierOf, type TierInfo } from './game';

const TIER_ORDER = ['S', 'A', 'B', 'C', 'D', 'F', 'N'] as const;
const TIER_LABEL: Record<string, string> = { N: 'New' };

export function TierBadge({ id, size = 22 }: { id: string; size?: number }) {
  const t = tierOf(id);
  if (!t) return null;
  return (
    <span className="tier-badge" style={{ background: TIERS[t.tier].color, width: size, height: size, fontSize: size * 0.58 }}
      title={`Tier ${TIER_LABEL[t.tier] ?? t.tier}${t.resources !== null ? `: resources ${pct(t.resources)}, power ${pct(t.power!)}, buildings ${pct(t.buildings!)}` : ''}`}>
      {t.tier === 'N' ? '★' : t.tier}
    </span>
  );
}

const pct = (v: number) => `${v > 0 ? '+' : ''}${v}%`;
/** less is better for all three: green when the alternate needs less than the standard recipe */
const Delta = ({ label, v }: { label: string; v: number | null }) =>
  v === null ? null : <span className={`delta ${v < -2 ? 'good' : v > 2 ? 'bad' : ''}`}>{label} {pct(v)}</span>;

type Props = { alts: string[]; onToggle: (id: string, on: boolean) => void };

export default function TierList({ alts, onToggle }: Props) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'unlocked' | 'locked'>('all');
  const owned = new Set(alts);
  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return TIER_ORDER.map((tier) => ({
      tier,
      list: Object.entries(TIERS_BY_RECIPE)
        .filter(([, t]) => t.tier === tier)
        .map(([id, t]) => ({ id, t, r: recipeById[id] }))
        .filter(({ r, t }) => !query || `${r.name} ${nameOf(t.item)} ${nameOf(r.building)}`.toLowerCase().includes(query))
        .filter(({ id }) => (show === 'all' ? true : show === 'unlocked' ? owned.has(id) : !owned.has(id)))
        .sort((a, b) => b.t.score - a.t.score),
    }));
  }, [q, show, alts]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = rows.reduce((a, r) => a + r.list.length, 0);

  return (
    <div className="tierlist">
      <div className="tier-tools">
        <input type="search" placeholder="Search alternate recipes, products, buildings…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search alternate recipes" />
        <span className="seg">
          {(['all', 'unlocked', 'locked'] as const).map((k) => (
            <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{k[0].toUpperCase() + k.slice(1)}</button>
          ))}
        </span>
        <span className="unit">{total} recipes · {alts.length} unlocked</span>
      </div>
      {rows.map(({ tier, list }) =>
        list.length ? (
          <section key={tier} className="tier-row">
            <div className="tier-letter" style={{ background: TIERS[tier].color }} title={TIERS[tier].meaning}>
              {TIER_LABEL[tier] ?? tier}
            </div>
            <div className="tier-cards">
              {list.map(({ id, t, r }) => {
                const on = owned.has(id);
                return (
                  <article key={id} className={`tier-card${on ? ' owned' : ''}`}>
                    <header>
                      <img src={itemIcon(t.item)} width={32} height={32} alt="" />
                      <div>
                        <b>{r.name}</b>
                        <small>
                          <img src={icon(nameOf(r.building))} width={14} height={14} alt="" /> {buildings[r.building]?.name}
                        </small>
                      </div>
                      <TierBadge id={id} />
                    </header>
                    <div className="formula">
                      {r.inputs.map((f) => `${fmt(f.rate)} ${nameOf(f.item)}`).join(' + ')} → {r.outputs.map((f) => `${fmt(f.rate)} ${nameOf(f.item)}`).join(' + ')} <span className="unit">/min</span>
                    </div>
                    {t.resources !== null ? (
                      <div className="deltas">
                        <span className="unit">vs standard {nameOf(t.item)}:</span>
                        <Delta label="resources" v={t.resources} />
                        <Delta label="power" v={t.power} />
                        <Delta label="buildings" v={t.buildings} />
                      </div>
                    ) : (
                      <div className="deltas"><span className="unit">No standard recipe makes {nameOf(t.item)} – this unlocks it.</span></div>
                    )}
                    <label className="chk own">
                      <input type="checkbox" checked={on} onChange={(e) => onToggle(id, e.target.checked)} />
                      {on ? 'Unlocked' : 'Not unlocked'}
                    </label>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null,
      )}
      {!total && <p className="hint">No alternate recipe matches.</p>}
    </div>
  );
}

const TIERS_BY_RECIPE = Object.fromEntries(Object.keys(recipeById).map((id) => [id, tierOf(id)]).filter(([, t]) => t)) as Record<string, TierInfo>;
