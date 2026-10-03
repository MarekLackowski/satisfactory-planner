import { useEffect, useRef, useState } from 'react';
import { amount, buildings, extractors, fmt, icon, itemIcon, items, nameOf, TIER_COLORS, type ColorBy } from './game';
import { buildSim, step, type Sim } from './sim';
import WiringDiagram from './WiringDiagram';
import type { Wiring } from './wiring';
import { LANE_GAP, titleOf, type Layout, type NodeBox, type Path, type Pt, type Segment } from './layout';

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

const capacity = (s: Segment) => s.conv.reduce((a, c) => a + c.rate, 0);
/** "Mk.2" or "Mk.2 + Mk.1" (2× when equal) */
const tiers = (s: Segment) =>
  s.conv.every((c) => c.mk === s.conv[0].mk) ? `${s.conv.length > 1 ? `${s.conv.length}× ` : ''}Mk.${s.conv[0].mk}` : s.conv.map((c) => `Mk.${c.mk}`).join(' + ');
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

const INFO_LINE = 15; // must match layout's simple-box line height

type Rect = { x: number; y: number; w: number; h: number };
type Label = Rect & { text: string };
const labelCache = new WeakMap<Layout, Label[]>();

/** where a vertical belt piece crosses a horizontal one of another belt: drawn as an overpass (lift) */
type Bridge = { seg: Segment; lane: number; x: number; y: number };
const bridgeCache = new WeakMap<Layout, Bridge[]>();
function findBridges(layout: Layout): Bridge[] {
  const h: { s: Segment; y: number; x1: number; x2: number }[] = [];
  const v: { s: Segment; x: number; y1: number; y2: number }[] = [];
  for (const s of layout.segs) {
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1];
      const b = s.pts[i];
      if (a.y === b.y) h.push({ s, y: a.y, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x) });
      else v.push({ s, x: a.x, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) });
    }
  }
  const out: Bridge[] = [];
  for (const q of v) {
    for (const p of h) {
      if (p.s === q.s || !(q.x > p.x1 + 2 && q.x < p.x2 - 2 && p.y > q.y1 + 2 && p.y < q.y2 - 2)) continue;
      q.s.lanes.forEach((_, k) => out.push({ seg: q.s, lane: k, x: q.x, y: p.y }));
    }
  }
  return out;
}

/** belt labels for links between groups, placed where they cover neither a group nor another label */
function placeLabels(layout: Layout, ctx: CanvasRenderingContext2D): Label[] {
  const taken: Rect[] = layout.nodes.map((n) => ({ x: n.x - 3, y: n.y - 3, w: n.w + 6, h: n.h + 6 }));
  const free = (r: Rect) => !taken.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
  const out: Label[] = [];
  for (const s of layout.segs) {
    if (!s.edge) continue;
    const text = `${tiers(s)} · ${fmt(s.rate)}/min`;
    const w = ctx.measureText(text).width + 6;
    const h = 14;
    const side = ((s.lanes.length - 1) * LANE_GAP) / 2 + 5;
    const pieces = s.pts.slice(1).map((b, i) => ({ a: s.pts[i], b })).sort((p, q) =>
      Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) - Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y));
    let spot: Rect | null = null;
    search: for (const { a, b } of pieces) {
      for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const horiz = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
        for (const r of horiz
          ? [{ x: p.x - w / 2, y: p.y - side - h, w, h }, { x: p.x - w / 2, y: p.y + side, w, h }]
          : [{ x: p.x + side, y: p.y - h / 2, w, h }, { x: p.x - side - w, y: p.y - h / 2, w, h }]) {
          if (free(r)) { spot = r; break search; }
        }
      }
    }
    if (!spot) continue; // ponytail: no free spot → skip; the tooltip still has the numbers
    taken.push(spot);
    out.push({ ...spot, text });
  }
  return out;
}

type Props = {
  layout: Layout;
  fitKey: unknown; // view refits when this changes (new plan / direction), not while dragging
  onMoveNode: (id: string, p: Pt) => void;
  playing: boolean;
  speed: number;
  colorBy: ColorBy;
};

export default function FactoryCanvas({ layout, fitKey, onMoveNode, playing, speed, colorBy }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const time = useRef(0);
  const simRef = useRef<{ layout: Layout; sim: Sim } | null>(null);
  const opts = useRef({ playing, speed, colorBy });
  useEffect(() => {
    opts.current = { playing, speed, colorBy };
  }, [playing, speed, colorBy]);
  type Tip = { x: number; y: number; lines: string[]; wiring?: Wiring };
  const [tip, setTipState] = useState<(Tip & { style: React.CSSProperties }) | null>(null);

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
      if (hi) ctx.drawImage(hi, n.titleX, n.y + 5, 20, 20);
      ctx.fillStyle = col('--text');
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(titleOf(g), n.titleX + 24, n.y + 19, n.x + n.w - n.titleX - 30);
      if (!g.lines.length) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = col('--muted');
        [...g.inputs, ...g.outputs].forEach((x, i) =>
          ctx.fillText(amount(x.item, x.rate), n.x + 10, n.y + 44 + i * INFO_LINE, n.w - 20));
        if (g.generates) ctx.fillText(`⚡ ${fmt(g.generates)} MW`, n.x + 10, n.y + 44 + (g.inputs.length + g.outputs.length) * INFO_LINE, n.w - 20);
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
    // belts are drawn in passes over the whole network (all outlines, then all surfaces) so joints have no seams
    const drawBelts = (segs: Segment[], t: number) => {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const s of segs) {
        ctx.lineWidth = (s.fluid ? 6 : 5) + 2.5;
        ctx.strokeStyle = col('--belt-edge');
        for (const lane of s.lanes) { stroke(lane); ctx.stroke(); }
      }
      for (const s of segs) {
        ctx.lineWidth = s.fluid ? 6 : 5;
        s.lanes.forEach((lane, k) => {
          const c = s.conv[k];
          ctx.strokeStyle = opts.current.colorBy === 'load' ? loadColor(s.laneRates[k] / c.rate) : TIER_COLORS[c.mk - 1];
          stroke(lane);
          ctx.stroke();
        });
      }
      // overpasses: the vertical belt is redrawn over the crossing with a dark halo, so it reads as passing over
      let bridges = bridgeCache.get(layoutRef.current);
      if (!bridges) bridgeCache.set(layoutRef.current, (bridges = findBridges(layoutRef.current)));
      ctx.lineCap = 'butt';
      for (const br of bridges) {
        const s = br.seg;
        const lane = s.lanes[br.lane];
        // this lane's own vertical piece at the crossing (parallel lanes are offset sideways)
        const piece = lane.pts.findIndex((p, i) => i > 0 && Math.abs(p.x - lane.pts[i - 1].x) < 0.01 && br.y > Math.min(p.y, lane.pts[i - 1].y) && br.y < Math.max(p.y, lane.pts[i - 1].y));
        if (piece < 0) continue;
        const x = lane.pts[piece].x;
        const w = s.fluid ? 6 : 5;
        ctx.strokeStyle = col('--canvas');
        ctx.lineWidth = w + 7;
        ctx.beginPath();
        ctx.moveTo(x, br.y - 9);
        ctx.lineTo(x, br.y + 9);
        ctx.stroke();
        ctx.strokeStyle = col('--belt-edge');
        ctx.lineWidth = w + 2.5;
        ctx.stroke();
        const c2 = s.conv[br.lane];
        ctx.strokeStyle = opts.current.colorBy === 'load' ? loadColor(s.laneRates[br.lane] / c2.rate) : TIER_COLORS[c2.mk - 1];
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(x, br.y - 10.5);
        ctx.lineTo(x, br.y + 10.5);
        ctx.stroke();
      }
      ctx.lineCap = 'round';
      // fluids: liquid streaming through the pipe
      ctx.lineCap = 'butt';
      for (const s of segs) {
        if (!s.fluid) continue;
        const c = items[s.item].color ?? [80, 140, 255];
        ctx.setLineDash([6, 8]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgb(${c.join(',')})`;
        s.lanes.forEach((lane, k) => {
          ctx.lineDashOffset = -t * (s.conv[k].rate / 60) * 6;
          stroke(lane);
          ctx.stroke();
        });
        ctx.setLineDash([]);
      }
      for (const s of segs) {
        if (s.lanes.length < 2) continue;
        // parallel belts split at the start and merge at the end: a bar across them
        const span = (s.lanes.length - 1) * LANE_GAP + 10;
        for (const [p, q] of [[s.pts[0], s.pts[1]], [s.pts[s.pts.length - 1], s.pts[s.pts.length - 2]]]) {
          const horiz = Math.abs(q.x - p.x) > Math.abs(q.y - p.y);
          ctx.fillStyle = col('--belt-edge');
          ctx.fillRect(p.x - (horiz ? 4 : span / 2), p.y - (horiz ? span / 2 : 4), horiz ? 8 : span, horiz ? span : 8);
        }
      }
    };
    const JUNCTION_ICON = { splitter: 'Conveyor Splitter', merger: 'Conveyor Merger', junction: 'Pipeline Junction' } as const;
    // every belt piece long enough carries its tier, so short pieces are readable without hovering
    const drawTierBadges = (segs: Segment[], zoom: number) => {
      // constant on-screen size (~11px) so badges stay readable when zoomed out
      const z = Math.max(1, 0.85 / zoom);
      ctx.font = `700 ${8 * z}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      for (const s of segs) {
        if (s.len < 34 * z) continue;
        // middle of the longest straight piece
        let best = 1;
        for (let i = 2; i < s.pts.length; i++) if (s.cum[i] - s.cum[i - 1] > s.cum[best] - s.cum[best - 1]) best = i;
        if (s.cum[best] - s.cum[best - 1] < 26 * z) continue;
        const a = s.pts[best - 1];
        const b = s.pts[best];
        // one badge per parallel belt, side by side along the belt
        const horiz = a.y === b.y;
        s.conv.forEach((c, k) => {
          const shift = (k - (s.conv.length - 1) / 2) * 14 * z;
          const x = (a.x + b.x) / 2 + (horiz ? shift : 0);
          const y = (a.y + b.y) / 2 + (horiz ? 0 : shift);
          const t = c.mk;
          ctx.fillStyle = TIER_COLORS[t - 1];
          ctx.strokeStyle = col('--belt-edge');
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(x - 6.5 * z, y - 6.5 * z, 13 * z, 13 * z, 3 * z);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = t >= 5 ? '#111' : '#fff';
          ctx.fillText(`${s.fluid ? 'P' : ''}${t}`, x, y + 3 * z);
        });
      }
      ctx.textAlign = 'left';
    };
    const drawSim = (sim: Sim) => {
      for (const b of sim.belts) {
        const ic = img(itemIcon(b.seg.item));
        b.lanes.forEach((lane, k) => {
          const path = b.seg.lanes[k];
          const scale = path.len / (b.seg.len || 1);
          for (const it of lane) {
            const p = pointAt(path, it.d * scale);
            if (ic) ctx.drawImage(ic, p.x - 6, p.y - 6, 12, 12);
            else {
              ctx.fillStyle = col('--accent');
              ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
            }
          }
        });
      }
      // splitters / mergers on top of the items passing through them
      for (const j of sim.junctions) {
        ctx.fillStyle = col('--machine');
        ctx.strokeStyle = j.kind === 'splitter' ? col('--accent') : j.kind === 'merger' ? col('--under') : col('--pipe');
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(j.x - 9, j.y - 9, 18, 18, 4);
        ctx.fill();
        ctx.stroke();
        const ji = img(icon(JUNCTION_ICON[j.kind]));
        if (ji) ctx.drawImage(ji, j.x - 8, j.y - 8, 16, 16);
      }
    };

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const layout = layoutRef.current;
      if (simRef.current?.layout !== layout) simRef.current = { layout, sim: buildSim(layout, simRef.current?.sim) };
      if (opts.current.playing) {
        time.current += dt * opts.current.speed;
        // fixed sub-steps keep fast speeds stable
        const n = Math.ceil((dt * opts.current.speed) / 0.04);
        for (let i = 0; i < n; i++) step(simRef.current.sim, (dt * opts.current.speed) / n);
      }
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
      layout.nodes.forEach(drawNode);
      drawBelts(layout.segs, time.current);
      drawSim(simRef.current.sim);
      if (k > 0.2) drawTierBadges(layout.segs, k);
      ctx.font = '600 10px system-ui, sans-serif';
      let labels = labelCache.get(layout);
      if (!labels) labelCache.set(layout, (labels = placeLabels(layout, ctx)));
      for (const l of labels) {
        ctx.fillStyle = col('--label-bg');
        ctx.fillRect(l.x, l.y, l.w, l.h);
        ctx.fillStyle = col('--text');
        ctx.fillText(l.text, l.x + 3, l.y + 10.5);
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
  // keep the tooltip on screen: open towards the side with more room
  const setTip = (t: Tip | null) => setTipState(t && { ...t, style: tipPos(t) });
  const tipPos = (t: { x: number; y: number }): React.CSSProperties => {
    const W = ref.current?.clientWidth ?? 0;
    const H = ref.current?.clientHeight ?? 0;
    return {
      ...(t.x > W / 2 ? { right: W - t.x + 14 } : { left: t.x + 14 }),
      ...(t.y > H / 2 ? { bottom: H - t.y + 14 } : { top: t.y + 14 }),
    };
  };
  // splitter/merger blocks at ports carry their build recipe
  const junctionAt = (p: Pt) =>
    simRef.current?.sim.junctions.find((j) => j.wiring && Math.abs(j.x - p.x) < 11 && Math.abs(j.y - p.y) < 11);
  const recipeTip = (j: NonNullable<ReturnType<typeof junctionAt>>, p: { sx: number; sy: number }) => ({
    x: p.sx, y: p.sy, lines: [`How to build: ${j.wiring!.title}`], wiring: j.wiring,
  });
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
    const jn = junctionAt(p);
    if (jn) {
      ref.current!.style.cursor = 'help';
      return setTip(recipeTip(jn, p));
    }
    ref.current!.style.cursor = nodeAt(p) ? 'move' : '';
    const seg = layout.segs.find((s) => distToSeg(p, s) < 6 / view.current.k + ((s.lanes.length - 1) * LANE_GAP) / 2);
    if (seg) {
      const cap = capacity(seg);
      return setTip({
        x: p.sx, y: p.sy,
        lines: [
          nameOf(seg.item),
          ...(seg.conv.length > 1
            ? seg.conv.map((c, k) => `Belt ${k + 1}: ${fmt(seg.laneRates[k])}/min on ${c.name} (${fmt((seg.laneRates[k] / c.rate) * 100, 1)}%)`)
            : [`${fmt(seg.rate)} /min on ${seg.conv[0].name}`, `Load ${fmt((seg.rate / cap) * 100, 1)}% of ${fmt(cap)} /min`]),
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
        ...g.inputs.map((f) => `in: ${amount(f.item, f.rate)}`),
        ...g.outputs.map((f) => `out: ${amount(f.item, f.rate)}`),
        ...(g.generates ? [`generates: ${fmt(g.generates)} MW`] : []),
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
          const jn = junctionAt(p);
          if (jn) return setTip(recipeTip(jn, p)); // tap on touch screens
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
        <div className={`tip${tip.wiring ? ' tip-wide' : ''}`} style={tip.style}>
          {tip.lines.map((l, i) => (
            <div key={i} className={i ? '' : 'tip-title'}>{l}</div>
          ))}
          {tip.wiring && <WiringDiagram w={tip.wiring} />}
        </div>
      )}
    </div>
  );
}
