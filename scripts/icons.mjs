// Downloads icons from satisfactory.wiki.gg into public/icons (wiki rate-limits hotlinking).
// Usage: node scripts/icons.mjs   (skips files already present)
import fs from 'node:fs';
import sharp from 'sharp';
const g = JSON.parse(fs.readFileSync('src/data/game.json', 'utf8'));

const names = [
  ...Object.values(g.items), ...Object.values(g.buildings), ...Object.values(g.extractors), ...g.belts, ...g.pipes,
].filter((x) => !x.power).map((x) => x.name).concat(['Conveyor Splitter', 'Conveyor Merger', 'Pipeline Junction', 'AWESOME Sink']);

export const slug = (n) => n.replace(/[^\w.-]+/g, '_');
fs.mkdirSync('public/icons', { recursive: true });
const missing = [];
for (const n of names) {
  const out = `public/icons/${slug(n)}.png`;
  if (fs.existsSync(out)) continue;
  const url = 'https://satisfactory.wiki.gg/images/' + encodeURIComponent(n.replace(/ /g, '_')) + '.png';
  let r;
  for (let i = 0; i < 6; i++) {
    r = await fetch(url);
    if (r.status !== 429) break;
    await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
  }
  if (r.ok) fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  else missing.push(`${n} (${r.status})`);
  await new Promise((s) => setTimeout(s, 400));
}
console.log('missing:', missing);

// shrink to 96px: icons are drawn at <=40px, 96 keeps them sharp when zoomed in (full-size wiki files are ~11 MB total)
const SIZE = 96;
for (const f of fs.readdirSync('public/icons')) {
  const p = `public/icons/${f}`;
  const { width = 0, height = 0 } = await sharp(p).metadata();
  if (Math.max(width, height) <= SIZE) continue;
  const buf = await sharp(p).resize(SIZE, SIZE, { fit: 'inside' }).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
  fs.writeFileSync(p, buf);
}
