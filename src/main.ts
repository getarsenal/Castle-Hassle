import { Sim, Faction, maxHp } from './sim';
import { Renderer } from './render';

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

let selected = -1; // unit id, or -2 for ALL, -1 none

function buildCards() {
  cardsEl.innerHTML = '';
  const units = sim.playerUnits();
  for (const u of units) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = String(u.id);
    card.innerHTML = `<div class="name">${u.name}</div><div class="count">${u.alive}</div><div class="bar"><i></i></div>`;
    card.addEventListener('click', () => { selected = u.id; refreshCards(); });
    cardsEl.appendChild(card);
  }
  const all = document.createElement('div');
  all.className = 'card'; all.dataset.id = 'all';
  all.innerHTML = `<div class="name">ALL</div><div class="count">⚔</div><div class="bar" style="opacity:0"><i></i></div>`;
  all.addEventListener('click', () => { selected = -2; refreshCards(); });
  cardsEl.appendChild(all);
}

function refreshCards() {
  const units = sim.playerUnits();
  for (const card of Array.from(cardsEl.children) as HTMLElement[]) {
    const id = card.dataset.id;
    if (id === 'all') { card.classList.toggle('sel', selected === -2); continue; }
    const u = units.find(x => x.id === Number(id))!;
    card.classList.toggle('sel', selected === u.id);
    card.classList.toggle('routing', u.routing);
    (card.querySelector('.count') as HTMLElement).textContent = String(u.alive);
    const frac = u.alive / u.count;
    (card.querySelector('.bar > i') as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
    (card.querySelector('.bar > i') as HTMLElement).style.background = frac > 0.5 ? '#5fd16a' : frac > 0.25 ? '#e8c54a' : '#e8513a';
  }
}

function updateTopbar() {
  attCountEl.textContent = String(sim.countAlive(Faction.Attacker));
  defCountEl.textContent = String(sim.countAlive(Faction.Defender));
  phaseEl.textContent = sim.phase === 'deploy' ? 'DEPLOY' : sim.phase === 'battle' ? 'BATTLE' : 'OVER';
}

startBtn.addEventListener('click', () => {
  sim.begin();
  startOverlay.classList.add('hidden');
  hintEl.textContent = 'Select a unit, tap the field to send them. Pinch to zoom.';
});

restartBtn.addEventListener('click', () => {
  banner.classList.remove('show');
  sim = new Sim(Date.now() & 0xffff);
  renderer.gl.dispose();
  app.innerHTML = '';
  renderer = new Renderer(sim, app);
  selected = -1;
  startOverlay.classList.remove('hidden');
  buildCards();
});

function showEnd() {
  const win = sim.winner === Faction.Attacker;
  bannerTitle.textContent = win ? 'CASTLE TAKEN' : 'ASSAULT BROKEN';
  bannerTitle.style.color = win ? '#5fd16a' : '#e8513a';
  const def = sim.countAlive(Faction.Defender);
  bannerText.textContent = win
    ? (def === 0 ? 'A clean sweep — the castle is fully yours.' : 'You hold the walls, but survivors remain. They may regroup…')
    : 'Your army routed before the keep fell. Regroup and try again.';
  banner.classList.add('show');
}

// ---------------- Input: pan / zoom / tap ----------------
let pointers = new Map<number, { x: number; y: number }>();
let dragStart: { x: number; y: number; t: number } | null = null;
let moved = false;
let pinchDist = 0;

const el = renderer.gl.domElement;
el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) { dragStart = { x: e.clientX, y: e.clientY, t: performance.now() }; moved = false; }
  if (pointers.size === 2) { const p = [...pointers.values()]; pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }
});

el.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    const p = [...pointers.values()];
    const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    if (pinchDist > 0) renderer.camDist *= pinchDist / d;
    pinchDist = d; renderer.clampTarget(); moved = true; return;
  }
  // one finger → pan camera target across the ground
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  if (Math.abs(e.clientX - (dragStart?.x ?? e.clientX)) + Math.abs(e.clientY - (dragStart?.y ?? e.clientY)) > 8) moved = true;
  const scale = renderer.camDist * 0.0016;
  renderer.camTarget.x -= dx * scale;
  renderer.camTarget.z -= dy * scale;
  renderer.clampTarget();
});

function endPointer(e: PointerEvent) {
  const wasTap = !moved && dragStart && (performance.now() - dragStart.t) < 350 && pointers.size === 1;
  pointers.delete(e.pointerId);
  if (wasTap) handleTap(e.clientX, e.clientY);
  if (pointers.size < 2) pinchDist = 0;
  if (pointers.size === 0) dragStart = null;
}
el.addEventListener('pointerup', endPointer);
el.addEventListener('pointercancel', endPointer);
el.addEventListener('wheel', (e) => { renderer.camDist *= 1 + Math.sign(e.deltaY) * 0.1; renderer.clampTarget(); }, { passive: true });

function handleTap(clientX: number, clientY: number) {
  const nx = (clientX / window.innerWidth) * 2 - 1;
  const ny = -(clientY / window.innerHeight) * 2 + 1;
  const pt = renderer.raycastGround(nx, ny);
  if (!pt) return;

  // if nothing meaningful selected, try to select a unit under the tap
  const units = sim.playerUnits();
  if (selected === -1) {
    let best = -1, bd = 9;
    for (const u of units) { const d = Math.hypot(u.cx - pt.x, u.cz - pt.z); if (d < bd && u.alive > 0) { bd = d; best = u.id; } }
    if (best >= 0) { selected = best; refreshCards(); return; }
  }
  // issue move order
  if (selected === -2) {
    let k = 0; const n = units.length;
    for (const u of units) { sim.issueMove(u.id, pt.x + (k - n / 2) * 4, pt.z); k++; }
  } else if (selected >= 0) {
    sim.issueMove(selected, pt.x, pt.z);
  }
}

// ---------------- Loop ----------------
buildCards();
loading.remove();

const SIM_DT = 1 / 30;
let acc = 0, last = performance.now();
let ended = false;

function frame(now: number) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;
  acc += dt;
  while (acc >= SIM_DT) { sim.step(SIM_DT); acc -= SIM_DT; }

  // selection ring under selected unit
  if (selected >= 0) { const u = sim.units[selected]; renderer.setSelection(u.alive > 0 ? u.cx : null, u.alive > 0 ? u.cz : null); }
  else renderer.setSelection(null, null);

  renderer.render();
  refreshCards();
  updateTopbar();

  if (sim.phase === 'over' && !ended) { ended = true; showEnd(); }
  if (sim.phase !== 'over') ended = false;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// expose for the screenshot harness
(window as any).__sim = () => sim;
(window as any).__renderer = () => renderer;
