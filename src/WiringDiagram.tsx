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
type P = [number, number];
const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** build recipe as a picture: incoming belts/pipes (left) → splitters/manifolds → mergers → where they go (right) */
export default function WiringDiagram({ w }: { w: Wiring }) {
  const fluid = w.fluid;
  const per = fluid ? 'm³/min' : '/min';
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
  const yOfPiece = (p: { to: number; lane: number }) => yDst.get(`${p.to}#${p.lane}`)!;
  const merges = (p: { to: number; lane: number }) => w.pieces.filter((q) => q.to === p.to && q.lane === p.lane).length > 1;

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
  };
  // splitter / merger, or a pipeline junction for fluids
  const block = (x: number, y: number, kind: 'splitter' | 'merger', key: string, badge?: string) => {
    taken.push({ x: x - 14, y: y - 14, w: 28, h: 28 });
    const ico = fluid ? 'Pipeline Junction' : kind === 'splitter' ? 'Conveyor Splitter' : 'Conveyor Merger';
    nodes.push(
      <g key={key}>
        <rect x={x - 13} y={y - 13} width={26} height={26} rx={5} fill="var(--machine)" stroke={fluid ? 'var(--pipe)' : kind === 'splitter' ? 'var(--accent)' : 'var(--under)'} strokeWidth={1.5} />
        <image href={icon(ico)} x={x - 10} y={y - 10} width={20} height={20} />
      </g>,
    );
    if (badge) {
      const below = { x: x - 32, y: y + 15, w: 64, h: 15 };
      const above = { x: x - 32, y: y - 30, w: 64, h: 15 };
      const r = taken.some((t) => hit(t, below)) ? above : below;
      taken.push(r);
      pill(x, r.y + 8, badge, `${key}b`, badge === 'uneven' || badge === 'manifold' ? 'var(--muted)' : 'var(--accent)');
    }
  };
  /** a belt or pipe: smooth curve between two points, or a straight polyline; at(t) gives a point along it */
  const draw = (pts: P[], key: string) => {
    const smooth = pts.length === 2;
    const [x1, y1] = pts[0];
    const [x2, y2] = pts[pts.length - 1];
    const mx = (x1 + x2) / 2;
    const d = smooth ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` : `M${pts.map((p) => p.join(',')).join(' L')}`;
    belts.push(
      <g key={key}>
        <path d={d} fill="none" stroke="var(--belt-edge)" strokeWidth={fluid ? 7 : 6} />
        <path d={d} fill="none" stroke={fluid ? 'var(--pipe)' : 'var(--belt)'} strokeWidth={fluid ? 5 : 4} />
      </g>,
    );
    return (t: number): { x: number; y: number } => {
      if (smooth) {
        const bz = (a: number, b: number, c: number, e: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * e;
        return { x: bz(x1, mx, mx, x2), y: bz(y1, y1, y2, y2) };
      }
      // along the last (horizontal) leg, where the label reads best
      const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
      return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
    };
  };
  const label = (at: (t: number) => { x: number; y: number }, rate: number, prefer: number[], key: string) => {
    const text = `${fmt(rate)}${per}`;
    const wd = text.length * 5.8 + 8;
    const spots = [...prefer, 0.1, 0.9].map(at).map((q) => ({ x: q.x - wd / 2, y: q.y - 8, w: wd, h: 15 }));
    const r = spots.find((s) => !taken.some((t) => hit(t, s))) ?? spots[0];
    taken.push(r);
    pill(r.x + wd / 2, r.y + 8, text, key);
  };

  for (const { s, i } of srcRows) box(0, ySrc.get(i)!, s.icon, s.label, `${fmt(s.rate)}${per}`, `s${i}`);
  for (const r of dstRows) {
    box(DST_X, yDst.get(`${r.j}#${r.lane}`)!, r.d.icon, r.d.label,
      `${r.d.lanes > 1 ? `${fluid ? 'pipe' : 'belt'} ${r.lane + 1}/${r.d.lanes} · ` : ''}${fmt(r.ins.reduce((a, p) => a + p.rate, 0))}${per}`, `d${r.j}-${r.lane}`);
  }
  for (const r of dstRows) {
    if (r.ins.length < 2) continue;
    const y = yDst.get(`${r.j}#${r.lane}`)!;
    block(MERGE_X, y, 'merger', `m${r.j}-${r.lane}`);
    draw([[MERGE_X + 13, y], [DST_X, y]], `mb${r.j}-${r.lane}`);
  }
  const kinds: string[] = [];
  srcRows.forEach(({ i }) => {
    const ps = used[i];
    const y = ySrc.get(i)!;
    const end = (p: (typeof ps)[number]) => (merges(p) ? MERGE_X - 13 : DST_X);
    if (ps.length === 1) {
      const p = ps[0];
      label(draw([[BOX, y], [end(p), yOfPiece(p)]], `p${i}`), p.rate, merges(p) ? [0.16, 0.3, 0.45] : [0.86, 0.72, 0.6], `l${i}`);
      return;
    }
    const kind = fluid ? (ps.length > 3 ? 'manifold' : 'even') : splitKind(ps.map((p) => p.rate));
    kinds.push(kind);
    if (kind !== 'manifold') {
      draw([[BOX, y], [SPLIT_X - 13, y]], `sb${i}`);
      block(SPLIT_X, y, 'splitter', `sp${i}`, fluid ? undefined : kind === 'even' ? `${ps.map(() => 1).join(':')} split` : kind === '2:1' ? '2:1 split *' : 'uneven');
      ps.forEach((p, k) => label(draw([[SPLIT_X + 13, y], [end(p), yOfPiece(p)]], `p${i}-${k}`), p.rate, merges(p) ? [0.5, 0.65, 0.35] : [0.86, 0.72, 0.6], `l${i}-${k}`));
      return;
    }
    // manifold: splitters in a column, one beside each line it feeds; the belt runs down through them
    const order = [...ps].sort((a, b) => yOfPiece(a) - yOfPiece(b));
    const ys = order.map(yOfPiece);
    draw([[BOX, y], [SPLIT_X - 13, ys[0]]], `sb${i}`);
    order.forEach((p, k) => {
      const last = k === order.length - 1;
      if (!last) {
        block(SPLIT_X, ys[k], 'splitter', `sp${i}-${k}`, k === 0 ? 'manifold' : undefined);
        if (k < order.length - 2) draw([[SPLIT_X, ys[k] + 13], [SPLIT_X, ys[k + 1] - 13]], `chain${i}-${k}`);
        label(draw([[SPLIT_X + 13, ys[k]], [end(p), ys[k]]], `p${i}-${k}`), p.rate, [0.7, 0.5, 0.85], `l${i}-${k}`);
      } else {
        // what's left after the last splitter carries straight on to the last line
        const at = draw([[SPLIT_X, ys[k - 1] + 13], [SPLIT_X, ys[k]], [end(p), ys[k]]], `p${i}-${k}`);
        label(at, p.rate, [0.7, 0.5, 0.85], `l${i}-${k}`);
      }
    });
  });

  return (
    <figure className="wiring">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={w.steps.join('. ')}>
        <text x={0} y={12} fontSize={10} fill="var(--muted)">{fluid ? 'INCOMING PIPES' : 'INCOMING BELTS'}</text>
        <text x={W} y={12} fontSize={10} fill="var(--muted)" textAnchor="end">GOES TO</text>
        {belts}
        {nodes}
        {labels}
      </svg>
      {(kinds.includes('2:1') || kinds.includes('uneven') || kinds.includes('manifold')) && (
        <figcaption>
          {kinds.includes('2:1') && <div>* 2:1 — use all 3 splitter outputs and merge two of them into the bigger belt.</div>}
          {kinds.includes('uneven') && <div>uneven — the side needing less fills up and the rest flows on.</div>}
          {kinds.includes('manifold') && (fluid
            ? <div>manifold — one junction per branch along the pipe; pipes share the flow by themselves.</div>
            : <div>manifold — splitters in a row along one belt: each line fills up and passes the rest to the next.</div>)}
        </figcaption>
      )}
    </figure>
  );
}
