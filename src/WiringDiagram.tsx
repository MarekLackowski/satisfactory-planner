import { fmt, icon } from './game';
import { splitKind, type Wiring } from './wiring';

const ROW = 46; // one belt per row
const BOX = 172; // source / destination box width
const W = 520;
const SPLIT_X = 214; // splitter column
const MERGE_X = 306; // merger column
const DST_X = W - BOX;

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** build recipe as a picture: incoming belts (left) → splitters → mergers → outgoing belts (right) */
export default function WiringDiagram({ w }: { w: Wiring }) {
  const used = w.sources.map((_, i) => w.pieces.filter((p) => p.from === i));
  const srcRows = w.sources.map((s, i) => ({ s, i })).filter(({ i }) => used[i].length);
  // one destination row per physical belt that receives something
  const dstRows = w.sinks.flatMap((d, j) =>
    Array.from({ length: d.lanes }, (_, lane) => ({ d, j, lane, ins: w.pieces.filter((p) => p.to === j && p.lane === lane) })).filter((r) => r.ins.length));
  const rows = Math.max(srcRows.length, dstRows.length);
  const H = rows * ROW + 26 + 14; // + room for the badge under the last splitter
  const yOf = (k: number, n: number) => 26 + ((rows - n) * ROW) / 2 + k * ROW + ROW / 2;
  const ySrc = new Map(srcRows.map(({ i }, k) => [i, yOf(k, srcRows.length)]));
  const yDst = new Map(dstRows.map((r, k) => [`${r.j}#${r.lane}`, yOf(k, dstRows.length)]));

  const box = (x: number, y: number, ico: string, name: string, sub: string, key: string) => (
    <g key={key}>
      <rect x={x} y={y - 18} width={BOX} height={36} rx={6} fill="var(--node)" stroke="var(--line)" />
      <image href={icon(ico)} x={x + 5} y={y - 12} width={24} height={24} />
      <text x={x + 34} y={y - 3} fontSize={11} fontWeight={600} fill="var(--text)">{trunc(name, 22)}</text>
      <text x={x + 34} y={y + 11} fontSize={10.5} fill="var(--muted)">{sub}</text>
    </g>
  );
  const block = (x: number, y: number, kind: 'splitter' | 'merger', badge?: string, key = '') => (
    <g key={key}>
      <rect x={x - 13} y={y - 13} width={26} height={26} rx={5} fill="var(--machine)" stroke={kind === 'splitter' ? 'var(--accent)' : 'var(--under)'} strokeWidth={1.5} />
      <image href={icon(kind === 'splitter' ? 'Conveyor Splitter' : 'Conveyor Merger')} x={x - 10} y={y - 10} width={20} height={20} />
      {badge && <text x={x} y={y + 25} fontSize={10} fontWeight={600} textAnchor="middle" fill={badge === 'uneven' ? 'var(--muted)' : 'var(--accent)'}>{badge}</text>}
    </g>
  );
  // label at the end where only this belt is (no splitter/merger there), so labels never stack up
  const belt = (x1: number, y1: number, x2: number, y2: number, key: string, label?: string, at: 'start' | 'mid' | 'end' = 'mid') => {
    const mx = (x1 + x2) / 2;
    // point on the curve: near a free end, or (splitter → merger) where neighbouring belts have spread apart
    const t = at === 'start' ? 0.12 : at === 'end' ? 0.88 : 0.72;
    const bz = (a: number, b: number, c2: number, d2: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * d2;
    const lx = bz(x1, mx, mx, x2);
    const ly = bz(y1, y1, y2, y2);
    const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    return (
      <g key={key}>
        <path d={d} fill="none" stroke="var(--belt-edge)" strokeWidth={6} />
        <path d={d} fill="none" stroke="var(--belt)" strokeWidth={4} />
        {label && (
          <g>
            <rect x={lx - 26} y={ly - 8} width={52} height={15} rx={3} fill="var(--label-bg)" />
            <text x={lx} y={ly + 3} fontSize={10} fontWeight={600} textAnchor="middle" fill="var(--text)">{label}</text>
          </g>
        )}
      </g>
    );
  };

  const parts: React.ReactNode[] = [];
  for (const { s, i } of srcRows) {
    const y = ySrc.get(i)!;
    const ps = used[i];
    parts.push(box(0, y, s.icon, s.label, `${fmt(s.rate)}/min`, `s${i}`));
    if (ps.length > 1) {
      const kind = splitKind(ps.map((p) => p.rate));
      parts.push(belt(BOX, y, SPLIT_X - 13, y, `sb${i}`));
      parts.push(block(SPLIT_X, y, 'splitter', kind === 'even' ? `${ps.map(() => 1).join(':')} split` : kind === '2:1' ? '2:1 split *' : 'uneven', `sp${i}`));
    }
  }
  for (const r of dstRows) {
    const y = yDst.get(`${r.j}#${r.lane}`)!;
    const sub = `${r.d.lanes > 1 ? `belt ${r.lane + 1}/${r.d.lanes} · ` : ''}${fmt(r.ins.reduce((a, p) => a + p.rate, 0))}/min`;
    parts.push(box(DST_X, y, r.d.icon, r.d.label, sub, `d${r.j}-${r.lane}`));
    if (r.ins.length > 1) {
      parts.push(block(MERGE_X, y, 'merger', undefined, `m${r.j}-${r.lane}`));
      parts.push(belt(MERGE_X + 13, y, DST_X, y, `mb${r.j}-${r.lane}`));
    }
  }
  w.pieces.forEach((p, k) => {
    const split = used[p.from].length > 1;
    const merge = w.pieces.filter((q) => q.to === p.to && q.lane === p.lane).length > 1;
    const y1 = ySrc.get(p.from)!;
    const y2 = yDst.get(`${p.to}#${p.lane}`)!;
    parts.unshift(belt(split ? SPLIT_X + 13 : BOX, y1, merge ? MERGE_X - 13 : DST_X, y2, `p${k}`, `${fmt(p.rate)}/min`, !merge ? 'end' : !split ? 'start' : 'mid'));
  });
  const twoOne = srcRows.some(({ i }) => used[i].length > 1 && splitKind(used[i].map((p) => p.rate)) === '2:1');
  const uneven = srcRows.some(({ i }) => used[i].length > 1 && splitKind(used[i].map((p) => p.rate)) === 'uneven');

  return (
    <figure className="wiring">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={w.steps.join('. ')}>
        <text x={0} y={12} fontSize={10} fill="var(--muted)">INCOMING BELTS</text>
        <text x={W} y={12} fontSize={10} fill="var(--muted)" textAnchor="end">GOES TO</text>
        {parts}
      </svg>
      {(twoOne || uneven) && (
        <figcaption>
          {twoOne && <div>* 2:1 — use all 3 splitter outputs and merge two of them into the bigger belt.</div>}
          {uneven && <div>uneven — the side needing less fills up and the rest overflows on; works once belts back up.</div>}
        </figcaption>
      )}
    </figure>
  );
}
