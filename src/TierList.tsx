import { useMemo, useState } from 'react';
import { fmt, icon, itemIcon, nameOf, recipeById, TIER_SOURCES, TIERS, tierOf, type Flow, type Recipe, type TierInfo } from './game';

const TIER_ORDER = ['S', 'A', 'B', 'C', 'D', 'F', 'N'] as const;

export function TierBadge({ id, size = 22 }: { id: string; size?: number }) {
  const t = tierOf(id);
  if (!t) return null;
  return (
    <span className="tier-badge" style={{ background: TIERS[t.tier].color, width: size, height: size, fontSize: size * 0.58 }} title={`Tier ${t.tier === 'N' ? 'New' : t.tier}`}>
      {t.tier === 'N' ? '★' : t.tier}
    </span>
  );
}

/** an item icon with its amount per craft, like in the game */
const Slot = ({ f, r }: { f: Flow; r: Recipe }) => (
  <span className="slot" title={nameOf(f.item)}>
    <img src={itemIcon(f.item)} alt={nameOf(f.item)} />
    <b>{fmt((f.rate * r.duration) / 60, 1)}</b>
  </span>
);

const pct = (v: number) => `${v > 0 ? '+' : ''}${v}%`;
const Delta = ({ ico, v, label }: { ico: string; v: number | null; label: string }) =>
  v === null ? null : (
    <span className={`delta ${v < -2 ? 'good' : v > 2 ? 'bad' : ''}`} title={`${label} vs standard`}>
      <img src={icon(ico)} alt={label} /> {pct(v)}
    </span>
  );

type Props = { alts: string[]; onBack: () => void };

/** full-page tier list of alternate recipes: icons first, details on hover */
export default function TierList({ alts, onBack }: Props) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'unlocked' | 'locked'>('all');
  const owned = new Set(alts);
  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return TIER_ORDER.map((tier) => ({
      tier,
      list: RATED.filter(({ t }) => t.tier === tier)
        .filter(({ r, t }) => !query || `${r.name} ${nameOf(t.item)} ${nameOf(r.building)}`.toLowerCase().includes(query))
        .filter(({ id }) => (show === 'all' ? true : show === 'unlocked' ? owned.has(id) : !owned.has(id))),
    }));
  }, [q, show, alts]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tier-page">
      <header className="tier-head">
        <button onClick={onBack}>← Planner</button>
        <h1>Alternate recipes</h1>
        <input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search alternate recipes" />
        <span className="seg">
          {(['all', 'unlocked', 'locked'] as const).map((k) => (
            <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{k === 'all' ? 'All' : k === 'unlocked' ? '✓ Unlocked' : 'Locked'}</button>
          ))}
        </span>
        <span className="tier-key" title={`Tier = average of ${TIER_SOURCES.length} community tier lists (80%) + our whole-chain math (20%): raw resources, power, buildings and resources to mine vs the standard recipe. Hover a recipe for each list's verdict.`}>
          {TIER_SOURCES.map((s) => <a key={s.id} href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a>)} + math ⓘ
        </span>
      </header>
      <div className="tier-rows">
        {rows.map(({ tier, list }) => (
          <section key={tier} className="tier-row">
            <div className="tier-letter" style={{ background: TIERS[tier].color }} title={TIERS[tier].meaning}>{tier === 'N' ? '★' : tier}</div>
            <div className="tier-tiles">
              {list.map(({ id, r, t }) => (
                <div key={id} className={`tile2${owned.has(id) ? ' owned' : ''}`} tabIndex={0}>
                  {r.inputs.map((f) => <Slot key={f.item} f={f} r={r} />)}
                  <span className="arrow">▶</span>
                  {r.outputs.map((f) => <Slot key={f.item} f={f} r={r} />)}
                  {owned.has(id) && <span className="check" title="Unlocked">✓</span>}
                  <div className="pop">
                    <b>{r.name}</b>
                    <span className="pop-building"><img src={icon(nameOf(r.building))} alt="" /> {nameOf(r.building)}</span>
                    {t.baseRaw && (
                      <span className="raws" title="Raw resources to mine: standard → this recipe">
                        {Object.keys(t.baseRaw).filter((k) => k !== 'Desc_Water_C').map((k) => <img key={k} src={itemIcon(k)} alt={nameOf(k)} title={nameOf(k)} />)}
                        <span className="arrow">▶</span>
                        {Object.keys(t.raw).filter((k) => k !== 'Desc_Water_C').map((k) => <img key={k} src={itemIcon(k)} alt={nameOf(k)} title={nameOf(k)} />)}
                      </span>
                    )}
                    <span className="votes">
                      {TIER_SOURCES.filter((s) => t.community[s.id]).map((s) => (
                        <span key={s.id} className="vote"><span className="tier-badge" style={{ background: TIERS[t.community[s.id]].color }}>{t.community[s.id]}</span>{s.name}</span>
                      ))}
                      {t.math !== 'N' && <span className="vote"><span className="tier-badge" style={{ background: TIERS[t.math].color }}>{t.math}</span>Math</span>}
                    </span>
                    <span className="deltas">
                      <Delta ico={nameOf('Desc_OreIron_C')} v={t.resources} label="Resources" />
                      <Delta ico="Power Shard" v={t.power} label="Power" />
                      <Delta ico="Constructor" v={t.buildings} label="Buildings" />
                    </span>
                  </div>
                </div>
              ))}
              {!list.length && <span className="unit">–</span>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const RATED = Object.keys(recipeById)
  .map((id) => ({ id, r: recipeById[id], t: tierOf(id) }))
  .filter((x): x is { id: string; r: Recipe; t: TierInfo } => !!x.t)
  .sort((a, b) => b.t.score - a.t.score);
