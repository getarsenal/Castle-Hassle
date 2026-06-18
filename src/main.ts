import { Sim, Faction, UType, ArmyComp, DEFAULT_COMP, COST, BUDGET, compCost } from './sim';
import { Renderer } from './render';
import * as THREE from 'three';

(window as any).__started = true;

const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const $ = (id: string) => document.getElementById(id)!;

let sim: Sim;
let renderer: Renderer;
let selected = -1;
let showRange = true;

// ---------------- HUD refs ----------------
const cardsEl = $('cards'), attCountEl = $('attCount'), defCountEl = $('defCount'), phaseEl = $('phase');
const hintEl = $('hint'), startbar = $('startbar'), startBtn = $('startbtn'), toolsEl = $('tools');
const banner = $('banner'), bannerTitle = $('bannerTitle'), bannerText = $('bannerText'), restartBtn = $('restartbtn');

// ---------------- Muster screen ----------------
const comp: ArmyComp = { ...DEFAULT_COMP };
const ROSTER = [
  { key: 'heavy', icon: '🛡️', name: 'Heavy Infantry', dsc: 'Tanky, slow — holds the line', step: 20 },
  { key: 'light', icon: '⚔️', name: 'Light Infantry', dsc: 'Fast, fragile — swarms', step: 20 },
  { key: 'archer', icon: '🏹', name: 'Archers', dsc: 'Volleys, limited arrows', step: 20 },
  { key: 'cavalry', icon: '🐎', name: 'Cavalry', dsc: 'Shock charge, weak in a grind', step: 20 },
  { key: 'siege', icon: '🪨', name: 'Trebuchets', dsc: 'Smash walls, few boulders', step: 1 },
] as const;
($('ptsMax')).textContent = String(BUDGET);

function buildMuster() {
  const rows = $('rosterRows'); rows.innerHTML = '';
  for (const r of ROSTER) {
    const row = document.createElement('div'); row.className = 'rrow';
    row.innerHTML = `<div class="ic">${r.icon}</div><div class="info"><div class="nm">${r.name}</div><div class="dsc">${r.dsc} · ${(COST as any)[r.key]}p each</div></div>
      <button class="rbtn minus">−</button><div class="ct" data-k="${r.key}">0</div><button class="rbtn plus">+</button>`;
    const ct = row.querySelector('.ct') as HTMLElement;
    row.querySelector('.minus')!.addEventListener('click', () => { (comp as any)[r.key] = Math.max(0, (comp as any)[r.key] - r.step); ct.textContent = String((comp as any)[r.key]); updateBudget(); });
    row.querySelector('.plus')!.addEventListener('click', () => {
      const next = { ...comp, [r.key]: (comp as any)[r.key] + r.step };
      if (compCost(next) <= BUDGET) { (comp as any)[r.key] += r.step; ct.textContent = String((comp as any)[r.key]); updateBudget(); }
    });
    rows.appendChild(row);
  }
  syncMusterCounts(); updateBudget();
}
function syncMusterCounts() { for (const el of Array.from(document.querySelectorAll('#rosterRows .ct')) as HTMLElement[]) el.textContent = String((comp as any)[el.dataset.k!]); }
function updateBudget() {
  const used = Math.round(compCost(comp));
  $('ptsUsed').textContent = String(used);
  const bar = $('budgetBar'); (bar.firstElementChild as HTMLElement).style.width = `${Math.min(100, used / BUDGET * 100)}%`;
  bar.classList.toggle('over', used > BUDGET);
  ($('musterBtn') as HTMLButtonElement).disabled = used > BUDGET || (comp.heavy + comp.light + comp.archer + comp.cavalry) === 0;
}
$('musterBtn').addEventListener('click', () => { $('muster').classList.remove('show'); newGame(); });

// ---------------- New game ----------------
function newGame() {
  if (renderer) { renderer.gl.dispose(); app.innerHTML = ''; }
  sim = new Sim(Date.now() & 0xffff, { ...comp });
  renderer = new Renderer(sim, app);
  bindInput();
  selected = -1; showRange = true;
  banner.classList.remove('show'); startbar.style.display = 'block';
  buildCards(); updateHint(); updateTools();
}

// ---------------- Cards ----------------
function buildCards() {
  cardsEl.innerHTML = '';
  for (const u of sim.playerUnits()) {
    const card = document.createElement('div'); card.className = 'card'; card.dataset.id = String(u.id);
    const ranged = u.type === UType.Archer || u.type === UType.Siege;
    card.innerHTML = `<div class="name">${u.name}</div><div class="count">${u.alive}</div><div class="bar"><i></i></div>${ranged ? '<div class="ammo"><i></i></div>' : ''}`;
    card.addEventListener('click', () => { selected = selected === u.id ? -1 : u.id; refreshCards(); updateHint(); updateTools(); });
    cardsEl.appendChild(card);
  }
}
function refreshCards() {
  for (const card of Array.from(cardsEl.children) as HTMLElement[]) {
    const u = sim.units[Number(card.dataset.id)]; if (!u) continue;
    card.classList.toggle('sel', selected === u.id); card.classList.toggle('routing', u.routing);
    (card.querySelector('.count') as HTMLElement).textContent = String(u.alive);
    const frac = u.alive / u.count, bar = card.querySelector('.bar > i') as HTMLElement;
    bar.style.width = `${Math.round(frac * 100)}%`;
    bar.style.background = frac > 0.5 ? '#5fd16a' : frac > 0.25 ? '#e8c54a' : '#e8513a';
    const am = card.querySelector('.ammo > i') as HTMLElement | null;
    if (am) am.style.width = `${u.ammoMax ? Math.round(u.ammo / u.ammoMax * 100) : 0}%`;
  }
}
function updateTopbar() {
  attCountEl.textContent = String(sim.countAlive(Faction.Attacker));
  defCountEl.textContent = String(sim.countAlive(Faction.Defender));
  phaseEl.textContent = sim.phase === 'deploy' ? 'DEPLOY' : sim.phase === 'battle' ? 'BATTLE' : 'OVER';
}
function updateHint() {
  const u = selected >= 0 ? sim.units[selected] : null;
  if (u && u.type === UType.Siege) hintEl.textContent = 'Trebuchets: TAP A WALL to aim · drag to reposition the battery';
  else if (u && u.type === UType.Archer) hintEl.textContent = 'Archers: TAP to set a focus target · drag to reposition';
  else if (u) hintEl.textContent = 'Tap to send · DRAG to set their line & facing · two fingers = camera';
  else if (sim.phase === 'deploy') hintEl.textContent = 'DEPLOY: position your units, then ⚔ Begin Assault (top). One finger rotates.';
  else hintEl.textContent = 'Tap a unit to select · trebuchets breach walls, then send troops in';
}
function updateTools() {
  const u = selected >= 0 ? sim.units[selected] : null;
  const ranged = u && (u.type === UType.Archer || u.type === UType.Siege);
  toolsEl.innerHTML = '';
  if (!ranged) { toolsEl.classList.remove('show'); return; }
  toolsEl.classList.add('show');
  const rb = document.createElement('button'); rb.className = 'tool' + (showRange ? ' on' : ''); rb.textContent = '◎ Range';
  rb.addEventListener('click', () => { showRange = !showRange; updateTools(); });
  toolsEl.appendChild(rb);
  if (u!.type === UType.Archer && u!.hasFocus) {
    const cb = document.createElement('button'); cb.className = 'tool'; cb.textContent = '✕ Clear Aim';
    cb.addEventListener('click', () => { sim.clearFocus(u!.id); updateTools(); });
    toolsEl.appendChild(cb);
  }
}

startBtn.addEventListener('click', () => { sim.begin(); startbar.style.display = 'none'; updateHint(); });
restartBtn.addEventListener('click', () => { banner.classList.remove('show'); buildMuster(); $('muster').classList.add('show'); });

function showEnd() {
  const win = sim.winner === Faction.Attacker;
  bannerTitle.textContent = win ? 'CASTLE TAKEN' : 'ASSAULT BROKEN';
  bannerTitle.style.color = win ? '#5fd16a' : '#e8513a';
  bannerText.textContent = win ? (sim.countAlive(Faction.Defender) < 30 ? 'A clean sweep — the castle is yours.' : 'You hold the walls; survivors slipped away.') : 'Your army broke before the keep fell.';
  banner.classList.add('show');
}

// ---------------- Input ----------------
const pointers = new Map<number, { x: number; y: number }>();
let gesture: 'none' | 'orbit' | 'command' | 'camera' = 'none';
let downAt = { x: 0, y: 0, t: 0 }; let moved = false;
let cmdP0: THREE.Vector3 | null = null, cmdP1: THREE.Vector3 | null = null;
let pinchDist = 0, panMid = { x: 0, y: 0 };

const ndc = (cx: number, cy: number): [number, number] => [(cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1];
function groundAt(cx: number, cy: number) { const [a, b] = ndc(cx, cy); return renderer.raycastGround(a, b); }
function lineFacing(p0: THREE.Vector3, p1: THREE.Vector3): [number, number] {
  const dx = p1.x - p0.x, dz = p1.z - p0.z, w = Math.hypot(dx, dz) || 1; let fx = -dz / w, fz = dx / w;
  const mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2; if (fx * (0 - mx) + fz * (0 - mz) < 0) { fx = -fx; fz = -fz; } return [fx, fz];
}

function bindInput() {
  // Bind to the CURRENT canvas. newGame() replaces the canvas each time, so the
  // listeners must attach to the new element (the old one is discarded with it).
  pointers.clear(); gesture = 'none';
  const el = renderer.gl.domElement;
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const p = [...pointers.values()]; pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); panMid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; gesture = 'camera'; cmdP0 = null; renderer.setPreview(null); return; }
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; moved = false;
    if (selected >= 0 && sim.phase !== 'over') { gesture = 'command'; cmdP0 = groundAt(e.clientX, e.clientY); } else gesture = 'orbit';
  });
  el.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId); if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y; pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture === 'camera' && pointers.size >= 2) {
      const p = [...pointers.values()]; const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (pinchDist > 0) renderer.camDist *= pinchDist / dist; pinchDist = dist;
      const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; const mdx = mid.x - panMid.x, mdy = mid.y - panMid.y; panMid = mid;
      const s = renderer.camDist * 0.0018, cy = Math.cos(renderer.camYaw), sy = Math.sin(renderer.camYaw);
      renderer.camTarget.x -= (mdx * cy + mdy * sy) * s; renderer.camTarget.z -= (-mdx * sy + mdy * cy) * s; renderer.clampTarget(); return;
    }
    if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 8) moved = true;
    if (gesture === 'orbit') { renderer.camYaw -= dx * 0.005; renderer.camPitch += dy * 0.005; renderer.clampTarget(); }
    else if (gesture === 'command' && moved) {
      cmdP1 = groundAt(e.clientX, e.clientY);
      if (cmdP0 && cmdP1 && selected >= 0) { const [fx, fz] = lineFacing(cmdP0, cmdP1); renderer.setPreview(cmdP0, cmdP1, fx, fz); }
    }
  });
  const endPointer = (e: PointerEvent) => {
    const wasTap = !moved && gesture !== 'camera' && (performance.now() - downAt.t) < 350 && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (gesture === 'command' && moved && cmdP0 && cmdP1 && selected >= 0) sim.orderFormation(selected, cmdP0.x, cmdP0.z, cmdP1.x, cmdP1.z);
    else if (wasTap) handleTap(e.clientX, e.clientY);
    renderer.setPreview(null);
    if (pointers.size === 0) { gesture = 'none'; cmdP0 = cmdP1 = null; }
    else if (pointers.size === 1) { pinchDist = 0; gesture = selected >= 0 ? 'command' : 'orbit'; }
  };
  el.addEventListener('pointerup', endPointer); el.addEventListener('pointercancel', endPointer);
  el.addEventListener('wheel', (e) => { renderer.camDist *= 1 + Math.sign(e.deltaY) * 0.12; renderer.clampTarget(); }, { passive: true });
}

function handleTap(cx: number, cy: number) {
  const p = groundAt(cx, cy); if (!p) return;
  let best = -1, bd = 11;
  for (const u of sim.playerUnits()) { if (u.alive <= 0) continue; const d = Math.hypot(u.cx - p.x, u.cz - p.z); if (d < bd) { bd = d; best = u.id; } }
  if (best >= 0) { selected = best; refreshCards(); updateHint(); updateTools(); return; }
  if (selected >= 0 && sim.phase !== 'over') {
    const u = sim.units[selected];
    if (u.type === UType.Siege) { const seg = sim.wallSegAt(p.x, p.z); if (seg >= 0) { sim.setSiegeTarget(selected, seg); return; } sim.orderMove(selected, p.x, p.z); }
    else if (u.type === UType.Archer) { sim.setFocus(selected, p.x, p.z); updateTools(); }
    else sim.orderMove(selected, p.x, p.z);
  }
}

// ---------------- Loop ----------------
buildMuster(); $('muster').classList.add('show');
newGame(); // backdrop sim while mustering
loading.remove();
(window as any).__running = true;

// perf readout (fps / ms / unit count) for on-device testing; tap to hide
const perfEl = document.getElementById('perf');
perfEl?.addEventListener('click', () => perfEl.classList.add('hidden'));
let perfAcc = 0, perfFrames = 0, adaptCooldown = 0;

const SIM_DT = 1 / 30; let acc = 0, last = performance.now(), ended = false;
function frame(now: number) {
  let dt = (now - last) / 1000; last = now; if (dt > 0.1) dt = 0.1;
  acc += dt; while (acc >= SIM_DT) { sim.step(SIM_DT); acc -= SIM_DT; }

  perfAcc += dt; perfFrames++;
  if (perfAcc >= 0.5) {
    const fps = perfFrames / perfAcc;
    const q = renderer.quality;
    if (perfEl) perfEl.textContent = `${fps.toFixed(0)} fps · ${(1000 / fps).toFixed(1)} ms · ${sim.n} units · ${Math.round(q * 100)}%`;
    // adaptive resolution: ease down when struggling, back up when there's room
    if (adaptCooldown > 0) adaptCooldown--;
    else if (fps < 26 && q > 0.6) { renderer.setQuality(q - 0.1); adaptCooldown = 3; }
    else if (fps > 54 && q < 1) { renderer.setQuality(q + 0.1); adaptCooldown = 3; }
    perfAcc = 0; perfFrames = 0;
  }

  const u = selected >= 0 ? sim.units[selected] : null;
  if (u && u.alive > 0) renderer.setSelection(u.cx, u.cz); else renderer.setSelection(null, null);
  // aim marker + range fan for the selected ranged unit
  if (u && u.type === UType.Siege && u.siegeTargetSeg >= 0) { const [tx, tz] = sim.segCenter(u.siegeTargetSeg); renderer.setTargetMarker(tx, tz); }
  else if (u && u.type === UType.Archer && u.hasFocus) renderer.setTargetMarker(u.focusX, u.focusZ);
  else renderer.setTargetMarker(null, null);
  if (u && u.alive > 0 && (u.type === UType.Archer || u.type === UType.Siege) && showRange) renderer.setRangeFan(u.cx, u.cz, sim.unitRange(u.id));
  else renderer.setRangeFan(null, null);

  renderer.render(Math.min(dt, 0.05));
  refreshCards(); updateTopbar();
  if (sim.phase === 'over' && !ended) { ended = true; showEnd(); }
  if (sim.phase !== 'over') ended = false;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
