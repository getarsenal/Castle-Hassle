// First-run guided tour of a siege: a short run of tappable coach cards that teach
// selection, movement, breaking in, the engines, signature abilities, and tempo.
// Shown once (remembered in localStorage) and replayable from the help button.
const KEY = 'castlehassle.tutorial.v1';
const MAP_KEY = 'castlehassle.maptour.v1';

interface Step { title: string; text: string; hi?: string; }
// In-battle tour: how to fight a siege.
const STEPS: Step[] = [
  { title: 'Your host', text: 'Your army is split into ARMS — Heavy and Light foot, Archers, Cavalry and Trebuchets. Tap an arm card (or its troops) to select it.', hi: '#cards' },
  { title: 'Manoeuvre', text: 'With an arm selected, TAP the ground to send it there, or DRAG to draw its battle line — a long drag spreads them wide, a short one deepens the ranks.' },
  { title: 'Break in', text: 'To get inside: tap a GATE and they bring up a ram; tap a WALL and they raise ladders to scale it; tap the KEEP to storm straight for it.' },
  { title: 'The trebuchets', text: 'Trebuchets are decisive. Select them, then TAP A WALL to batter it down — or TAP ENEMY TROOPS to bombard them with stone. Break the walls, or thin the host: you choose.' },
  { title: 'Veteran arms', text: 'Every battle an arm FIGHTS in, it earns veterancy — rising from Raw Levy to Legendary, growing hardier and deadlier. Keep your veterans alive and they become your finest.' },
  { title: 'Signature moves', text: 'Each arm has a special order: Heavy hold a Shield Wall, Light Sprint, Archers loose a Volley, Cavalry sound the Charge. Use them at the right moment.' },
  { title: 'Take the keep', text: 'Set the tempo with Speed (1x/2x/3x) and Pause. Hold the ground at the keep until your banner rises — and the castle is yours. To arms!', hi: '#speedBtn' },
];
// Campaign-map tour: the loop of raiding, recruiting, and conquest.
const MAP_STEPS: Step[] = [
  { title: 'The crusade', text: 'This is your road east, castle by castle, to Jerusalem. Tap a stronghold to scout its garrison and lay siege — but great castles need a great host.' },
  { title: 'Raid for silver', text: 'You begin with a small warband. RAID lightly-held holds for gold — a safer fight than a siege, and the coin to build your army.', hi: '#raidsBtn' },
  { title: 'Muster your host', text: 'Spend that gold to RECRUIT. A small purchase swells a small host — light foot are cheap fodder, heavy men-at-arms and trebuchets the prized, decisive buys.', hi: '#musterMapBtn' },
  { title: 'The War Council', text: 'Spoils also buy permanent upgrades — hardier armour, deadlier arrows, stronger engines. Forge the army that will take the Holy City.', hi: '#warCouncilBtn' },
];

export function tutorialSeen(): boolean { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
function markSeen(key: string) { try { localStorage.setItem(key, '1'); } catch { /* private mode */ } }

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
    width:min(440px,90vw);border:1px solid #5a4626;
    background:repeating-linear-gradient(50deg,rgba(255,235,190,0.018) 0 2px,rgba(0,0,0,0.025) 2px 4px),radial-gradient(130% 90% at 50% -10%,rgba(126,90,42,0.24),transparent 62%),linear-gradient(180deg,#241a0f,#150f08);
    border-radius:16px;padding:18px 18px 14px;box-shadow:0 18px 50px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,225,160,0.12);color:#f3e7c8;
    font-family:'Spectral',Georgia,serif;animation:tutRise .34s cubic-bezier(.2,.9,.25,1)}
  @keyframes tutRise{from{opacity:0;transform:translate(-50%,14px)}to{opacity:1;transform:translateX(-50%)}}
  .tutCard h3{margin:0 0 6px;font-family:'Cinzel',Georgia,serif;font-size:18px;color:#ffe6a6;letter-spacing:.3px}
  .tutCard p{margin:0 0 12px;font-size:14.5px;line-height:1.5;color:#dcd2bb}
  .tutRow{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .tutDots{display:flex;gap:6px}
  .tutDots i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.25)}
  .tutDots i.on{background:#ffd24a}
  .tutBtns{display:flex;gap:8px}
  .tutSkip{background:none;border:none;color:#a08c66;font:600 13px 'Cinzel',serif;cursor:pointer;padding:8px}
  .tutNext{background:linear-gradient(180deg,#ffd95e,#f1b53a);border:none;color:#241600;
    font:700 14px 'Cinzel',serif;padding:9px 18px;border-radius:10px;cursor:pointer}
  .tutNext:active{transform:translateY(1px)}`;
  document.head.appendChild(s);
}

let step = 0; let hiEl: HTMLElement | null = null;
let curSteps: Step[] = STEPS, curKey = KEY, curEndLabel = 'To battle';
function clearHi() { if (hiEl) { hiEl.classList.remove('tutHi'); hiEl = null; } }

function render() {
  if (!root) return;
  const s = curSteps[step];
  clearHi();
  if (s.hi) { const el = document.querySelector(s.hi) as HTMLElement | null; if (el) { el.classList.add('tutHi'); hiEl = el; } }
  const dots = curSteps.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
  const last = step === curSteps.length - 1;
  root.innerHTML = `<div class="tutCard">
    <h3>${s.title}</h3><p>${s.text}</p>
    <div class="tutRow"><div class="tutDots">${dots}</div>
      <div class="tutBtns">${last ? '' : '<button class="tutSkip">Skip</button>'}<button class="tutNext">${last ? curEndLabel : 'Next'}</button></div>
    </div></div>`;
  root.querySelector('.tutNext')!.addEventListener('click', () => { step++; if (step >= curSteps.length) finish(); else render(); });
  root.querySelector('.tutSkip')?.addEventListener('click', finish);
}

function finish() {
  markSeen(curKey); clearHi();
  if (root) { root.classList.remove('show'); root.innerHTML = ''; }
  const cb = onDone; onDone = null; if (cb) cb();
}

function runTour(steps: Step[], key: string, endLabel: string, force: boolean, onComplete?: () => void): boolean {
  if (!force) { try { if (localStorage.getItem(key) === '1') return false; } catch { /* ignore */ } }
  ensureStyle();
  if (!root) { root = document.createElement('div'); root.id = 'tutorial'; document.body.appendChild(root); }
  curSteps = steps; curKey = key; curEndLabel = endLabel;
  onDone = onComplete || null; step = 0; root.classList.add('show'); render();
  return true;
}

// The in-battle siege tour. force=true replays it from the help button.
export function startTutorial(force = false, onComplete?: () => void): boolean {
  return runTour(STEPS, KEY, 'To battle', force, onComplete);
}
// The campaign-map tour (raid → recruit → conquer), shown once on the first map.
export function startCampaignTour(force = false, onComplete?: () => void): boolean {
  return runTour(MAP_STEPS, MAP_KEY, 'Onward', force, onComplete);
}
