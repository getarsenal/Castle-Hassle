// Bake the Europe→Middle East region from public-domain Natural Earth data
// (world-atlas, 50m) into: coastline rings (for outlines) + a land/sea grid and
// a coast-distance field (for the 3D terrain mesh).
import { feature } from 'topojson-client';
import { writeFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const land = require('world-atlas/land-50m.json');
const geo = feature(land, land.objects.land);

const BB = { w: -12, e: 42, s: 29, n: 60 };

// ---- coastline rings (simplified) for the map outline / sea-leg detection ----
function simplify(ring, tol) {
  if (ring.length < 6) return ring;
  const out = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) { const [x, y] = ring[i], [px, py] = out[out.length - 1]; if (Math.hypot(x - px, y - py) > tol) out.push(ring[i]); }
  out.push(ring[ring.length - 1]); return out;
}
const rings = [];
const allRings = [];
for (const f of geo.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) for (const ring of poly) {
    allRings.push(ring);
    if (!ring.some(([lon, lat]) => lon >= BB.w - 4 && lon <= BB.e + 4 && lat >= BB.s - 4 && lat <= BB.n + 4)) continue;
    const s = simplify(ring, 0.12).map(([lon, lat]) => [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100]);
    if (s.length >= 4) rings.push(s);
  }
}

// ---- land/sea raster + chamfer coast-distance, for the terrain heightmap ----
const GW = 300, GH = 176;
function onLand(lon, lat) {
  let inside = false;
  for (const r of allRings) {
    let inb = false; for (const [x, y] of r) { if (Math.abs(x - lon) < 14 && Math.abs(y - lat) < 14) { inb = true; break; } }
    if (!inb) continue;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]; if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside; }
  }
  return inside;
}
const mask = new Uint8Array(GW * GH);
for (let gy = 0; gy < GH; gy++) {
  const lat = BB.s + (BB.n - BB.s) * (gy / (GH - 1));
  for (let gx = 0; gx < GW; gx++) { const lon = BB.w + (BB.e - BB.w) * (gx / (GW - 1)); mask[gy * GW + gx] = onLand(lon, lat) ? 1 : 0; }
}
const INF = 9999; const dist = new Float32Array(GW * GH);
for (let i = 0; i < dist.length; i++) dist[i] = mask[i] ? INF : 0;
const relax = (x, y, dx, dy, w) => { if (x + dx < 0 || x + dx >= GW || y + dy < 0 || y + dy >= GH) return; const o = dist[(y + dy) * GW + (x + dx)] + w; if (o < dist[y * GW + x]) dist[y * GW + x] = o; };
for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { relax(x, y, -1, 0, 1); relax(x, y, 0, -1, 1); relax(x, y, -1, -1, 1.41); relax(x, y, 1, -1, 1.41); }
for (let y = GH - 1; y >= 0; y--) for (let x = GW - 1; x >= 0; x--) { relax(x, y, 1, 0, 1); relax(x, y, 0, 1, 1); relax(x, y, 1, 1, 1.41); relax(x, y, -1, 1, 1.41); }
const cdist = new Uint8Array(GW * GH);
for (let i = 0; i < cdist.length; i++) cdist[i] = Math.min(255, Math.round(dist[i]));

const b64 = (u8) => Buffer.from(u8).toString('base64');
// written into src/ so it's bundled (inlined) — no runtime fetch / stale-asset risk
writeFileSync('src/worldmapdata.json', JSON.stringify({ bb: BB, grid: { w: GW, h: GH, mask: b64(mask), cdist: b64(cdist) } }));
console.log(`worldmapdata.json: ${GW}x${GH} grid, ${(statSync('src/worldmapdata.json').size / 1024).toFixed(0)} KB`);
