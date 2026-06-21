// First-run guided tour of a siege: a short run of tappable coach cards that teach
// selection, movement, breaking in, the engines, signature abilities, and tempo.
// Shown once (remembered in localStorage) and replayable from the help button.
const KEY = 'castlehassle.tutorial.v1';

interface Step { title: string; text: string; hi?: string; }
const STEPS: Step[] = [
  { title: 'Your host', text: 'Your army is split into ARMS — Heavy and Light foot, Archers, Cavalry and Trebuchets. Tap an arm card (or its troops) to select it.', hi: '#cards' },
  { title: 'Manoeuvre', text: 'With an arm selected, TAP the ground to send it there, or DRAG to draw its battle line. Each arm moves as one body.' },
  { title: 'Break in', text: 'To get inside: tap a GATE and they bring up a ram; tap a WALL and they raise ladders to scale it; tap the KEEP to storm straight for it.' },
  { title: 'Combined arms', text: 'Trebuchets smash stone walls — select them and tap a wall to aim. Send your Archers up to thin the defenders before the foot go in.' },
  { title: 'Signature moves', text: 'Each arm has a special order: Heavy hold a Shield Wall, Light Sprint, Archers loose a Volley, and Cavalry sound the Charge. Use them at the right moment.' },
  { title: 'Take the keep', text: 'Set the tempo with Speed (1x/2x/3x) and Pause. Hold the ground at the keep until your banner rises — and the castle is yours. To arms!', hi: '#speedBtn' },
];

export function tutorialSeen(): boolean { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
function markSeen() { try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ } }

let root: HTMLElement | null = null;
let onDone: (() => void) | null = null;

function ensureStyle() {
  if (document.getElementById('tutStyle')) return;
  const s = document.createElement('style'); s.id = 'tutStyle';
  s.textContent = `
  #tutorial{position:fixed;inset:0;z-index:80;pointer-events:auto;display:none;
    background:rgba(6,10,18,0.55);backdrop-filter:blur(1.5px)}
  #tutorial.show{display:block}
  .tutHi{position:relative;z-index:81;outline:3px solid #ffd24a;outline-offset:3px;border-radius:12px;
    box-shadow:0 0 0 9999px rgba(6,10,18,0.55),0 0 22px 4px rgba(255,210,74,0.7);transition:outline .2s}
  .tutCard{position:absolute;left:50%;bottom:max(28px,calc(var(--safe-bottom,0px) + 22px));transform:translateX(-50%);
    width:min(440px,90vw);background:linear-gradient(180deg,#1b2436,#141c2c);border:1px solid rgba(255,225,160,0.28);
    border-radius:16px;padding:18px 18px 14px;box-shadow:0 18px 50px rgba(0,0,0,0.6);color:#f3e7c8;
    font-family:'Spectral',Georgia,serif}
  .tutCard h3{margin:0 0 6px;font-family:'Cinzel',Georgia,serif;font-size:18px;color:#ffe6a6;letter-spacing:.3px}
  .tutCard p{margin:0 0 12px;font-size:14.5px;line-height:1.5;color:#dcd2bb}
  .tutRow{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .tutDots{display:flex;gap:6px}
  .tutDots i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.25)}
  .tutDots i.on{background:#ffd24a}
  .tutBtns{display:flex;gap:8px}
  .tutSkip{background:none;border:none;color:#9fb0c6;font:600 13px 'Cinzel',serif;cursor:pointer;padding:8px}
  .tutNext{background:linear-gradient(180deg,#ffd95e,#f1b53a);border:none;color:#241600;
    font:700 14px 'Cinzel',serif;padding:9px 18px;border-radius:10px;cursor:pointer}
  .tutNext:active{transform:translateY(1px)}`;
  document.head.appendChild(s);
}

let step = 0; let hiEl: HTMLElement | null = null;
function clearHi() { if (hiEl) { hiEl.classList.remove('tutHi'); hiEl = null; } }

function render() {
  if (!root) return;
  const s = STEPS[step];
  clearHi();
  if (s.hi) { const el = document.querySelector(s.hi) as HTMLElement | null; if (el) { el.classList.add('tutHi'); hiEl = el; } }
  const dots = STEPS.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
  const last = step === STEPS.length - 1;
  root.innerHTML = `<div class="tutCard">
    <h3>${s.title}</h3><p>${s.text}</p>
    <div class="tutRow"><div class="tutDots">${dots}</div>
      <div class="tutBtns">${last ? '' : '<button class="tutSkip">Skip</button>'}<button class="tutNext">${last ? 'To battle' : 'Next'}</button></div>
    </div></div>`;
  root.querySelector('.tutNext')!.addEventListener('click', () => { step++; if (step >= STEPS.length) finish(); else render(); });
  root.querySelector('.tutSkip')?.addEventListener('click', finish);
}

function finish() {
  markSeen(); clearHi();
  if (root) { root.classList.remove('show'); root.innerHTML = ''; }
  const cb = onDone; onDone = null; if (cb) cb();
}

// Open the tour. force=true replays it from the help button; otherwise it only
// shows the first time. onComplete fires when dismissed (e.g. to begin the battle).
export function startTutorial(force = false, onComplete?: () => void): boolean {
  if (!force && tutorialSeen()) return false;
  ensureStyle();
  if (!root) { root = document.createElement('div'); root.id = 'tutorial'; document.body.appendChild(root); }
  onDone = onComplete || null; step = 0; root.classList.add('show'); render();
  return true;
}
