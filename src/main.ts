import { Sim, Faction } from './sim';
import { Renderer } from './render';
import * as THREE from 'three';

// Tell the startup watchdog (inline script in index.html) the module is running.
(window as any).__started = true;

const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;

let sim = new Sim(Date.now() & 0xffff);
let renderer = new Renderer(sim, app);

// ---------------- HUD ----------------
const cardsEl = document.getElementById('cards')!;
const attCountEl = document.getElementById('attCount')!;
const defCountEl = document.getElementById('defCount')!;
const phaseEl = document.getElementById('phase')!;
const hintEl = document.getElementById('hint')!;
const startOverlay = document.getElementById('startoverlay')!;
const startBtn = document.getElementById('startbtn')!;
const banner = document.getElementById('banner')!;
const bannerTitle = document.getElementById('bannerTitle')!;
const bannerText = document.getElementById('bannerText')!;
const restartBtn = document.getElementById('restartbtn')!;

let selected = -1; // unit id, or -1 none

function buildCards() {
  cardsEl.innerHTML = '';
  for (const u of sim.playerUnits()) {
    const card = document.createElement('div');
    card.className = 'card'; card.dataset.id = String(u.id);
    card.innerHTML = `<div class="name">${u.name}</div><div class="count">${u.alive}</div><div class="bar"><i></i></div>`;
    card.addEventListener('click', () => { selected = selected === u.id ? -1 : u.id; refreshCards(); updateHint(); });
    cardsEl.appendChild(card);
  }
}

function refreshCards() {
  for (const card of Array.from(cardsEl.children) as HTMLElement[]) {
    const u = sim.units[Number(card.dataset.id)];
    if (!u) continue;
    card.classList.toggle('sel', selected === u.id);
    card.classList.toggle('routing', u.routing);
    (card.querySelector('.count') as HTMLElement).textContent = String(u.alive);
    const frac = u.alive / u.count;
    const bar = card.querySelector('.bar > i') as HTMLElement;
    bar.style.width = `${Math.round(frac * 100)}%`;
    bar.style.background = frac > 0.5 ? '#5fd16a' : frac > 0.25 ? '#e8c54a' : '#e8513a';
  }
}

function updateTopbar() {
  attCountEl.textContent = String(sim.countAlive(Faction.Attacker));
  defCountEl.textContent = String(sim.countAlive(Faction.Defender));
  phaseEl.textContent = sim.phase === 'deploy' ? 'DEPLOY' : sim.phase === 'battle' ? 'BATTLE' : 'OVER';
}

function updateHint() {
  if (sim.phase === 'deploy') { hintEl.textContent = 'Position your army, then ⚔ Begin Assault. One finger rotates the camera.'; return; }
  hintEl.textContent = selected >= 0
    ? 'Tap to send · DRAG to set their line & facing · two fingers to move camera'
    : 'Tap a unit (or its card) to select · one finger rotates · two fingers pan/zoom';
}

startBtn.addEventListener('click', () => { sim.begin(); startOverlay.classList.add('hidden'); updateHint(); });

restartBtn.addEventListener('click', () => {
  banner.classList.remove('show');
  sim = new Sim(Date.now() & 0xffff);
  renderer.gl.dispose(); app.innerHTML = '';
  renderer = new Renderer(sim, app);
  selected = -1; startOverlay.classList.remove('hidden');
  buildCards(); updateHint();
});

function showEnd() {
  const win = sim.winner === Faction.Attacker;
  bannerTitle.textContent = win ? 'CASTLE TAKEN' : 'ASSAULT BROKEN';
  bannerTitle.style.color = win ? '#5fd16a' : '#e8513a';
  const def = sim.countAlive(Faction.Defender);
  bannerText.textContent = win
    ? (def < 30 ? 'A clean sweep — the castle is fully yours.' : 'You hold the walls, but survivors slipped away. They may regroup…')
    : 'Your army broke before the keep fell. Regroup and try again.';
  banner.classList.add('show');
}

// ---------------- Input ----------------
const el = renderer.gl.domElement;
type PInfo = { x: number; y: number };
const pointers = new Map<number, PInfo>();
let gesture: 'none' | 'orbit' | 'command' | 'camera' = 'none';
let downAt = { x: 0, y: 0, t: 0 };
let moved = false;
let cmdP0: THREE.Vector3 | null = null;
let cmdP1: THREE.Vector3 | null = null;
let pinchDist = 0;
let panMid = { x: 0, y: 0 };

const ndc = (cx: number, cy: number): [number, number] =>
  [(cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1];

function groundAt(cx: number, cy: number) { const [a, b] = ndc(cx, cy); return renderer.raycastGround(a, b); }

// facing vector for a formation line P0->P1 (perpendicular, toward the castle)
function lineFacing(p0: THREE.Vector3, p1: THREE.Vector3): [number, number] {
  const dx = p1.x - p0.x, dz = p1.z - p0.z, w = Math.hypot(dx, dz) || 1;
  let fx = -dz / w, fz = dx / w;
  const mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2;
  if (fx * (0 - mx) + fz * (0 - mz) < 0) { fx = -fx; fz = -fz; }
  return [fx, fz];
}

el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const p = [...pointers.values()];
    pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    panMid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
    gesture = 'camera'; cmdP0 = null; renderer.setPreview(null);
    return;
  }
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; moved = false;
  if (selected >= 0 && sim.phase !== 'over') { gesture = 'command'; cmdP0 = groundAt(e.clientX, e.clientY); }
  else gesture = 'orbit';
});

el.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId); if (!prev) return;
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (gesture === 'camera' && pointers.size >= 2) {
    const p = [...pointers.values()];
    const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    if (pinchDist > 0) renderer.camDist *= pinchDist / dist;
    pinchDist = dist;
    const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
    const mdx = mid.x - panMid.x, mdy = mid.y - panMid.y; panMid = mid;
    const s = renderer.camDist * 0.0018;
    const cy = Math.cos(renderer.camYaw), sy = Math.sin(renderer.camYaw);
    renderer.camTarget.x -= (mdx * cy + mdy * sy) * s;
    renderer.camTarget.z -= (-mdx * sy + mdy * cy) * s;
    renderer.clampTarget();
    return;
  }
  if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 8) moved = true;

  if (gesture === 'orbit') {
    renderer.camYaw -= dx * 0.005;
    renderer.camPitch += dy * 0.005;
    renderer.clampTarget();
  } else if (gesture === 'command' && moved) {
    cmdP1 = groundAt(e.clientX, e.clientY);
    if (cmdP0 && cmdP1 && selected >= 0) {
      const [fx, fz] = lineFacing(cmdP0, cmdP1);
      renderer.setPreview(cmdP0, cmdP1, fx, fz);
    }
  }
});

function endPointer(e: PointerEvent) {
  const wasTap = !moved && gesture !== 'camera' && (performance.now() - downAt.t) < 350 && pointers.size === 1;
  pointers.delete(e.pointerId);

  if (gesture === 'command' && moved && cmdP0 && cmdP1 && selected >= 0) {
    sim.orderFormation(selected, cmdP0.x, cmdP0.z, cmdP1.x, cmdP1.z);
  } else if (wasTap) {
    handleTap(e.clientX, e.clientY);
  }
  renderer.setPreview(null);
  if (pointers.size === 0) { gesture = 'none'; cmdP0 = cmdP1 = null; }
  else if (pointers.size === 1) { pinchDist = 0; gesture = selected >= 0 ? 'command' : 'orbit'; }
}
el.addEventListener('pointerup', endPointer);
el.addEventListener('pointercancel', endPointer);
el.addEventListener('wheel', (e) => { renderer.camDist *= 1 + Math.sign(e.deltaY) * 0.12; renderer.clampTarget(); }, { passive: true });

function handleTap(cx: number, cy: number) {
  const p = groundAt(cx, cy); if (!p) return;
  // select the nearest friendly unit if the tap is on/near it
  let best = -1, bd = 11;
  for (const u of sim.playerUnits()) {
    if (u.alive <= 0) continue;
    const d = Math.hypot(u.cx - p.x, u.cz - p.z);
    if (d < bd) { bd = d; best = u.id; }
  }
  if (best >= 0) { selected = best; refreshCards(); updateHint(); return; }
  if (selected >= 0 && sim.phase !== 'over') sim.orderMove(selected, p.x, p.z);
}

// ---------------- Loop ----------------
buildCards(); updateHint();
(window as any).__running = true;
loading.remove();

const SIM_DT = 1 / 30;
let acc = 0, last = performance.now(), ended = false;

function frame(now: number) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;
  acc += dt;
  while (acc >= SIM_DT) { sim.step(SIM_DT); acc -= SIM_DT; }

  if (selected >= 0) { const u = sim.units[selected]; renderer.setSelection(u && u.alive > 0 ? u.cx : null, u && u.alive > 0 ? u.cz : null); }
  else renderer.setSelection(null, null);

  renderer.render();
  refreshCards(); updateTopbar();

  if (sim.phase === 'over' && !ended) { ended = true; showEnd(); }
  if (sim.phase !== 'over') ended = false;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
