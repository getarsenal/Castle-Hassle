import { Sim, Faction, UType, TYPE_NAME, ArmyComp, DEFAULT_COMP, AtkBuff, NO_BUFF } from './sim';
import './fonts.css';
import { Renderer } from './render';
import { generateCastles, loadProgress, saveProgress, CampaignCastle, Progress, goldReward, ArmyKey, ARMY_KEYS, recruitPrice, LEVY_LIGHT } from './campaign';
import { WorldMap3D } from './worldmap3d';
import { computeBuffs, openUpgrades } from './upgrades';
import * as THREE from 'three';

(window as any).__started = true;
// warm the bundled fonts so canvas-baked labels (map place names) get Cinzel
try { (document as any).fonts?.load("600 30px 'Cinzel'"); (document as any).fonts?.load("400 20px 'EB Garamond'"); } catch { /* ignore */ }

const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const $ = (id: string) => document.getElementById(id)!;

let sim: Sim;
let renderer: Renderer;
let selected = -1;
let paused = false;
const pauseBtn = document.getElementById('pauseBtn'), retreatBtn = document.getElementById('retreatBtn');
pauseBtn?.addEventListener('click', () => { paused = !paused; pauseBtn.classList.toggle('on', paused); pauseBtn.textContent = paused ? 'Resume' : 'Pause'; });
retreatBtn?.addEventListener('click', () => { if (confirm('Sound the retreat? Your surviving troops withdraw; the castle is not taken.')) sim.retreat(); });
let showRange = true;

// ---------------- HUD refs ----------------
const cardsEl = $('cards'), attCountEl = $('attCount'), defCountEl = $('defCount'), phaseEl = $('phase');
const hintEl = $('hint'), startbar = $('startbar'), startBtn = $('startbtn'), toolsEl = $('tools');
const banner = $('banner'), bannerTitle = $('bannerTitle'), bannerText = $('bannerText'), restartBtn = $('restartbtn');

// ---------------- Muster screen ----------------
const comp: ArmyComp = { ...DEFAULT_COMP };
const ROSTER = [
  { key: 'heavy', name: 'Heavy Infantry', dsc: 'Tanky, slow — holds the line', step: 20 },
  { key: 'light', name: 'Light Infantry', dsc: 'Fast, fragile — swarms', step: 20 },
  { key: 'archer', name: 'Archers', dsc: 'Volleys, limited arrows', step: 20 },
  { key: 'cavalry', name: 'Cavalry', dsc: 'Shock charge, weak in a grind', step: 20 },
  { key: 'siege', name: 'Trebuchets', dsc: 'Smash walls, few boulders', step: 1 },
] as const;

const RECRUIT_STEP: Record<string, number> = { heavy: 50, light: 50, archer: 50, cavalry: 25, siege: 1 };
function buildMuster() {
  const rows = $('rosterRows'); rows.innerHTML = '';
  for (const r of ROSTER) {
    const k = r.key as ArmyKey; const step = RECRUIT_STEP[k];
    const row = document.createElement('div'); row.className = 'rrow';
    row.innerHTML = `<div class="info"><div class="nm">${r.name}</div><div class="dsc">${r.dsc}</div>
        <div class="own" data-k="${k}"></div></div>
      <button class="rbtn rec" data-k="${k}">Recruit</button>
      <button class="rbtn minus">−</button><div class="ct" data-k="${k}">0</div><button class="rbtn plus">+</button>`;
    const ct = row.querySelector('.ct') as HTMLElement;
    row.querySelector('.minus')!.addEventListener('click', () => { (comp as any)[k] = Math.max(0, (comp as any)[k] - step); ct.textContent = String((comp as any)[k]); updateMuster(); });
    row.querySelector('.plus')!.addEventListener('click', () => { (comp as any)[k] = Math.min(bringable(k), (comp as any)[k] + step); ct.textContent = String((comp as any)[k]); updateMuster(); });
    row.querySelector('.rec')!.addEventListener('click', () => {
      const price = recruitPrice(k, step, currentDiscount);
      if (progress.gold < price) return;
      progress.gold -= price; progress.army[k] += step; saveProgress(progress);
      (comp as any)[k] = Math.min(bringable(k), (comp as any)[k] + step); // bring the new recruits too
      buildMuster();
    });
    rows.appendChild(row);
  }
  updateMuster();
}
function updateMuster() {
  for (const el of Array.from(document.querySelectorAll('#rosterRows .ct')) as HTMLElement[]) el.textContent = String((comp as any)[el.dataset.k!]);
  for (const el of Array.from(document.querySelectorAll('#rosterRows .own')) as HTMLElement[]) {
    const k = el.dataset.k as ArmyKey;
    const levy = k === 'light' ? Math.max(0, LEVY_LIGHT - progress.army.light) : 0;
    const free = k === 'siege' ? currentExtraTrebs : 0;
    el.textContent = `In your host: ${progress.army[k]}`
      + (levy ? ` (+${levy} levy)` : '') + (free ? ` (+${free} free)` : '');
  }
  for (const el of Array.from(document.querySelectorAll('#rosterRows .rec')) as HTMLButtonElement[]) {
    const k = el.dataset.k as ArmyKey; const price = recruitPrice(k, RECRUIT_STEP[k], currentDiscount);
    el.textContent = `+${RECRUIT_STEP[k]} · ${price}g`; el.disabled = progress.gold < price;
  }
  const total = comp.heavy + comp.light + comp.archer + comp.cavalry + comp.siege;
  const g = $('musterGold'), t = $('musterTotal'); if (g) g.textContent = String(progress.gold); if (t) t.textContent = String(total);
  ($('musterBtn') as HTMLButtonElement).disabled = (comp.heavy + comp.light + comp.archer + comp.cavalry) === 0;
}
$('musterBtn').addEventListener('click', () => { $('muster').classList.remove('show'); newGame(); });
document.getElementById('musterBack')?.addEventListener('click', () => { $('muster').classList.remove('show'); openMap(); });

// ---------------- New game ----------------
let currentSeed = (Date.now() & 0xffff) >>> 0;
let currentDifficulty = 1;
let currentStyle: import('./sim').CastleStyle | undefined;
let currentBuff: AtkBuff = NO_BUFF;
let currentDiscount = 1, currentExtraTrebs = 0;
function newGame() {
  if (renderer) { renderer.gl.dispose(); app.innerHTML = ''; }
  sim = new Sim(currentSeed, { ...comp }, currentDifficulty, currentStyle, currentBuff);
  renderer = new Renderer(sim, app);
  bindInput();
  selected = -1; showRange = true; paused = false;
  if (pauseBtn) { pauseBtn.classList.remove('on'); pauseBtn.textContent = 'Pause'; }
  banner.classList.remove('show'); startbar.style.display = 'block';
  buildCards(); updateHint(); updateTools();
}

// ---------------- Cards (one per arm/division; commands fan out to its companies) ----------------
function buildCards() {
  cardsEl.innerHTML = '';
  for (const div of sim.playerDivs()) {
    const a = sim.divAgg(div);
    const card = document.createElement('div'); card.className = 'card'; card.dataset.div = String(div);
    const ranged = a.type === UType.Archer || a.type === UType.Siege;
    card.innerHTML = `<div class="name">${TYPE_NAME[a.type]}</div><div class="count">${a.alive}</div><div class="bar"><i></i></div>${ranged ? '<div class="ammo"><i></i></div>' : ''}`;
    card.addEventListener('click', () => { selected = selected === div ? -1 : div; refreshCards(); updateHint(); updateTools(); });
    cardsEl.appendChild(card);
  }
}
function refreshCards() {
  for (const card of Array.from(cardsEl.children) as HTMLElement[]) {
    const div = Number(card.dataset.div); const a = sim.divAgg(div);
    card.classList.toggle('sel', selected === div); card.classList.toggle('routing', a.routing);
    card.classList.toggle('assault', sim.assaultingDiv(div));
    (card.querySelector('.count') as HTMLElement).textContent = String(a.alive);
    const frac = a.count ? a.alive / a.count : 0, bar = card.querySelector('.bar > i') as HTMLElement;
    bar.style.width = `${Math.round(frac * 100)}%`;
    bar.style.background = frac > 0.5 ? '#5fd16a' : frac > 0.25 ? '#e8c54a' : '#e8513a';
    const am = card.querySelector('.ammo > i') as HTMLElement | null;
    if (am) am.style.width = `${a.ammoMax ? Math.round(a.ammo / a.ammoMax * 100) : 0}%`;
  }
}
const keepBar = document.getElementById('keepBar'), keepFill = document.getElementById('keepFill'), keepLabel = document.getElementById('keepLabel');
function updateTopbar() {
  attCountEl.textContent = String(sim.countAlive(Faction.Attacker));
  defCountEl.textContent = String(sim.countAlive(Faction.Defender));
  phaseEl.textContent = sim.phase === 'deploy' ? 'DEPLOY' : sim.phase === 'battle' ? 'BATTLE' : 'OVER';
  // keep-capture meter: only meaningful once the assault is underway
  const inBattle = sim.phase === 'battle';
  pauseBtn?.classList.toggle('show', inBattle);
  retreatBtn?.classList.toggle('show', inBattle);
  const cp = sim.captureProgress;
  if (keepBar && keepFill && keepLabel) {
    const showBar = sim.phase === 'battle' && cp > 0.001;
    keepBar.classList.toggle('show', showBar);
    if (showBar) { keepFill.style.width = `${Math.round(cp * 100)}%`; keepLabel.textContent = cp >= 0.999 ? 'KEEP TAKEN' : 'RAISING YOUR BANNER OVER THE KEEP'; }
  }
}
function updateHint() {
  const a = selected >= 0 ? sim.divAgg(selected) : null;
  if (a && a.type === UType.Siege) hintEl.textContent = 'Trebuchets: TAP A WALL to aim · drag to reposition the battery';
  else if (a && a.type === UType.Archer) hintEl.textContent = 'Archers: TAP to focus-fire · ADVANCE to move up · drag to reposition';
  else if (a) hintEl.textContent = 'Tap to send the arm · DRAG to set its line · ASSAULT to storm the keep';
  else if (sim.phase === 'deploy') hintEl.textContent = 'DEPLOY: place your arms, then Begin Battle. Each arm holds until you order its assault.';
  else hintEl.textContent = 'Select an arm and tap Assault to commit it — engines batter the walls on their own.';
}
function updateTools() {
  const a = selected >= 0 ? sim.divAgg(selected) : null;
  const ranged = a && (a.type === UType.Archer || a.type === UType.Siege);
  // every arm but the engines gets its own assault toggle, so committing to the
  // storm is a per-arm decision (this is a strategy game, not all-or-nothing)
  const canAssault = !!a && a.type !== UType.Siege && sim.phase === 'battle';
  toolsEl.innerHTML = '';
  if (!a || (!ranged && !canAssault)) { toolsEl.classList.remove('show'); return; }
  toolsEl.classList.add('show');
  const comps = sim.divCompanies(selected);
  if (canAssault) {
    const on = sim.assaultingDiv(selected);
    const ab = document.createElement('button'); ab.className = 'tool' + (on ? ' on' : '');
    ab.textContent = on ? 'Assaulting' : a.type === UType.Archer ? 'Advance' : 'Assault';
    ab.addEventListener('click', () => { sim.toggleAssaultDiv(selected); refreshCards(); updateTools(); });
    toolsEl.appendChild(ab);
  }
  if (!ranged) return;
  const rb = document.createElement('button'); rb.className = 'tool' + (showRange ? ' on' : ''); rb.textContent = 'Range';
  rb.addEventListener('click', () => { showRange = !showRange; updateTools(); });
  toolsEl.appendChild(rb);
  // ceasefire toggle — stops auto-loosing so a distracted player keeps ammo
  const holding = comps[0]?.holdFire ?? false;
  const hb = document.createElement('button'); hb.className = 'tool' + (holding ? ' on' : '');
  hb.textContent = holding ? 'Hold Fire' : 'Firing';
  hb.addEventListener('click', () => { sim.toggleHoldFireDiv(selected); updateTools(); });
  toolsEl.appendChild(hb);
  if (a!.type === UType.Archer && comps.some(u => u.hasFocus)) {
    const cb = document.createElement('button'); cb.className = 'tool'; cb.textContent = 'Clear Aim';
    cb.addEventListener('click', () => { sim.clearFocusDiv(selected); updateTools(); });
    toolsEl.appendChild(cb);
  }
}

startBtn.addEventListener('click', () => { sim.begin(); startbar.style.display = 'none'; updateHint(); });
restartBtn.addEventListener('click', () => { banner.classList.remove('show'); if (activeCastle) openMap(); else { buildMuster(); $('muster').classList.add('show'); } });

function showEnd() {
  const win = sim.winner === Faction.Attacker;
  // Persistent army, keep-survivors-lose-dead: the survivors of this siege rejoin
  // your host, the fallen are gone for good. Apply the per-arm survival rate to
  // your standing army (the free levy / engineer trebuchets sit above it and just
  // disperse). Casualties stick whether you win, retreat, or are broken.
  let casualtyLine = '';
  if (activeCastle) {
    const sp = sim.attackerSpawned(), al = sim.attackerAlive();
    let brought = 0, fell = 0;
    for (let i = 0; i < ARMY_KEYS.length; i++) {
      const k = ARMY_KEYS[i];
      const rate = sp[i] > 0 ? al[i] / sp[i] : 1;
      progress.army[k] = Math.max(0, Math.round(progress.army[k] * rate));
      if (i < 4) { brought += sp[i]; fell += Math.max(0, sp[i] - al[i]); }   // count men, not engines
    }
    casualtyLine = fell > 0 ? `  ${fell} of ${brought} fell and will not rise again.` : '  Not a single man was lost.';
  }
  if (win) {
    bannerTitle.textContent = 'CASTLE TAKEN';
    bannerTitle.style.color = '#5fd16a';
    bannerText.textContent = sim.captureProgress >= 0.999 ? 'Your banner flies over the keep — the castle is yours.' : 'The garrison is shattered — the castle is yours.';
    if (activeCastle) {
      const firstTake = !progress.completed.includes(activeCastle.id);
      if (firstTake) progress.completed.push(activeCastle.id);
      progress.unlocked = Math.max(progress.unlocked, Math.min(activeCastle.id + 1, castles.length - 1));
      if (firstTake) { const reward = goldReward(activeCastle.tier); progress.gold += reward; bannerText.textContent += `  +${reward} gold in spoils.`; }
    }
  } else if (sim.retreated) {
    bannerTitle.textContent = 'RETREAT SOUNDED';
    bannerTitle.style.color = '#e8c54a';
    bannerText.textContent = 'Your survivors withdraw in good order — the castle stands, unconquered.';
  } else {
    bannerTitle.textContent = 'ASSAULT BROKEN';
    bannerTitle.style.color = '#e8513a';
    bannerText.textContent = 'Your assault was thrown back from the walls.';
  }
  bannerText.textContent += casualtyLine;
  if (activeCastle) saveProgress(progress);
  restartBtn.textContent = activeCastle ? (win ? 'March On' : 'Back to the Map') : 'Fight Again';
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
    if (gesture === 'command' && moved && cmdP0 && cmdP1 && selected >= 0) { sim.orderDivision(selected, cmdP0.x, cmdP0.z, cmdP1.x, cmdP1.z); renderer.pingMove((cmdP0.x + cmdP1.x) / 2, (cmdP0.z + cmdP1.z) / 2); }
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
  // tapping near your troops selects that ARM (the nearest company's division)
  let best = -1, bd = 13;
  for (const u of sim.playerUnits()) { if (u.alive <= 0) continue; const d = Math.hypot(u.cx - p.x, u.cz - p.z); if (d < bd) { bd = d; best = u.div; } }
  if (best >= 0) { selected = best; refreshCards(); updateHint(); updateTools(); return; }
  if (selected >= 0 && sim.phase !== 'over') {
    const a = sim.divAgg(selected);
    if (a.type === UType.Siege) { const seg = sim.wallSegAt(p.x, p.z); if (seg >= 0) { sim.setSiegeTargetDiv(selected, seg); return; } sim.orderDivision(selected, p.x, p.z, p.x, p.z); renderer.pingMove(p.x, p.z); }
    else if (a.type === UType.Archer) { sim.setFocusDiv(selected, p.x, p.z); updateTools(); }
    else { sim.orderDivision(selected, p.x, p.z, p.x, p.z); renderer.pingMove(p.x, p.z); }
  }
}

// ---------------- Campaign screens ----------------
const castles = generateCastles();
let progress: Progress = loadProgress();
let activeCastle: CampaignCastle | null = null;
let map: WorldMap3D | null = null;

function show(id: string, on: boolean) { const el = document.getElementById(id); if (el) el.classList.toggle('show', on); }

function refreshGoldLabel() { const g = document.getElementById('wcGold'); if (g) g.textContent = ` · ${progress.gold} gold`; }
function openMap() {
  activeCastle = null;
  show('intro', false); show('titleScreen', false); show('muster', false); show('map', true);
  banner.classList.remove('show');
  refreshGoldLabel();
  if (map) map.destroy();
  const canvas = $('mapCanvas') as HTMLCanvasElement; // re-fetch (destroy swaps the node)
  map = new WorldMap3D(canvas, castles, progress, enterCastle);
}
document.getElementById('warCouncilBtn')?.addEventListener('click', () => openUpgrades(progress, refreshGoldLabel));

// the most you can field of a kind: your standing army, plus the free light levy
// and any free engineer-corps trebuchets
function bringable(key: ArmyKey): number {
  if (key === 'light') return Math.max(progress.army.light, LEVY_LIGHT);
  if (key === 'siege') return progress.army.siege + currentExtraTrebs;
  return progress.army[key];
}
function enterCastle(c: CampaignCastle) {
  activeCastle = c;
  const buffs = computeBuffs(progress.upg); currentBuff = buffs.atk; currentDiscount = buffs.recruitDiscount; currentExtraTrebs = buffs.extraTrebs;
  currentSeed = c.seed; currentDifficulty = 1 + c.tier * 0.8; currentStyle = c.style;
  // default: bring your whole army
  for (const k of ARMY_KEYS) (comp as any)[k] = bringable(k);
  show('map', false);
  ($('musterTitle') as HTMLElement) && (($('musterTitle') as HTMLElement).textContent = `${c.name} · ${c.region}`);
  buildMuster(); $('muster').classList.add('show');
  newGame(); // backdrop of the actual castle while mustering
}

// Title → start
$('startGameBtn')?.addEventListener('click', () => openMap());
// Intro: after the splash (video or fallback), go to title
function startIntro() {
  show('intro', true);
  const vid = document.getElementById('introVideo') as HTMLVideoElement | null;
  const card = document.getElementById('introCard');
  if (card) card.style.display = 'none';          // the styled card is a fallback only
  let advanced = false;
  const go = () => { if (advanced) return; advanced = true; vid?.pause?.(); show('intro', false); show('titleScreen', true); };
  if (vid) {
    vid.src = './intro.mp4'; vid.style.display = 'block'; vid.playsInline = true;
    vid.addEventListener('ended', go);
    vid.addEventListener('error', () => { if (card) card.style.display = 'flex'; setTimeout(go, 1800); });
    // Browsers block autoplay-with-sound on cold load, so start muted (so the
    // splash always plays), and on the first touch unmute + replay from the top
    // so the player hears it. (The native app can autoplay with audio.)
    let heard = false; const hint = document.getElementById('introHint');
    const isNative = !!(window as any).Capacitor?.isNativePlatform?.();
    const playMuted = () => { vid.muted = true; vid.play().catch(() => { if (card) card.style.display = 'flex'; }); };
    if (isNative) {
      // Capacitor's WKWebView doesn't require a gesture for media, so the splash
      // can play with sound straight away; fall back to muted if it's blocked.
      vid.muted = false;
      vid.play().then(() => { heard = true; if (hint) hint.style.display = 'none'; }).catch(playMuted);
    } else {
      // Browsers block autoplay-with-sound on cold load: start muted so the splash
      // always plays, and unmute + replay on first touch so the player hears it.
      playMuted();
    }
    const hear = () => { if (heard) return; heard = true; if (hint) hint.style.display = 'none'; try { vid.muted = false; vid.currentTime = 0; vid.play(); } catch { /* ignore */ } };
    document.getElementById('intro')?.addEventListener('pointerdown', hear, { once: true });
    setTimeout(() => { if (hint && !heard) hint.style.display = 'none'; }, 2600);
    setTimeout(go, 9000); // safety so the splash can never hang the boot
  } else setTimeout(go, 3000);
}

(window as any).__campaignWin = () => {}; // (placeholder hook)

buildMuster();
newGame(); // a quiet backdrop sim behind the menus
loading.remove();
startIntro();
(window as any).__running = true;

// perf readout (fps / ms / unit count) for on-device testing; tap to hide
const perfEl = document.getElementById('perf');
perfEl?.addEventListener('click', () => perfEl.classList.add('hidden'));
let perfAcc = 0, perfFrames = 0, adaptCooldown = 0;

const SIM_DT = 1 / 30; let acc = 0, last = performance.now(), ended = false;
let simMs = 0, gfxMs = 0;
function frame(now: number) {
  let dt = (now - last) / 1000; last = now; if (dt > 0.1) dt = 0.1;
  // At most ONE sim step per frame, and never accumulate a backlog — otherwise a
  // slow frame triggers extra steps that slow it further (a death spiral). Under
  // heavy load the battle just runs slightly slow-mo instead of locking up.
  const ts = performance.now();
  acc += dt; if (!paused && acc >= SIM_DT) { sim.step(SIM_DT); acc = Math.min(acc - SIM_DT, SIM_DT); }
  if (paused) acc = 0;
  simMs += performance.now() - ts;

  perfAcc += dt; perfFrames++;
  if (perfAcc >= 0.5) {
    const fps = perfFrames / perfAcc;
    const q = renderer.quality;
    if (perfEl) perfEl.textContent = `${fps.toFixed(0)}fps · ${sim.n}u · ${Math.round(q * 100)}%`;
    // adaptive resolution: ease down when struggling, back up when there's room
    if (adaptCooldown > 0) adaptCooldown--;
    else if (fps < 30 && q > 0.45) { renderer.setQuality(q - 0.12); adaptCooldown = 3; }
    else if (fps > 54 && q < 1) { renderer.setQuality(q + 0.1); adaptCooldown = 3; }
    perfAcc = 0; perfFrames = 0; simMs = 0; gfxMs = 0;
  }

  const a = selected >= 0 ? sim.divAgg(selected) : null;
  const rep = selected >= 0 ? sim.divCompanies(selected)[0] : undefined; // a representative company
  if (a && a.alive > 0) renderer.setSelection(a.cx, a.cz); else renderer.setSelection(null, null);
  // aim marker + range fan for the selected ranged arm (driven by a representative company)
  if (a && a.type === UType.Siege && rep && rep.siegeTargetSeg >= 0) { const [tx, tz] = sim.segCenter(rep.siegeTargetSeg); renderer.setTargetMarker(tx, tz); }
  else if (a && a.type === UType.Archer && rep && rep.hasFocus) renderer.setTargetMarker(rep.focusX, rep.focusZ);
  else renderer.setTargetMarker(null, null);
  if (a && a.alive > 0 && (a.type === UType.Archer || a.type === UType.Siege) && showRange && rep) renderer.setRangeFan(a.cx, a.cz, sim.unitRange(rep.id));
  else renderer.setRangeFan(null, null);

  // Skip the battle render while a full-screen overlay covers it (the 3D map,
  // title or splash) — no point drawing two WebGL scenes at once.
  const covered = ['map', 'titleScreen', 'intro'].some(id => document.getElementById(id)?.classList.contains('show'));
  const tg = performance.now();
  if (!covered) renderer.render(Math.min(dt, 0.05));
  gfxMs += performance.now() - tg;
  refreshCards(); updateTopbar();
  if (sim.phase === 'over' && !ended) { ended = true; showEnd(); }
  if (sim.phase !== 'over') ended = false;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
