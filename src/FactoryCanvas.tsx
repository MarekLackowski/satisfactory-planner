import { useEffect, useRef, useState } from 'react';
import { buildings, extractors, fmt, icon, itemIcon, items, nameOf } from './game';
import { LANE_GAP, type Layout, type NodeBox, type Path, type Pt, type Segment } from './layout';

const imgCache = new Map<string, HTMLImageElement>();
function img(src: string) {
  let i = imgCache.get(src);
  if (!i) {
    i = new Image();
    i.src = src;
    imgCache.set(src, i);
  }
  return i.complete && i.naturalWidth ? i : null;
}

const capacity = (s: Segment) => s.conv[0].rate * s.conv.length;
const loadColor = (load: number) =>
  load > 1 + 1e-6 ? '#e5484d' : load > 0.95 ? '#f5a524' : load > 0.7 ? '#c9b33a' : '#3fa66a';

function pointAt(s: Path, d: number): Pt {
  let i = 1;
  while (i < s.cum.length - 1 && s.cum[i] < d) i++;
  const a = s.pts[i - 1];
  const b = s.pts[i];
  const t = (d - s.cum[i - 1]) / (s.cum[i] - s.cum[i - 1] || 1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function distToSeg(p: Pt, s: Segment) {
  let best = Infinity;
  for (let i = 1; i < s.pts.length; i++) {
    const a = s.pts[i - 1];
    const b = s.pts[i];
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)));
  }
  return best;
}

type Props = {
  layout: Layout;
  fitKey: unknown; // view refits when this changes (new plan / direction), not while dragging
  onMoveNode: (id: string, p: Pt) => void;
  playing: boolean;
  speed: number;
  bottlenecks: boolean;
};

export default function FactoryCanvas({ layout, fitKey, onMoveNode, playing, speed, bottlenecks }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const time = useRef(0);
  const opts = useRef({ playing, speed, bottlenecks });
  useEffect(() => {
    opts.current = { playing, speed, bottlenecks };
  }, [playing, speed, bottlenecks]);
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  const layoutRef = useRef(layout);
  // read by the animation loop, so dragging doesn't restart it
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  const fit = () => {
    const c = ref.current;
    if (!c) return;
    const l = layoutRef.current;
    const k = Math.min(c.clientWidth / l.w, c.clientHeight / l.h, 1.5);
    view.current = { k, x: (c.clientWidth - l.w * k) / 2 - l.x * k, y: (c.clientHeight - l.h * k) / 2 - l.y * k };
  };
  useEffect(fit, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    let last = performance.now();
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim();

    const drawNode = (n: NodeBox) => {
      const g = n.group;
      ctx.fillStyle = col('--node');
      ctx.strokeStyle = g.kind === 'output' || g.kind === 'sink' ? col('--accent') : col('--line');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.w, n.h, 8);
      ctx.fill();
      ctx.stroke();
      const head = g.building ? icon(nameOf(g.building)) : g.kind === 'sink' ? icon('AWESOME Sink') : itemIcon((g.outputs[0] ?? g.inputs[0]).item);
      const hi = img(head);
      if (hi) ctx.drawImage(hi, n.x + 8, n.y + 5, 20, 20);
      ctx.fillStyle = col('--text');
      ctx.font = '600 12px system-ui, sans-serif';
      const title = g.kind === 'recipe' ? `${g.label} · ${g.machines.length}× ${nameOf(g.building!)}` : g.label;
      ctx.fillText(title, n.x + 32, n.y + 19, n.w - 40);
      if (!g.lines.length) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = col('--muted');
        const f = [...g.inputs, ...g.outputs];
        ctx.fillText(f.map((x) => `${fmt(x.rate)}/min ${nameOf(x.item)}`).join(', '), n.x + 10, n.y + 44, n.w - 20);
      }
      for (const m of n.machines) {
        ctx.fillStyle = col('--machine');
        ctx.strokeStyle = m.clock < 0.999 ? col('--under') : m.clock > 1.001 ? col('--over') : col('--line');
        ctx.beginPath();
        ctx.roundRect(m.x, m.y, m.w, m.h, 5);
        ctx.fill();
        ctx.stroke();
        const bi = g.building && img(icon(nameOf(g.building)));
        if (bi) ctx.drawImage(bi, m.x + 12, m.y + 6, 36, 36);
        ctx.fillStyle = m.clock < 0.999 ? col('--under') : m.clock > 1.001 ? col('--over') : col('--muted');
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${+(m.clock * 100).toFixed(2)}%${m.shards ? ` ◆${m.shards}` : ''}`, m.x + m.w / 2, m.y + m.h - 6);
        ctx.textAlign = 'left';
      }
    };

    const stroke = (p: Path) => {
      ctx.beginPath();
      p.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    };
    const drawSeg = (s: Segment, t: number) => {
      const load = s.rate / capacity(s);
      const w = s.fluid ? 6 : 5;
      const v = 20 + s.conv[0].rate * 0.05; // px/s, faster tiers move faster
      const perLane = s.rate / s.lanes.length;
      ctx.lineJoin = 'round';
      for (const lane of s.lanes) {
        stroke(lane);
        ctx.lineWidth = w + 2;
        ctx.strokeStyle = col('--belt-edge');
        ctx.stroke();
        ctx.lineWidth = w;
        ctx.strokeStyle = opts.current.bottlenecks ? loadColor(load) : s.fluid ? col('--pipe') : col('--belt');
        ctx.stroke();
        if (s.fluid) {
          const c = items[s.item].color ?? [80, 140, 255];
          ctx.setLineDash([6, 8]);
          ctx.lineDashOffset = -t * v;
          ctx.lineWidth = w - 3;
          ctx.strokeStyle = `rgb(${c.join(',')})`;
          ctx.stroke();
          ctx.setLineDash([]);
          continue;
        }
        if (perLane <= 0 || lane.len < 1) continue;
        const spacing = Math.max(15, v / (perLane / 60));
        const ic = img(itemIcon(s.item));
        for (let d = (t * v) % spacing; d < lane.len; d += spacing) {
          const p = pointAt(lane, d);
          if (ic) ctx.drawImage(ic, p.x - 6, p.y - 6, 12, 12);
          else {
            ctx.fillStyle = col('--accent');
            ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
          }
        }
      }
      if (s.lanes.length > 1) {
        // splitter at the start, merger at the end: a bar across all parallel belts
        const span = (s.lanes.length - 1) * LANE_GAP + 10;
        for (const [p, q] of [[s.pts[0], s.pts[1]], [s.pts[s.pts.length - 1], s.pts[s.pts.length - 2]]]) {
          const horiz = Math.abs(q.x - p.x) > Math.abs(q.y - p.y);
          ctx.fillStyle = col('--belt-edge');
          ctx.fillRect(p.x - (horiz ? 4 : span / 2), p.y - (horiz ? span / 2 : 4), horiz ? 8 : span, horiz ? span : 8);
        }
      }
    };

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (opts.current.playing) time.current += dt * opts.current.speed;
      const dpr = devicePixelRatio || 1;
      if (c.width !== c.clientWidth * dpr || c.height !== c.clientHeight * dpr) {
        c.width = c.clientWidth * dpr;
        c.height = c.clientHeight * dpr;
      }
      const { x, y, k } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = col('--canvas');
      ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
      const layout = layoutRef.current;
      layout.nodes.forEach(drawNode);
      // edges between groups are drawn under internal belts so manifolds stay readable
      layout.segs.filter((s) => s.edge).forEach((s) => drawSeg(s, time.current));
      layout.segs.filter((s) => !s.edge).forEach((s) => drawSeg(s, time.current));
      ctx.font = '600 10px system-ui, sans-serif';
      for (const s of layout.segs) {
        if (!s.edge && s.conv.length < 2) continue;
        const p = pointAt(s, s.len / 2);
        const label = `${s.conv.length > 1 ? `${s.conv.length}× ` : ''}Mk.${s.conv[0].mk} · ${fmt(s.rate)}/min`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = col('--label-bg');
        ctx.fillRect(p.x + 6, p.y - 8, tw + 6, 14);
        ctx.fillStyle = col('--text');
        ctx.fillText(label, p.x + 9, p.y + 3);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const { x, y, k } = view.current;
    return { x: (e.clientX - r.left - x) / k, y: (e.clientY - r.top - y) / k, sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const drag = useRef<{ x: number; y: number } | null>(null);
  const grab = useRef<{ id: string; dx: number; dy: number } | null>(null);
  // touch: active pointers + last pinch (finger distance and midpoint, client coords)
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; mx: number; my: number } | null>(null);
  const pinchNow = () => {
    const [a, b] = [...pointers.current.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  /** zoom by factor keeping the world point under screen point (sx, sy) fixed; optional pan to (tx, ty) */
  const zoomAt = (sx: number, sy: number, factor: number, tx = sx, ty = sy) => {
    const { x, y, k } = view.current;
    const k2 = Math.min(4, Math.max(0.05, k * factor));
    const wx = (sx - x) / k;
    const wy = (sy - y) / k;
    view.current = { k: k2, x: tx - wx * k2, y: ty - wy * k2 };
  };
  const release = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
    grab.current = null;
  };
  const nodeAt = (p: Pt) => layout.nodes.find((n) => p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h);
  const onMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const r = ref.current!.getBoundingClientRect();
      const now = pinchNow();
      zoomAt(pinch.current.mx - r.left, pinch.current.my - r.top, now.d / pinch.current.d, now.mx - r.left, now.my - r.top);
      pinch.current = now;
      return;
    }
    if (grab.current) {
      const p = toWorld(e);
      onMoveNode(grab.current.id, { x: Math.round((p.x - grab.current.dx) / 10) * 10, y: Math.round((p.y - grab.current.dy) / 10) * 10 });
      return;
    }
    if (drag.current) {
      view.current.x += e.clientX - drag.current.x;
      view.current.y += e.clientY - drag.current.y;
      drag.current = { x: e.clientX, y: e.clientY };
      setTip(null);
      return;
    }
    const p = toWorld(e);
    ref.current!.style.cursor = nodeAt(p) ? 'move' : '';
    const seg = layout.segs.find((s) => distToSeg(p, s) < 6 / view.current.k + ((s.lanes.length - 1) * LANE_GAP) / 2);
    if (seg) {
      const cap = capacity(seg);
      return setTip({
        x: p.sx, y: p.sy,
        lines: [
          nameOf(seg.item),
          `${fmt(seg.rate)} /min on ${seg.conv.length > 1 ? `${seg.conv.length}× ` : ''}${seg.conv[0].name}`,
          `Load ${fmt((seg.rate / cap) * 100, 1)}% of ${fmt(cap)} /min`,
        ],
      });
    }
    const n = nodeAt(p);
    if (!n) return setTip(null);
    const g = n.group;
    const b = g.building ? (buildings[g.building] ?? extractors[g.building]) : null;
    setTip({
      x: p.sx, y: p.sy,
      lines: [
        g.label,
        ...(b ? [`${g.machines.length}× ${b.name} in ${g.lines.length} line(s)`] : []),
        ...g.inputs.map((f) => `in: ${fmt(f.rate)}/min ${nameOf(f.item)}`),
        ...g.outputs.map((f) => `out: ${fmt(f.rate)}/min ${nameOf(f.item)}`),
        ...(g.power ? [`Power: ${fmt(g.power)} MW`] : []),
        ...(g.note ? [g.note] : []),
      ],
    });
  };

  return (
    <div className="canvas-wrap">
      <canvas
        ref={ref}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            // second finger: switch from drag/pan to pinch-zoom
            drag.current = null;
            grab.current = null;
            pinch.current = pinchNow();
            setTip(null);
            return;
          }
          const p = toWorld(e);
          const n = nodeAt(p);
          if (n) grab.current = { id: n.group.id, dx: p.x - n.x, dy: p.y - n.y };
          else drag.current = { x: e.clientX, y: e.clientY };
          setTip(null);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerMove={onMove}
        onPointerLeave={() => setTip(null)}
        onWheel={(e) => {
          const p = toWorld(e);
          zoomAt(p.sx, p.sy, Math.exp(-e.deltaY * 0.0015));
        }}
      />
      <button className="fit" onClick={fit} title="Fit to screen">⤢ Fit</button>
      {tip && (
        <div className="tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {tip.lines.map((l, i) => (
            <div key={i} className={i ? '' : 'tip-title'}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
