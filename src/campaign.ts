// Campaign layer: real castles on a real, projected map of Europe & the Near
// East (public-domain Natural Earth coastlines). Progress is saved locally.
import { REAL_CASTLES } from './castles';
import { RIVERS, RANGES, FORESTS, BORDERS, REALMS } from './mapfeatures';

export interface CampaignCastle { id: number; name: string; region: string; lat: number; lon: number; seed: number; tier: number; }

export function generateCastles(): CampaignCastle[] {
  const n = REAL_CASTLES.length;
  return REAL_CASTLES.map(([name, region, lat, lon], i) => ({ id: i, name, region, lat, lon, seed: 1000 + i * 7919, tier: n > 1 ? i / (n - 1) : 0 }));
}

export interface Progress { unlocked: number; completed: number[]; }
const KEY = 'castlehassle.campaign.v1';
export function loadProgress(): Progress {
  try { const p = JSON.parse(localStorage.getItem(KEY) || ''); if (p && typeof p.unlocked === 'number') return { unlocked: p.unlocked, completed: p.completed || [] }; } catch { /* ignore */ }
  return { unlocked: 0, completed: [] };
}
export function saveProgress(p: Progress) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 180 / Math.PI;

interface MapData { rings: number[][]; }

export class CampaignMap {
  private ctx: CanvasRenderingContext2D;
  private cLon = 0; private cyM = 0; private scale = 16; // px per degree-lon
  private rings: number[][] = []; private seaLeg: boolean[] = [];
  private dragging = false; private lastX = 0; private lastY = 0; private movedX = 0; private downX = 0; private downY = 0; private downT = 0;
  private pinchD = 0;
  private raf = 0; private pulse = 0; private ready = false;

  constructor(private canvas: HTMLCanvasElement, private nodes: CampaignCastle[], private prog: Progress, private onSelect: (c: CampaignCastle) => void) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    const cur = nodes[Math.min(prog.unlocked, nodes.length - 1)];
    this.cLon = cur.lon + 6; this.cyM = mercY(cur.lat - 1); this.scale = 17; // show the objective with road/context; pinch to zoom
    this.bind();
    fetch('./worldmap.json').then(r => r.json()).then((d: MapData) => { this.rings = d.rings; this.computeSeaLegs(); this.ready = true; }).catch(() => { this.ready = true; });
    const loop = () => { this.pulse += 0.05; this.draw(); this.raf = requestAnimationFrame(loop); };
    loop();
  }
  destroy() { cancelAnimationFrame(this.raf); this.canvas.replaceWith(this.canvas.cloneNode(false)); }

  private cssW() { return this.canvas.clientWidth; }
  private cssH() { return this.canvas.clientHeight; }
  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = this.canvas.clientWidth * dpr; this.canvas.height = this.canvas.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  private sx(lon: number) { return (lon - this.cLon) * this.scale + this.cssW() / 2; }
  private sy(lat: number) { return (this.cyM - mercY(lat)) * this.scale + this.cssH() / 2; }
  private clampCenter() {
    this.cLon = Math.max(-12, Math.min(42, this.cLon));
    this.cyM = Math.max(mercY(29), Math.min(mercY(60), this.cyM));
    this.scale = Math.max(10, Math.min(110, this.scale));
  }

  // point-in-land test (ray casting across every coastline ring)
  private onLand(lon: number, lat: number) {
    let inside = false;
    for (const r of this.rings) {
      // quick bbox skip
      let inb = false;
      for (let i = 0; i < r.length; i += 2) { if (Math.abs(r[i] - lon) < 12 && Math.abs(r[i + 1] - lat) < 12) { inb = true; break; } }
      if (!inb) continue;
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }
  private computeSeaLegs() {
    for (let i = 1; i < this.nodes.length; i++) {
      const a = this.nodes[i - 1], b = this.nodes[i];
      let sea = 0, tot = 0;
      for (let t = 0.2; t < 0.81; t += 0.2) { tot++; if (!this.onLand(a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t)) sea++; }
      this.seaLeg[i] = sea >= tot * 0.5;
    }
  }

  private bind() {
    const c = this.canvas;
    const pts = new Map<number, { x: number; y: number }>();
    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 1) { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY; this.downX = e.clientX; this.downY = e.clientY; this.movedX = 0; this.downT = performance.now(); } });
    c.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId); if (!p) return; p.x = e.clientX; p.y = e.clientY;
      if (pts.size >= 2) { // pinch zoom
        const a = [...pts.values()]; const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (this.pinchD) { this.scale *= d / this.pinchD; this.clampCenter(); }
        this.pinchD = d; this.dragging = false; return;
      }
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY; this.lastX = e.clientX; this.lastY = e.clientY;
      this.movedX += Math.abs(dx) + Math.abs(dy);
      this.cLon -= dx / this.scale; this.cyM += dy / this.scale; this.clampCenter();
    });
    const end = (e: PointerEvent) => {
      const wasTap = pts.size === 1 && this.movedX < 8 && performance.now() - this.downT < 400;
      pts.delete(e.pointerId); if (pts.size < 2) this.pinchD = 0; if (pts.size === 0) this.dragging = false;
      if (wasTap) this.hit(this.downX, this.downY);
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => this.resize());
  }
  private hit(sx: number, sy: number) {
    const rect = this.canvas.getBoundingClientRect(); const px = sx - rect.left, py = sy - rect.top;
    let best = -1, bd = 26 * 26;
    for (const c of this.nodes) {
      if (c.id > this.prog.unlocked) continue;
      const d = (this.sx(c.lon) - px) ** 2 + (this.sy(c.lat) - py) ** 2;
      if (d < bd) { bd = d; best = c.id; }
    }
    if (best >= 0) this.onSelect(this.nodes[best]);
  }

  private draw() {
    const ctx = this.ctx, W = this.cssW(), H = this.cssH();
    // sea
    const sea = ctx.createLinearGradient(0, 0, 0, H);
    sea.addColorStop(0, '#a9c6dc'); sea.addColorStop(1, '#8fb2cb');
    ctx.fillStyle = sea; ctx.fillRect(0, 0, W, H);
    // graticule
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
    for (let lon = -15; lon <= 45; lon += 5) { const x = this.sx(lon); if (x > -2 && x < W + 2) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); } }
    for (let lat = 25; lat <= 62; lat += 5) { const y = this.sy(lat); if (y > -2 && y < H + 2) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } }

    // ---- land: parchment relief + rivers, forests, mountains (clipped) ----
    if (this.ready) {
      ctx.lineJoin = 'round';
      const land = new Path2D();
      for (const r of this.rings) {
        let on = false;
        for (let i = 0; i < r.length; i += 2) { const x = this.sx(r[i]), y = this.sy(r[i + 1]); if (x > -40 && x < W + 40 && y > -40 && y < H + 40) { on = true; break; } }
        if (!on) continue;
        for (let i = 0; i < r.length; i += 2) { const x = this.sx(r[i]), y = this.sy(r[i + 1]); if (i === 0) land.moveTo(x, y); else land.lineTo(x, y); }
        land.closePath();
      }
      ctx.fillStyle = '#dcc89e'; ctx.fill(land);
      ctx.save(); ctx.clip(land);
      // latitude wash: cooler green in the north → warm tan in the south
      const g = ctx.createLinearGradient(0, this.sy(60), 0, this.sy(28));
      g.addColorStop(0, 'rgba(150,162,98,0.55)'); g.addColorStop(0.45, 'rgba(206,186,128,0.18)'); g.addColorStop(1, 'rgba(214,182,120,0.6)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      this.drawForests(ctx); this.drawRivers(ctx); this.drawRanges(ctx);
      ctx.restore();
      ctx.strokeStyle = 'rgba(105,80,48,0.85)'; ctx.lineWidth = 1.3; ctx.stroke(land);
      // circa-1200 frontiers
      ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(120,40,40,0.5)'; ctx.lineWidth = 1.6;
      for (const b of BORDERS) { ctx.beginPath(); b.forEach(([lat, lon], i) => { const x = this.sx(lon), y = this.sy(lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
      ctx.setLineDash([]);
    }

    // route
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 1; i < this.nodes.length; i++) {
      const a = this.nodes[i - 1], b = this.nodes[i];
      const ax = this.sx(a.lon), ay = this.sy(a.lat), bx = this.sx(b.lon), by = this.sy(b.lat);
      if ((ax < -40 && bx < -40) || (ax > W + 40 && bx > W + 40)) continue;
      const reached = i <= this.prog.unlocked;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      if (this.seaLeg[i]) { ctx.setLineDash([2, 7]); ctx.strokeStyle = reached ? 'rgba(60,80,110,0.85)' : 'rgba(60,80,110,0.35)'; ctx.lineWidth = 2.5; }
      else { ctx.setLineDash([]); ctx.strokeStyle = reached ? 'rgba(120,70,30,0.9)' : 'rgba(110,80,45,0.3)'; ctx.lineWidth = reached ? 3 : 2; }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // realm labels (period polities)
    for (const [name, lat, lon] of REALMS) {
      const x = this.sx(lon), y = this.sy(lat);
      if (x < -160 || x > W + 160 || y < -20 || y > H + 20) continue;
      ctx.font = `700 ${Math.max(11, Math.min(17, this.scale * 0.7))}px Georgia, serif`; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(70,48,22,0.32)'; ctx.fillText(name, x + 1, y + 1);
      ctx.fillStyle = 'rgba(86,58,26,0.72)'; ctx.fillText(name, x, y);
    }

    // castles
    for (const c of this.nodes) {
      const x = this.sx(c.lon), y = this.sy(c.lat);
      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
      const done = this.prog.completed.includes(c.id), current = c.id === this.prog.unlocked, locked = c.id > this.prog.unlocked;
      this.drawCastle(ctx, x, y, done, current, locked);
      if (!locked || current) { ctx.font = '600 11px Georgia, serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(30,20,10,0.9)'; ctx.fillText(c.name, x, y + 22); }
    }

    // footer
    ctx.font = '700 12px Georgia, serif'; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(20,28,42,0.55)'; ctx.fillRect(8, H - 30, 220, 22);
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText(`${this.prog.completed.length} / ${this.nodes.length} castles taken`, 16, H - 15);
  }

  private drawRivers(ctx: CanvasRenderingContext2D) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const w = Math.max(1, this.scale * 0.1);
    for (const riv of RIVERS) {
      ctx.beginPath();
      riv.forEach(([lat, lon], i) => { const x = this.sx(lon), y = this.sy(lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = '#7fa9c4'; ctx.lineWidth = w + 1.2; ctx.stroke();
      ctx.strokeStyle = '#a9cee0'; ctx.lineWidth = w; ctx.stroke();
    }
  }
  private drawForests(ctx: CanvasRenderingContext2D) {
    for (const [lat, lon, rad] of FORESTS) {
      const cx = this.sx(lon), cy = this.sy(lat), R = rad * this.scale;
      if (cx < -R || cx > this.cssW() + R || cy < -R || cy > this.cssH() + R) continue;
      for (let k = 0; k < 14; k++) {
        const a = frand(lat * 7 + k) * 6.28, d = frand(lon * 5 + k) * R;
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d, s = R * 0.18 + 1.5;
        ctx.fillStyle = 'rgba(58,92,46,0.7)';
        ctx.beginPath(); ctx.moveTo(x, y - s * 1.6); ctx.lineTo(x + s, y + s * 0.6); ctx.lineTo(x - s, y + s * 0.6); ctx.closePath(); ctx.fill();
      }
    }
  }
  private drawRanges(ctx: CanvasRenderingContext2D) {
    const pk = Math.max(5, Math.min(22, this.scale * 0.62));
    for (const ridge of RANGES) {
      // walk the ridge, studding peaks at a roughly even spacing
      for (let s = 0; s < ridge.length - 1; s++) {
        const [la0, lo0] = ridge[s], [la1, lo1] = ridge[s + 1];
        const segDeg = Math.hypot(la1 - la0, lo1 - lo0), steps = Math.max(1, Math.round(segDeg / 0.55));
        for (let t = 0; t < steps; t++) {
          const f = t / steps, lat = la0 + (la1 - la0) * f, lon = lo0 + (lo1 - lo0) * f;
          const x = this.sx(lon), y = this.sy(lat);
          if (x < -30 || x > this.cssW() + 30 || y < -30 || y > this.cssH() + 30) continue;
          const h = pk * (0.8 + frand(lat * 9 + lon) * 0.5), w = h * 0.95;
          ctx.fillStyle = 'rgba(60,45,30,0.22)'; ctx.beginPath(); ctx.ellipse(x + h * 0.18, y + 1, w * 0.7, h * 0.16, 0, 0, 7); ctx.fill(); // shadow
          ctx.fillStyle = '#a99877'; ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x - w, y); ctx.closePath(); ctx.fill(); // lit body
          ctx.fillStyle = 'rgba(70,55,38,0.55)'; ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y); ctx.closePath(); ctx.fill(); // shaded right face
          if (h > pk * 0.95) { ctx.fillStyle = '#f3efe6'; ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w * 0.28, y - h * 0.66); ctx.lineTo(x - w * 0.28, y - h * 0.66); ctx.closePath(); ctx.fill(); } // snow cap
        }
      }
    }
  }

  private drawCastle(ctx: CanvasRenderingContext2D, x: number, y: number, done: boolean, current: boolean, locked: boolean) {
    if (current) { const p = 0.5 + 0.5 * Math.sin(this.pulse); ctx.beginPath(); ctx.arc(x, y, 13 + p * 5, 0, 7); ctx.strokeStyle = `rgba(255,210,74,${0.5 + p * 0.4})`; ctx.lineWidth = 3; ctx.stroke(); }
    ctx.save(); ctx.translate(x, y); const sc = current ? 1.15 : 0.92; ctx.scale(sc, sc);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(0, 7, 9, 3, 0, 0, 7); ctx.fill();
    const wall = locked ? '#9a978f' : done ? '#d9c89c' : '#efe0bb';
    const roof = locked ? '#6f6b63' : done ? '#cf9b3a' : '#c8643f';
    ctx.fillStyle = wall; ctx.fillRect(-8, -4, 16, 10);
    ctx.fillRect(-10, -1, 3, 7); ctx.fillRect(7, -1, 3, 7);
    ctx.fillStyle = roof;
    ctx.beginPath(); ctx.moveTo(-10, -1); ctx.lineTo(-8.5, -6); ctx.lineTo(-7, -1); ctx.fill();
    ctx.beginPath(); ctx.moveTo(7, -1); ctx.lineTo(8.5, -6); ctx.lineTo(10, -1); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-8, -4); ctx.lineTo(0, -11); ctx.lineTo(8, -4); ctx.fill();
    if (done) { ctx.fillStyle = '#3a8f3a'; ctx.font = '12px serif'; ctx.textAlign = 'center'; ctx.fillText('✓', 0, -13); }
    ctx.restore();
  }
}

function frand(n: number) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5; return x - Math.floor(x); }
