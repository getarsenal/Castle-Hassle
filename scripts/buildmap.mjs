// Extract the Europe→Middle East region from public-domain Natural Earth data
// (world-atlas, 50m) into a compact GeoJSON-ish ring list for the campaign map.
import { feature } from 'topojson-client';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const land = require('world-atlas/land-50m.json');
const geo = feature(land, land.objects.land);

// region bbox (lon/lat) covering England down to the Levant
const BB = { w: -12, e: 42, s: 29, n: 60 };
const inBB = (lon, lat) => lon >= BB.w - 4 && lon <= BB.e + 4 && lat >= BB.s - 4 && lat <= BB.n + 4;

// Douglas-Peucker-ish: keep every Nth point but always keep ring endpoints.
function simplify(ring, tol) {
  if (ring.length < 6) return ring;
  const out = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) {
    const [x, y] = ring[i], [px, py] = out[out.length - 1];
    if (Math.hypot(x - px, y - py) > tol) out.push(ring[i]);
  }
  out.push(ring[ring.length - 1]);
  return out;
}

const rings = [];
for (const f of geo.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      // keep the ring if any vertex is near the region
      if (!ring.some(([lon, lat]) => inBB(lon, lat))) continue;
      const s = simplify(ring, 0.12).map(([lon, lat]) => [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100]);
      if (s.length >= 4) rings.push(s);
    }
  }
}
const flat = rings.map(r => r.flat());
writeFileSync('public/worldmap.json', JSON.stringify({ bb: BB, rings: flat }));
console.log(`worldmap.json: ${rings.length} rings, ${(JSON.stringify(flat).length / 1024).toFixed(0)} KB`);
