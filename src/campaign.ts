// Campaign layer: ~100 castles from England across Europe to the Middle East,
// laid out on a stylised, pannable journey map. Progress is saved locally.

export interface CampaignCastle {
  id: number; name: string; region: string;
  x: number; y: number;        // map-space position (px)
  seed: number; tier: number;  // tier 0..1 → difficulty
}

const REGIONS: { name: string; count: number; green: number; names: string[] }[] = [
  { name: 'England', count: 18, green: 1.0, names: ['Dover', 'Windsor', 'Warwick', 'York', 'Leeds', 'Bamburgh', 'Corfe', 'Arundel', 'Kenilworth', 'Ludlow', 'Alnwick', 'Pembroke', 'Conwy', 'Caernarfon', 'Harlech', 'Rochester', 'Tintagel', 'Carlisle'] },
  { name: 'France', count: 22, green: 0.85, names: ['Calais', 'Rouen', 'Caen', 'Chinon', 'Angers', 'Carcassonne', 'Loches', 'Amboise', 'Saumur', 'Provins', 'Coucy', 'Najac', 'Foix', 'Beynac', 'Bonaguil', 'Vincennes', 'Falaise', 'Gisors', 'Tarascon', 'Avignon', 'Montsegur', 'Pierrefonds'] },
  { name: 'The Empire', count: 20, green: 0.7, names: ['Aachen', 'Köln', 'Trier', 'Marburg', 'Eltz', 'Heidelberg', 'Nürnberg', 'Würzburg', 'Wartburg', 'Hohenzollern', 'Lichtenstein', 'Cochem', 'Rheinstein', 'Marksburg', 'Pfalz', 'Munot', 'Gravensteen', 'Bouillon', 'Vianden', 'Salzburg'] },
  { name: 'Italy', count: 16, green: 0.6, names: ['Milano', 'Verona', 'Ferrara', 'Sirmione', 'Fenis', 'Soave', 'Torrechiara', 'Gradara', 'Rocca', 'Caldora', 'Lagopesole', 'Melfi', 'Bari', 'Trani', 'Otranto', 'Siracusa'] },
  { name: 'Byzantium', count: 12, green: 0.45, names: ['Ragusa', 'Klis', 'Smederevo', 'Belgrade', 'Golubac', 'Tarnovo', 'Ohrid', 'Thessaly', 'Mystras', 'Monemvasia', 'Rumeli', 'Constantinople'] },
  { name: 'The Holy Land', count: 12, green: 0.18, names: ['Nicaea', 'Antioch', 'Aleppo', 'Krak', 'Margat', 'Saladin', 'Tortosa', 'Acre', 'Montfort', 'Kerak', 'Ajloun', 'Jerusalem'] },
];

const NODE_DX = 150, AMP = 150, MARGIN = 260, TOP = 0.42;

export function generateCastles(): CampaignCastle[] {
  const out: CampaignCastle[] = [];
  let i = 0;
  const total = REGIONS.reduce((s, r) => s + r.count, 0);
  for (const r of REGIONS) {
    for (let k = 0; k < r.count; k++) {
      const x = MARGIN + i * NODE_DX;
      const phase = i * 0.7;
      const y = Math.sin(phase) * AMP + Math.sin(phase * 0.37) * AMP * 0.5;
      out.push({ id: i, name: r.names[k % r.names.length], region: r.name, x, y, seed: 1000 + i * 7919, tier: total > 1 ? i / (total - 1) : 0 });
      i++;
    }
  }
  return out;
}

export interface Progress { unlocked: number; completed: number[]; }
const KEY = 'castlehassle.campaign.v1';
export function loadProgress(): Progress {
  try { const p = JSON.parse(localStorage.getItem(KEY) || ''); if (p && typeof p.unlocked === 'number') return { unlocked: p.unlocked, completed: p.completed || [] }; } catch { /* ignore */ }
  return { unlocked: 0, completed: [] };
}
export function saveProgress(p: Progress) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }

// ---------------------------------------------------------------------------
// The map: a stylised parchment journey drawn on a canvas, panned horizontally.
// ---------------------------------------------------------------------------
export class CampaignMap {
  private ctx: CanvasRenderingContext2D;
  private camX = 0;
  private dragging = false; private lastX = 0; private movedX = 0; private downX = 0; private downT = 0;
  private mapW: number;
  private raf = 0; private pulse = 0;
  constructor(private canvas: HTMLCanvasElement, private nodes: CampaignCastle[], private prog: Progress, private onSelect: (c: CampaignCastle) => void) {
    this.ctx = canvas.getContext('2d')!;
    this.mapW = nodes[nodes.length - 1].x + MARGIN;
    this.resize();
    // open centred on the current objective
    const cur = nodes[Math.min(prog.unlocked, nodes.length - 1)];
    this.camX = this.clampCam(cur.x - this.cssW() / 2);
    this.bind();
    const loop = () => { this.pulse += 0.05; this.draw(); this.raf = requestAnimationFrame(loop); };
    loop();
  }
  destroy() { cancelAnimationFrame(this.raf); this.canvas.replaceWith(this.canvas.cloneNode(false)); }
  private cssW() { return this.canvas.clientWidth; }
  private cssH() { return this.canvas.clientHeight; }
  private clampCam(x: number) { return Math.max(0, Math.min(this.mapW - this.cssW(), x)); }
  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = this.canvas.clientWidth * dpr; this.canvas.height = this.canvas.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  private nodeScreen(c: CampaignCastle) { return { x: c.x - this.camX, y: this.cssH() * TOP + c.y + this.cssH() * 0.18 }; }

  private bind() {
    const c = this.canvas;
    const down = (x: number) => { this.dragging = true; this.lastX = x; this.downX = x; this.movedX = 0; this.downT = performance.now(); };
    const move = (x: number) => { if (!this.dragging) return; const dx = x - this.lastX; this.lastX = x; this.movedX += Math.abs(dx); this.camX = this.clampCam(this.camX - dx); };
    const up = (x: number, y: number) => {
      const wasTap = this.movedX < 8 && performance.now() - this.downT < 400;
      this.dragging = false;
      if (wasTap) this.hit(x, y);
    };
    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); down(e.clientX); });
    c.addEventListener('pointermove', e => move(e.clientX));
    c.addEventListener('pointerup', e => up(e.clientX, e.clientY));
    window.addEventListener('resize', () => this.resize());
  }
  private hit(sx: number, sy: number) {
    const rect = this.canvas.getBoundingClientRect();
    const px = sx - rect.left, py = sy - rect.top;
    for (const c of this.nodes) {
      if (c.id > this.prog.unlocked) continue;
      const s = this.nodeScreen(c);
      if ((s.x - px) ** 2 + (s.y - py) ** 2 < 30 * 30) { this.onSelect(c); return; }
    }
  }

  private regionShade(t: number) { // green (lush) -> arid tan as t goes 0..1
    const a = [110, 150, 78], b = [196, 170, 110];
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
  }

  private draw() {
    const ctx = this.ctx, W = this.cssW(), H = this.cssH();
    // sky/sea backdrop
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#bcd6ec'); sky.addColorStop(0.5, '#cfe3f2'); sky.addColorStop(1, '#aac4d8');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    // land band, tinted by region progress across the world
    const landTop = H * 0.16, landBot = H * 0.99;
    const tL = this.camX / this.mapW, tR = (this.camX + W) / this.mapW;
    const land = ctx.createLinearGradient(0, 0, W, 0);
    land.addColorStop(0, this.regionShade(tL)); land.addColorStop(1, this.regionShade(tR));
    ctx.fillStyle = land;
    ctx.beginPath();
    ctx.moveTo(0, landTop + 24);
    for (let x = 0; x <= W; x += 24) { const wx = x + this.camX; ctx.lineTo(x, landTop + Math.sin(wx * 0.01) * 16 + Math.sin(wx * 0.027) * 8); }
    ctx.lineTo(W, landBot); ctx.lineTo(0, landBot); ctx.closePath(); ctx.fill();
    // coast line
    ctx.strokeStyle = 'rgba(70,90,60,0.5)'; ctx.lineWidth = 3; ctx.stroke();

    // scattered decorative terrain (deterministic per world cell)
    this.decor(ctx, W, H, landTop);

    // the journey road
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = 0; i < this.nodes.length; i++) { const s = this.nodeScreen(this.nodes[i]); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); }
      if (pass === 0) { ctx.strokeStyle = 'rgba(60,45,25,0.28)'; ctx.lineWidth = 16; }
      else { ctx.strokeStyle = '#caa978'; ctx.lineWidth = 9; ctx.setLineDash([2, 0]); }
      ctx.stroke();
    }
    // dashed "unknown road" beyond the furthest unlocked
    ctx.setLineDash([4, 12]); ctx.strokeStyle = 'rgba(80,60,35,0.4)'; ctx.lineWidth = 5;
    ctx.beginPath();
    for (let i = this.prog.unlocked; i < this.nodes.length; i++) { const s = this.nodeScreen(this.nodes[i]); if (i === this.prog.unlocked) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); }
    ctx.stroke(); ctx.setLineDash([]);

    // region banners
    let idx = 0;
    for (const r of REGIONS) {
      const mid = this.nodes[Math.min(idx + Math.floor(r.count / 2), this.nodes.length - 1)];
      const s = this.nodeScreen(mid);
      if (s.x > -200 && s.x < W + 200) {
        ctx.font = '700 22px Georgia, serif'; ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(40,28,14,0.5)'; ctx.fillText(r.name.toUpperCase(), s.x, H * 0.12 + 1);
        ctx.fillStyle = 'rgba(255,244,222,0.92)'; ctx.fillText(r.name.toUpperCase(), s.x, H * 0.12);
      }
      idx += r.count;
    }

    // castle nodes
    for (const c of this.nodes) {
      const s = this.nodeScreen(c);
      if (s.x < -60 || s.x > W + 60) continue;
      const done = this.prog.completed.includes(c.id);
      const current = c.id === this.prog.unlocked;
      const locked = c.id > this.prog.unlocked;
      this.drawCastle(ctx, s.x, s.y, done, current, locked);
      if (!locked) {
        ctx.font = '600 12px Georgia, serif'; ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(30,20,10,0.85)'; ctx.fillText(c.name, s.x, s.y + 34);
      }
    }

    // title strip
    ctx.fillStyle = 'rgba(20,28,42,0.0)';
    ctx.font = '700 13px Georgia, serif'; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(`Conquest  ·  ${this.prog.completed.length} / ${this.nodes.length} castles taken`, 14, H - 16);
  }

  private decor(ctx: CanvasRenderingContext2D, W: number, H: number, landTop: number) {
    const cell = 70;
    const start = Math.floor(this.camX / cell) - 1, end = Math.ceil((this.camX + W) / cell) + 1;
    for (let gx = start; gx < end; gx++) {
      const wx = gx * cell; const r = frand(gx * 2.13);
      if (r > 0.55) continue;
      const t = wx / this.mapW;
      const y = landTop + 40 + frand(gx * 5.7) * (H * 0.7);
      const x = wx - this.camX + (frand(gx * 9.1) - 0.5) * cell;
      if (y < landTop + 30) continue;
      if (t < 0.55) this.tree(ctx, x, y, t); else this.dune(ctx, x, y, frand(gx * 3.3) > 0.6);
    }
  }
  private tree(ctx: CanvasRenderingContext2D, x: number, y: number, t: number) {
    ctx.fillStyle = 'rgba(60,45,25,0.5)'; ctx.fillRect(x - 1.2, y, 2.4, 7);
    const g = 1 - t * 0.5;
    ctx.fillStyle = `rgb(${Math.round(70 * g + 60)},${Math.round(120 * g + 40)},${Math.round(50 * g + 20)})`;
    ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x + 6, y + 1); ctx.lineTo(x - 6, y + 1); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, y - 18); ctx.lineTo(x + 5, y - 6); ctx.lineTo(x - 5, y - 6); ctx.closePath(); ctx.fill();
  }
  private dune(ctx: CanvasRenderingContext2D, x: number, y: number, palm: boolean) {
    if (palm) {
      ctx.strokeStyle = '#6b4f2c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 2, y - 10); ctx.stroke();
      ctx.strokeStyle = '#4e7a3a'; ctx.lineWidth = 2;
      for (const a of [-1.1, -0.4, 0.3, 1.0]) { ctx.beginPath(); ctx.moveTo(x - 2, y - 10); ctx.lineTo(x - 2 + Math.cos(a) * 8, y - 10 - Math.sin(a) * 5); ctx.stroke(); }
    } else {
      ctx.fillStyle = 'rgba(180,150,95,0.7)'; ctx.beginPath(); ctx.ellipse(x, y, 9, 3.5, 0, 0, Math.PI, true); ctx.fill();
    }
  }

  private drawCastle(ctx: CanvasRenderingContext2D, x: number, y: number, done: boolean, current: boolean, locked: boolean) {
    if (current) { // pulsing objective ring
      const p = 0.5 + 0.5 * Math.sin(this.pulse);
      ctx.beginPath(); ctx.arc(x, y, 18 + p * 5, 0, 7); ctx.strokeStyle = `rgba(255,210,74,${0.5 + p * 0.4})`; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.save(); ctx.translate(x, y);
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(0, 10, 13, 4, 0, 0, 7); ctx.fill();
    const wall = locked ? '#8d8a82' : done ? '#d9c89c' : '#e6d6af';
    const roof = locked ? '#6f6b63' : done ? '#cf9b3a' : '#c8643f';
    ctx.fillStyle = wall;
    ctx.fillRect(-11, -6, 22, 14);               // keep body
    ctx.fillRect(-13, -2, 4, 10); ctx.fillRect(9, -2, 4, 10); // side towers
    ctx.fillStyle = roof;                         // roofs
    ctx.beginPath(); ctx.moveTo(-13, -2); ctx.lineTo(-11, -9); ctx.lineTo(-9, -2); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(9, -2); ctx.lineTo(11, -9); ctx.lineTo(13, -2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = roof; ctx.beginPath(); ctx.moveTo(-11, -6); ctx.lineTo(0, -15); ctx.lineTo(11, -6); ctx.closePath(); ctx.fill();
    // crenellations
    ctx.fillStyle = wall; for (let i = -10; i < 10; i += 5) ctx.fillRect(i, -8, 3, 3);
    if (done) { ctx.fillStyle = '#5fd16a'; ctx.font = '14px serif'; ctx.textAlign = 'center'; ctx.fillText('✓', 0, -18); }
    if (locked) { ctx.fillStyle = 'rgba(40,40,40,0.6)'; ctx.font = '11px serif'; ctx.textAlign = 'center'; ctx.fillText('🔒', 0, -16); }
    ctx.restore();
  }
}

function frand(n: number) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5; return x - Math.floor(x); }
