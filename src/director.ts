// Director Mode — a promo-recording toolkit.
//
// A floating 🎬 chip (on both the battle and the campaign map) opens a small
// panel that drives whichever scene is live: a smooth orbit-speed slider,
// hold-to-nudge pitch/zoom, one-tap "Auto-cine" (a slow orbit with gentle
// breathing), "Hide HUD", and "Clean screen" (hides every control — even the
// chip — for a spotless take; restore by tapping the invisible bottom-left
// hot-corner).
//
// It is deliberately decoupled from the rest of the game: it talks to the two
// renderers only through their QA globals (`window.__r` for the battle,
// `window.__map` for the map), so nothing else has to know it exists.
//   - battle: camYaw / camPitch / camDist + clampTarget()   (public)
//   - map:    azimuth / pitch / dist + clampTarget()         (runtime-accessible)
// The map is the live scene iff `#map` has the `show` class.

const LS_KEY = 'castlehassle.director.v1';

// Every HUD element Director can hide, straight from index.dev.html. #vignette is
// intentionally kept so the framing keeps its cinematic edge-darkening.
const HUD_HIDE = ['topHud', 'topLeft', 'topbar', 'attCount', 'defCount', 'helpBtn',
  'perf', 'speedBtn', 'startbar', 'keepBar', 'hint', 'tools', 'cards', 'muteBtn',
  'mapGold', 'mapHeader', 'mapNav', 'mapMenuBtn', 'devMapBtn']
  .map(id => '#' + id).concat(['.mapCompass']);

// tuning
const ORBIT_MAX = 0.45;   // rad/s at the slider's extremes
const AUTO_ORBIT = 0.12;  // rad/s gentle drift in Auto-cine
const PITCH_AMP = 0.06, PITCH_W = 0.9;   // Auto-cine pitch breathing
const DIST_AMP = 0.05, DIST_W = 0.6;     // Auto-cine dolly breathing
const NUDGE_PITCH = 0.5;  // rad/s while a pitch button is held
const NUDGE_ZOOM = 0.8;   // e-fold rate while a zoom button is held

interface SceneCam { orbit(d: number): void; pitch(d: number): void; zoom(f: number): void; clamp(): void; }

let enabled = false;
let built = false;
let orbitSpeed = 0;      // rad/s, signed (slider)
let autoCine = false;
let phase = 0;           // Auto-cine breathing clock
let held = { pu: false, pd: false, zi: false, zo: false };
let raf = 0, last = 0;

// ---- scene adapters -------------------------------------------------------
function activeScene(): SceneCam | null {
  const w = window as any;
  const mapShown = document.getElementById('map')?.classList.contains('show');
  if (mapShown && w.__map) {
    const m = w.__map;
    return {
      orbit: d => { m.azimuth += d; m.azReset = false; }, // azReset would otherwise recenter us
      pitch: d => { m.pitch = Math.max(0.28, Math.min(1.4, m.pitch + d)); },
      zoom: f => { m.dist *= f; },
      clamp: () => { m.clampTarget?.(); },
    };
  }
  if (w.__r) {
    const r = w.__r;
    return {
      orbit: d => { r.camYaw += d; },
      pitch: d => { r.camPitch += d; },
      zoom: f => { r.camDist *= f; },
      clamp: () => { r.clampTarget?.(); },
    };
  }
  return null;
}

// ---- the animation loop ---------------------------------------------------
function tick(now: number) {
  if (!enabled) { raf = 0; return; }
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
  const cam = activeScene();
  if (cam) {
    if (autoCine) {
      phase += dt;
      cam.orbit(AUTO_ORBIT * dt);
      // apply the derivative of each sinusoid so the breathing composes cleanly
      cam.pitch(PITCH_AMP * PITCH_W * Math.cos(phase * PITCH_W) * dt);
      cam.zoom(1 + DIST_AMP * DIST_W * Math.cos(phase * DIST_W) * dt);
    } else if (orbitSpeed) {
      cam.orbit(orbitSpeed * dt);
    }
    if (held.pu) cam.pitch(NUDGE_PITCH * dt);
    if (held.pd) cam.pitch(-NUDGE_PITCH * dt);
    if (held.zi) cam.zoom(Math.exp(-NUDGE_ZOOM * dt));
    if (held.zo) cam.zoom(Math.exp(NUDGE_ZOOM * dt));
    cam.clamp();
  }
  raf = requestAnimationFrame(tick);
}
function kick() { if (enabled && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }

// ---- UI -------------------------------------------------------------------
function injectStyles() {
  if (document.getElementById('dirStyles')) return;
  const hud = HUD_HIDE.join(',');
  const s = document.createElement('style'); s.id = 'dirStyles';
  s.textContent = `
    #dirChip{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:57;width:46px;height:46px;
      border-radius:50%;border:1.5px solid #ffd24a;background:rgba(20,26,40,.82);color:#ffe1a0;font-size:22px;
      display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;
      box-shadow:0 3px 12px rgba(0,0,0,.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);}
    #dirChip.on{background:#ffd24a;color:#1a2433;}
    #dirPanel{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:57;width:212px;padding:14px;
      display:none;flex-direction:column;gap:11px;border-radius:14px;border:1.5px solid #ffd24a;
      background:rgba(20,26,40,.93);color:#f2e6cf;box-shadow:0 6px 24px rgba(0,0,0,.5);
      backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);pointer-events:auto;
      font:600 13px 'Cinzel',Georgia,serif;letter-spacing:.3px;}
    #dirPanel.show{display:flex;}
    #dirPanel h3{margin:0;font:800 15px 'Cinzel',Georgia,serif;color:#ffe1a0;letter-spacing:1px;text-align:center;}
    #dirPanel .dRow{display:flex;flex-direction:column;gap:5px;}
    #dirPanel label{font-size:11px;letter-spacing:.6px;text-transform:uppercase;opacity:.85;}
    #dirPanel input[type=range]{width:100%;accent-color:#ffd24a;}
    #dirPanel .dBtns{display:flex;gap:7px;}
    #dirPanel .dBtn{flex:1;padding:8px 4px;border-radius:9px;border:1px solid #6c5a34;background:rgba(255,210,74,.08);
      color:#f2e6cf;font:700 12px 'Cinzel',Georgia,serif;letter-spacing:.4px;cursor:pointer;text-align:center;
      user-select:none;-webkit-user-select:none;touch-action:none;}
    #dirPanel .dBtn:active,#dirPanel .dBtn.on{background:#ffd24a;color:#1a2433;border-color:#ffd24a;}
    #dirHot{position:fixed;left:0;bottom:0;width:64px;height:64px;z-index:58;display:none;pointer-events:auto;cursor:pointer;}
    body.dirclean #dirHot{display:block;}
    body.dirhud ${hud}{display:none!important;}
    body.dirclean ${hud},body.dirclean #dirChip,body.dirclean #dirPanel{display:none!important;}
  `;
  document.head.appendChild(s);
}

// wire a button to fire while pressed (for the hold-to-nudge pitch/zoom pads)
function holdBtn(el: HTMLElement, on: () => void, off: () => void) {
  const start = (e: Event) => { e.preventDefault(); on(); kick(); };
  const end = () => off();
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointerleave', end);
  el.addEventListener('pointercancel', end);
}

function build() {
  if (built) return; built = true;
  injectStyles();

  const chip = document.createElement('div'); chip.id = 'dirChip'; chip.textContent = '🎬';
  chip.title = 'Director Mode';
  const panel = document.createElement('div'); panel.id = 'dirPanel';
  panel.innerHTML = `
    <h3>DIRECTOR</h3>
    <div class="dRow"><label>Orbit speed</label>
      <input id="dOrbit" type="range" min="-100" max="100" value="0"></div>
    <div class="dBtns">
      <div class="dBtn" id="dAuto">Auto-cine</div>
      <div class="dBtn" id="dReset">Reset</div>
    </div>
    <div class="dRow"><label>Pitch</label>
      <div class="dBtns"><div class="dBtn" id="dPd">Down</div><div class="dBtn" id="dPu">Up</div></div></div>
    <div class="dRow"><label>Zoom</label>
      <div class="dBtns"><div class="dBtn" id="dZi">In</div><div class="dBtn" id="dZo">Out</div></div></div>
    <div class="dBtns">
      <div class="dBtn" id="dHud">Hide HUD</div>
      <div class="dBtn" id="dClean">Clean screen</div>
    </div>`;
  const hot = document.createElement('div'); hot.id = 'dirHot'; hot.title = 'Show controls';

  document.body.append(chip, panel, hot);

  const $ = (id: string) => panel.querySelector('#' + id) as HTMLElement;
  const orbit = $('dOrbit') as HTMLInputElement;
  const autoBtn = $('dAuto'), hudBtn = $('dHud');

  chip.addEventListener('click', () => {
    const open = panel.classList.toggle('show');
    chip.classList.toggle('on', open);
  });
  orbit.addEventListener('input', () => {
    orbitSpeed = (orbit.valueAsNumber / 100) * ORBIT_MAX;
    if (autoCine) { autoCine = false; autoBtn.classList.remove('on'); } // slider overrides auto
    kick();
  });
  autoBtn.addEventListener('click', () => {
    autoCine = !autoCine; autoBtn.classList.toggle('on', autoCine);
    if (autoCine) { orbitSpeed = 0; orbit.value = '0'; phase = 0; }
    kick();
  });
  $('dReset').addEventListener('click', () => {
    orbitSpeed = 0; orbit.value = '0'; autoCine = false; autoBtn.classList.remove('on');
  });
  holdBtn($('dPu'), () => held.pu = true, () => held.pu = false);
  holdBtn($('dPd'), () => held.pd = true, () => held.pd = false);
  holdBtn($('dZi'), () => held.zi = true, () => held.zi = false);
  holdBtn($('dZo'), () => held.zo = true, () => held.zo = false);
  hudBtn.addEventListener('click', () => {
    const on = document.body.classList.toggle('dirhud');
    hudBtn.classList.toggle('on', on);
  });
  $('dClean').addEventListener('click', () => {
    panel.classList.remove('show'); chip.classList.remove('on');
    document.body.classList.add('dirclean');
    // one fading breadcrumb so nobody is trapped in the clean frame hunting
    // for the invisible restore corner
    let toast = document.getElementById('dirToast');
    if (!toast) {
      toast = document.createElement('div'); toast.id = 'dirToast';
      toast.style.cssText = 'position:fixed;left:14px;bottom:16px;z-index:59;background:#000b;color:#e8dcc2;'
        + 'padding:8px 14px;border-radius:18px;font:600 12.5px Georgia,serif;pointer-events:none;transition:opacity .6s';
      document.body.appendChild(toast);
    }
    toast.textContent = 'Clean screen — tap this corner to restore';
    toast.style.opacity = '1';
    setTimeout(() => { toast!.style.opacity = '0'; }, 2600);
  });
  hot.addEventListener('click', () => { document.body.classList.remove('dirclean'); });

  (window as any).__director = { setDirectorEnabled, isDirectorEnabled };
}

// ---- public API -----------------------------------------------------------
export function isDirectorEnabled(): boolean { return enabled; }

export function setDirectorEnabled(on: boolean) {
  enabled = on;
  try { localStorage.setItem(LS_KEY, on ? '1' : '0'); } catch {}
  if (on) {
    build();
    document.getElementById('dirChip')!.style.display = 'flex';
    kick();
  } else {
    // tidy up: hide the chip and drop any hide/clean framing so nothing is left stuck off-screen
    document.body.classList.remove('dirhud', 'dirclean');
    const chip = document.getElementById('dirChip'), panel = document.getElementById('dirPanel');
    if (chip) { chip.style.display = 'none'; chip.classList.remove('on'); }
    if (panel) panel.classList.remove('show');
    orbitSpeed = 0; autoCine = false;
  }
}

// Boot once at startup: on if the URL hash asks (#director) or it was left on last time.
export function initDirector() {
  let saved = false;
  try { saved = localStorage.getItem(LS_KEY) === '1'; } catch {}
  const hash = location.hash.toLowerCase().includes('director');
  if (saved || hash) setDirectorEnabled(true);
}
