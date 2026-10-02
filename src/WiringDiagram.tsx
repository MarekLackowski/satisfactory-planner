import { fmt, icon } from './game';
import { splitKind, type Wiring } from './wiring';

const ROW = 50; // one belt per row
const BOX = 172; // source / destination box width
const W = 580;
const SPLIT_X = 212; // splitter column
const MERGE_X = 366; // merger column
const DST_X = W - BOX;
const TOP = 26;

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
type Rect = { x: number; y: number; w: number; h: number };
const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** build recipe as a picture: incoming belts (left) → splitters → mergers → outgoing belts (right) */
export default function WiringDiagram({ w }: { w: Wiring }) {
  const used = w.sources.map((_, i) => w.pieces.filter((p) => p.from === i));
  const srcRows = w.sources.map((s, i) => ({ s, i })).filter(({ i }) => used[i].length);
  const srcPos = new Map(srcRows.map(({ i }, k) => [i, k]));
  // one destination row per physical belt that receives something, ordered by where its belts come from
  // (barycentre of the source rows) so the lines between the two columns cross as little as possible
  const dstRows = w.sinks
    .flatMap((d, j) => Array.from({ length: d.lanes }, (_, lane) => ({ d, j, lane, ins: w.pieces.filter((p) => p.to === j && p.lane === lane) })))
    .filter((r) => r.ins.length)
    .map((r, k) => {
      const wsum = r.ins.reduce((a, p) => a + p.rate, 0) || 1;
      return { ...r, key: r.ins.reduce((a, p) => a + srcPos.get(p.from)! * p.rate, 0) / wsum + k * 1e-6 };
    })
    .sort((a, b) => a.key - b.key);
  const rows = Math.max(srcRows.length, dstRows.length);
  const H = TOP + rows * ROW + 16;
  const yOf = (k: number, n: number) => TOP + ((rows - n) * ROW) / 2 + k * ROW + ROW / 2;
  const ySrc = new Map(srcRows.map(({ i }, k) => [i, yOf(k, srcRows.length)]));
  const yDst = new Map(dstRows.map((r, k) => [`${r.j}#${r.lane}`, yOf(k, dstRows.length)]));

  // three layers: belts below, boxes and blocks above them, labels on top (placed so they don't collide)
  const belts: React.ReactNode[] = [];
  const nodes: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];
  const taken: Rect[] = [];

  const box = (x: number, y: number, ico: string, name: string, sub: string, key: string) => {
    taken.push({ x, y: y - 18, w: BOX, h: 36 });
    nodes.push(
      <g key={key}>
        <rect x={x} y={y - 18} width={BOX} height={36} rx={6} fill="var(--node)" stroke="var(--line)" />
        <image href={icon(ico)} x={x + 5} y={y - 12} width={24} height={24} />
        <text x={x + 34} y={y - 3} fontSize={11} fontWeight={600} fill="var(--text)">{trunc(name, 22)}</text>
        <text x={x + 34} y={y + 11} fontSize={10.5} fill="var(--muted)">{sub}</text>
      </g>,
    );
  };
  const pill = (cx: number, cy: number, text: string, key: string, color = 'var(--text)') => {
    const wd = text.length * 5.8 + 8;
    labels.push(
      <g key={key}>
        <rect x={cx - wd / 2} y={cy - 8} width={wd} height={15} rx={3} fill="var(--label-bg)" stroke="var(--line)" strokeWidth={0.5} />
        <text x={cx} y={cy + 3} fontSize={10} fontWeight={600} textAnchor="middle" fill={color}>{text}</text>
      </g>,
    );
    return wd;
  };
  const block = (x: number, y: number, kind: 'splitter' | 'merger', key: string, badge?: string) => {
    taken.push({ x: x - 14, y: y - 14, w: 28, h: 28 });
    nodes.push(
      <g key={key}>
        <rect x={x - 13} y={y - 13} width={26} height={26} rx={5} fill="var(--machine)" stroke={kind === 'splitter' ? 'var(--accent)' : 'var(--under)'} strokeWidth={1.5} />
        <image href={icon(kind === 'splitter' ? 'Conveyor Splitter' : 'Conveyor Merger')} x={x - 10} y={y - 10} width={20} height={20} />
      </g>,
    );
    if (badge) {
      // the split ratio sits under the block (or above it when the next row is right below)
      const below = { x: x - 32, y: y + 15, w: 64, h: 15 };
      const above = { x: x - 32, y: y - 30, w: 64, h: 15 };
      const r = taken.some((t) => hit(t, below)) ? above : below;
      taken.push(r);
      pill(x, r.y + 8, badge, `${key}b`, badge === 'uneven' ? 'var(--muted)' : 'var(--accent)');
    }
  };
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2;
    return { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, at: (t: number) => {
      const bz = (a: number, b: number, c: number, d: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
      return { x: bz(x1, mx, mx, x2), y: bz(y1, y1, y2, y2) };
    } };
  };
  const belt = (x1: number, y1: number, x2: number, y2: number, key: string) => {
    const c = curve(x1, y1, x2, y2);
    belts.push(
      <g key={key}>
        <path d={c.d} fill="none" stroke="var(--belt-edge)" strokeWidth={6} />
        <path d={c.d} fill="none" stroke="var(--belt)" strokeWidth={4} />
      </g>,
    );
    return c;
  };

  for (const { s, i } of srcRows) {
    const y = ySrc.get(i)!;
    box(0, y, s.icon, s.label, `${fmt(s.rate)}/min`, `s${i}`);
  }
  for (const r of dstRows) {
    const y = yDst.get(`${r.j}#${r.lane}`)!;
    box(DST_X, y, r.d.icon, r.d.label, `${r.d.lanes > 1 ? `belt ${r.lane + 1}/${r.d.lanes} · ` : ''}${fmt(r.ins.reduce((a, p) => a + p.rate, 0))}/min`, `d${r.j}-${r.lane}`);
  }
  for (const { i } of srcRows) {
    const ps = used[i];
    if (ps.length < 2) continue;
    const y = ySrc.get(i)!;
    const kind = splitKind(ps.map((p) => p.rate));
    belt(BOX, y, SPLIT_X - 13, y, `sb${i}`);
    block(SPLIT_X, y, 'splitter', `sp${i}`, kind === 'even' ? `${ps.map(() => 1).join(':')} split` : kind === '2:1' ? '2:1 split *' : 'uneven');
  }
  for (const r of dstRows) {
    if (r.ins.length < 2) continue;
    const y = yDst.get(`${r.j}#${r.lane}`)!;
    block(MERGE_X, y, 'merger', `m${r.j}-${r.lane}`);
    belt(MERGE_X + 13, y, DST_X, y, `mb${r.j}-${r.lane}`);
  }
  // pieces: draw every belt first, then label each where it is free (prefer the end without a block)
  const placed = w.pieces.map((p, k) => {
    const split = used[p.from].length > 1;
    const merge = w.pieces.filter((q) => q.to === p.to && q.lane === p.lane).length > 1;
    const c = belt(split ? SPLIT_X + 13 : BOX, ySrc.get(p.from)!, merge ? MERGE_X - 13 : DST_X, yDst.get(`${p.to}#${p.lane}`)!, `p${k}`);
    return { p, k, c, prefer: !merge ? [0.86, 0.72, 0.6, 0.45] : !split ? [0.16, 0.3, 0.45, 0.6] : [0.5, 0.65, 0.35, 0.78, 0.22] };
  });
  for (const { p, k, c, prefer } of placed) {
    const text = `${fmt(p.rate)}/min`;
    const wd = text.length * 5.8 + 8;
    const spots = [...prefer, 0.1, 0.9].map((t) => c.at(t)).map((q) => ({ x: q.x - wd / 2, y: q.y - 8, w: wd, h: 15 }));
    const r = spots.find((s) => !taken.some((t) => hit(t, s))) ?? spots[0];
    taken.push(r);
    pill(r.x + wd / 2, r.y + 8, text, `l${k}`);
  }

  const kinds = srcRows.filter(({ i }) => used[i].length > 1).map(({ i }) => splitKind(used[i].map((p) => p.rate)));
  return (
    <figure className="wiring">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={w.steps.join('. ')}>
        <text x={0} y={12} fontSize={10} fill="var(--muted)">INCOMING BELTS</text>
        <text x={W} y={12} fontSize={10} fill="var(--muted)" textAnchor="end">GOES TO</text>
        {belts}
        {nodes}
        {labels}
      </svg>
      {(kinds.includes('2:1') || kinds.includes('uneven')) && (
        <figcaption>
          {kinds.includes('2:1') && <div>* 2:1 — use all 3 splitter outputs and merge two of them into the bigger belt.</div>}
          {kinds.includes('uneven') && <div>uneven — the side needing less fills up and the rest overflows on; works once belts back up.</div>}
        </figcaption>
      )}
    </figure>
  );
}
