// The teaching layer. Two parts:
//  1) COACH-MARKS — a spotlight tour that dims the screen, cuts a hole over a
//     real on-screen control, and floats a captioned bubble with an arrow that
//     points right at it. The spotlit control stays fully live, so the tour
//     never blocks the very thing it is teaching.
//  2) THE BATTLE COACH — a reactive mentor that watches the first siege and, at
//     the right moments, pauses and offers one clear suggestion (break the wall,
//     pour through the breach, storm the keep). Each tip fires once, only when
//     its moment truly arrives, and leaves the field tappable so the player can
//     act on the advice at once. First siege only; never nags.
const KEY = 'castlehassle.tutorial.v1';
const MAP_KEY = 'castlehassle.maptour.v1';

// ---- shared styling ----
function ensureStyle() {
  if (document.getElementById('tutStyle')) return;
  const s = document.createElement('style'); s.id = 'tutStyle';
  s.textContent = `
  #coach{position:fixed;inset:0;z-index:90;display:none;pointer-events:none}
  #coach.show{display:block}
  /* the four dimming panels leave a live hole over the spotlit control */
  .coDim{position:absolute;background:rgba(6,10,18,0.62);pointer-events:auto;transition:all .28s cubic-bezier(.3,.9,.3,1)}
  .coRing{position:absolute;border-radius:12px;pointer-events:none;
    box-shadow:0 0 0 3px #ffd24a,0 0 22px 5px rgba(255,210,74,0.55);transition:all .28s cubic-bezier(.3,.9,.3,1);
    animation:coPulse 1.9s ease-in-out infinite}
  @keyframes coPulse{0%,100%{box-shadow:0 0 0 3px #ffd24a,0 0 18px 3px rgba(255,210,74,0.45)}50%{box-shadow:0 0 0 3px #ffe89a,0 0 30px 8px rgba(255,210,74,0.75)}}
  .coBubble{position:absolute;width:min(360px,86vw);pointer-events:auto;
    border:1px solid #5a4626;border-radius:15px;padding:15px 16px 12px;color:#f3e7c8;
    background:radial-gradient(130% 90% at 50% -10%,rgba(126,90,42,0.26),transparent 62%),linear-gradient(180deg,#241a0f,#150f08);
    box-shadow:0 18px 48px rgba(0,0,0,0.62),inset 0 1px 0 rgba(255,225,160,0.12);
    font-family:'Spectral',Georgia,serif;animation:coRise .3s cubic-bezier(.2,.9,.25,1)}
  @keyframes coRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .coBubble.center{left:50%;top:auto;bottom:max(26px,calc(var(--safe-bottom,0px) + 20px));transform:translateX(-50%);animation:coRiseC .3s cubic-bezier(.2,.9,.25,1)}
  @keyframes coRiseC{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translateX(-50%)}}
  /* the arrow: a diamond pip nudged to point at the target (offset via --ax) */
  .coBubble .coArrow{position:absolute;left:var(--ax,50%);width:15px;height:15px;transform:translateX(-50%) rotate(45deg);
    background:#1c140b;border:1px solid #5a4626}
  .coBubble.below .coArrow{top:-8px;border-right:none;border-bottom:none}
  .coBubble.above .coArrow{bottom:-8px;border-left:none;border-top:none}
  .coBubble h3{margin:0 0 5px;font-family:'Cinzel',Georgia,serif;font-size:16.5px;color:#ffe6a6;letter-spacing:.3px;display:flex;align-items:center;gap:7px}
  .coBubble h3 .coIx{font-size:12px;color:#b79a5f;font-weight:600}
  .coBubble p{margin:0 0 11px;font-size:14px;line-height:1.5;color:#dcd2bb}
  .coRow{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .coDots{display:flex;gap:5px}
  .coDots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.22)}
  .coDots i.on{background:#ffd24a}
  .coBtns{display:flex;gap:8px;align-items:center}
  .coSkip{background:none;border:none;color:#9a8862;font:600 12.5px 'Cinzel',serif;cursor:pointer;padding:7px 4px}
  .coNext{background:linear-gradient(180deg,#ffd95e,#f1b53a);border:none;color:#241600;
    font:700 13.5px 'Cinzel',serif;padding:9px 17px;border-radius:10px;cursor:pointer}
  .coNext:active{transform:translateY(1px)}
  .coTag{display:inline-block;font:700 10px 'Cinzel',serif;letter-spacing:1px;color:#8a6a33;text-transform:uppercase;margin-bottom:2px}`;
  document.head.appendChild(s);
}

let host: HTMLElement | null = null;
function ensureHost(): HTMLElement {
  ensureStyle();
  if (!host) { host = document.createElement('div'); host.id = 'coach'; document.body.appendChild(host); }
  return host;
}

// Lay the spotlight: four dim panels around `rect` (a live hole), a ring, and a
// captioned bubble whose arrow points at the target. rect=null → a centred card
// over a light global dim (used when the lesson is about the field, not a button).
interface Mark { title: string; text: string; target?: string | null; place?: 'above' | 'below'; tag?: string; index?: string; }
function paint(m: Mark, ctrl: { onNext: () => void; onSkip?: () => void; nextLabel: string; dots?: [number, number]; center?: boolean }) {
  const h = ensureHost(); h.classList.add('show'); h.innerHTML = '';
  const el = m.target ? document.querySelector(m.target) as HTMLElement | null : null;
  const rect = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
  const pad = 6;
  const dotHtml = ctrl.dots ? `<div class="coDots">${Array.from({ length: ctrl.dots[1] }, (_, i) => `<i class="${i === ctrl.dots![0] ? 'on' : ''}"></i>`).join('')}</div>` : '<div></div>';
  const skipHtml = ctrl.onSkip ? '<button class="coSkip">Skip</button>' : '';
  const bubbleInner = `${m.tag ? `<span class="coTag">${m.tag}</span>` : ''}
    <h3>${m.title}</h3><p>${m.text}</p>
    <div class="coRow">${dotHtml}<div class="coBtns">${skipHtml}<button class="coNext">${ctrl.nextLabel}</button></div></div>`;

  if (rect && !ctrl.center) {
    // four dim panels around the live hole
    const vw = window.innerWidth, vh = window.innerHeight;
    const R = { l: rect.left - pad, t: rect.top - pad, r: rect.right + pad, b: rect.bottom + pad };
    const panel = (x: number, y: number, w: number, hh: number) => { const d = document.createElement('div'); d.className = 'coDim'; d.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(0, w)}px;height:${Math.max(0, hh)}px`; d.addEventListener('click', () => {/* swallow taps on the dim */}); h.appendChild(d); };
    panel(0, 0, vw, R.t);
    panel(0, R.b, vw, vh - R.b);
    panel(0, R.t, R.l, R.b - R.t);
    panel(R.r, R.t, vw - R.r, R.b - R.t);
    const ring = document.createElement('div'); ring.className = 'coRing';
    ring.style.cssText = `left:${R.l}px;top:${R.t}px;width:${R.r - R.l}px;height:${R.b - R.t}px`;
    h.appendChild(ring);
    // bubble above or below the target, whichever has room; arrow tracks the target
    const bub = document.createElement('div'); bub.className = 'coBubble'; bub.innerHTML = `<div class="coArrow"></div>${bubbleInner}`;
    h.appendChild(bub);
    const bw = bub.offsetWidth, bh = bub.offsetHeight, gap = 14;
    const below = R.t < vh * 0.42;
    let top = below ? R.b + gap : R.t - gap - bh;
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(10, Math.min(vw - bw - 10, left));
    top = Math.max(10, Math.min(vh - bh - 10, top));
    bub.style.left = `${left}px`; bub.style.top = `${top}px`;
    bub.classList.add(below ? 'below' : 'above');
    bub.style.setProperty('--ax', `${Math.max(16, Math.min(bw - 16, rect.left + rect.width / 2 - left))}px`);
    bub.querySelector('.coNext')!.addEventListener('click', ctrl.onNext);
    bub.querySelector('.coSkip')?.addEventListener('click', ctrl.onSkip!);
  } else {
    // no target (or hidden): a centred card over a soft full dim; the field stays
    // reachable because this dim is click-through except on the card itself
    const dim = document.createElement('div'); dim.className = 'coDim';
    dim.style.cssText = 'inset:0;left:0;top:0;width:100%;height:100%;background:rgba(6,10,18,0.32)';
    h.appendChild(dim);
    const bub = document.createElement('div'); bub.className = 'coBubble center'; bub.innerHTML = bubbleInner;
    h.appendChild(bub);
    bub.querySelector('.coNext')!.addEventListener('click', ctrl.onNext);
    bub.querySelector('.coSkip')?.addEventListener('click', ctrl.onSkip!);
  }
}
function clearCoach() { if (host) { host.classList.remove('show'); host.innerHTML = ''; } }

// ============================ 1) TOURS (stepped) ============================
interface Step { title: string; text: string; hi?: string; place?: 'above' | 'below'; }
// The opening siege tour — runs in the deploy phase (no combat is ticking), so
// it can point calmly at the real controls before a blow is struck.
const DEPLOY_STEPS: Step[] = [
  { title: 'Your arms', text: 'Your host is split into ARMS — Heavy foot, Light foot, Archers, Cavalry and Trebuchets. Tap an arm here to take command of it.', hi: '#cards', place: 'above' },
  { title: 'Take position', text: 'With an arm chosen, TAP the ground to march it there, or DRAG to draw its battle line — a wide drag spreads the ranks, a short one deepens them. Set your host before you advance.' },
  { title: 'How a castle falls', text: 'A stronghold is won from INSIDE. Tap a GATE and they bring a ram; tap a WALL and they raise ladders; tap the KEEP to storm it. Trebuchets shatter stone from afar.' },
  { title: 'Guidance', text: 'Lost at any point? Tap the ❓ to see this again — and once the fight begins, I will call out what to do.', hi: '#helpBtn', place: 'below' },
  { title: 'Sound the advance', text: 'Arms placed? Tap Begin Battle to open the assault — then command the fight as it unfolds. To arms!', hi: '#startbtn', place: 'above' },
];
const MAP_STEPS: Step[] = [
  { title: 'The crusade', text: 'This is your road east, castle by castle, to Jerusalem. Tap a stronghold to scout its garrison and lay siege — but great castles need a great host.' },
  { title: 'Raid for silver', text: 'You begin with a small warband. RAID lightly-held holds for gold — a safer fight than a siege, and the coin to build your army.', hi: '#raidsBtn', place: 'above' },
  { title: 'Muster your host', text: 'Spend that gold to RECRUIT. A small purchase swells a small host — light foot are cheap fodder, heavy men-at-arms and trebuchets the prized, decisive buys.', hi: '#musterMapBtn', place: 'above' },
  { title: 'The War Council', text: 'Spoils also buy permanent upgrades — hardier armour, deadlier arrows, stronger engines. Forge the army that will take the Holy City.', hi: '#warCouncilBtn', place: 'above' },
];

export function tutorialSeen(): boolean { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
function markSeen(key: string) { try { localStorage.setItem(key, '1'); } catch { /* private mode */ } }

let tourSteps: Step[] = [], tourKey = KEY, tourEnd = 'To battle', tourStep = 0, tourDone: (() => void) | null = null;
function renderTour() {
  const s = tourSteps[tourStep];
  const last = tourStep === tourSteps.length - 1;
  paint({ title: s.title, text: s.text, target: s.hi, place: s.place, tag: 'Field manual' },
    {
      nextLabel: last ? tourEnd : 'Next', dots: [tourStep, tourSteps.length],
      onNext: () => { tourStep++; if (tourStep >= tourSteps.length) finishTour(); else renderTour(); },
      onSkip: last ? undefined : finishTour,
    });
}
function finishTour() { markSeen(tourKey); clearCoach(); const cb = tourDone; tourDone = null; if (cb) cb(); }
function runTour(steps: Step[], key: string, end: string, force: boolean, onComplete?: () => void): boolean {
  if (!force) { try { if (localStorage.getItem(key) === '1') return false; } catch { /* ignore */ } }
  tourSteps = steps; tourKey = key; tourEnd = end; tourStep = 0; tourDone = onComplete || null;
  // let the deploy HUD settle a frame so getBoundingClientRect is honest
  requestAnimationFrame(() => requestAnimationFrame(renderTour));
  return true;
}
export function startTutorial(force = false, onComplete?: () => void): boolean {
  return runTour(DEPLOY_STEPS, KEY, 'To arms!', force, onComplete);
}
export function startCampaignTour(force = false, onComplete?: () => void): boolean {
  return runTour(MAP_STEPS, MAP_KEY, 'Onward', force, onComplete);
}

// ======================= 2) THE BATTLE COACH (reactive) =======================
export interface CoachSnap {
  t: number;            // seconds of live battle so far
  hasSiege: boolean;    // the host brought trebuchets
  wallsDown: number; gatesDown: number;
  inside: number;       // attackers standing within the walls
  capture: number;      // 0..1, your banner rising over the keep
  pushUsed: boolean;
}
interface Beat { id: string; when: (s: CoachSnap) => boolean; title: string; text: string; target?: string; place?: 'above' | 'below'; }
// Fired in list order: the first not-yet-shown beat whose moment has arrived.
const BEATS: Beat[] = [
  { id: 'controls', target: '#topRight', place: 'below', when: s => s.t > 1.4,
    title: 'Your battle controls', text: 'These appear the moment the fighting starts: <b>❚❚</b> pause to plan, <b>1x/2x/3x</b> to set the pace, and <b>⚔ Push</b> — the General’s Push, once per battle, when the moment is hot.' },
  { id: 'advance', when: s => s.t > 4 && s.inside < 3 && s.wallsDown + s.gatesDown === 0,
    title: 'Get them moving', text: 'Nothing is won standing still. Select an arm from the cards below, then tap a <b>WALL</b>, <b>GATE</b>, or the <b>KEEP</b> to send them at it.' },
  { id: 'trebs', target: '#cards', place: 'above', when: s => s.hasSiege && s.t > 11 && s.wallsDown + s.gatesDown === 0,
    title: 'Bring down the walls', text: 'The walls still stand. Select your <b>Trebuchets</b> and tap a wall section — stone shatters where the boulders land, and a breach lets your foot pour in.' },
  { id: 'breach', when: s => s.wallsDown + s.gatesDown >= 1 && s.inside < 12,
    title: 'A breach is open!', text: 'The wall is broken. Funnel your foot through the gap — select an arm and tap the opening, then drive inward before they plug it.' },
  { id: 'keep', when: s => s.inside >= 28 && s.capture < 0.02,
    title: 'Now storm the keep', text: 'Your men are inside! Take the <b>KEEP</b> — tap it to send an arm to hold its ground. Hold it until your banner rises, and the castle is yours.' },
  { id: 'push', target: '#pushBtn', place: 'below', when: s => !s.pushUsed && s.t > 22 && s.inside >= 18 && s.capture < 0.9,
    title: 'Seize the moment', text: 'The assault is joined and the blood is up. Tap <b>⚔ Push</b> now — for a time your whole host strikes harder and steadies its nerve. Use it to break the deadlock.' },
];

let coachOn = false, coachT = 0, coachCd = 0, carded = false, cand = '', candT = 0;
const shown = new Set<string>();
let coachPause: ((b: boolean) => void) | null = null;
export function beginBattleCoach(setPaused: (b: boolean) => void) {
  coachOn = true; coachT = 0; coachCd = 1.0; carded = false; cand = ''; candT = 0; shown.clear(); coachPause = setPaused;
}
export function endBattleCoach() { coachOn = false; coachPause = null; if (carded) { carded = false; clearCoach(); } }
export function tickBattleCoach(dt: number, s: CoachSnap) {
  if (!coachOn || carded) return;
  coachT += dt; if (coachCd > 0) coachCd -= dt;
  if (coachCd > 0) return;
  // the next un-shown beat whose moment has come — but only once it has HELD for
  // ~0.9s, so a flicker of state never yanks a card up mid-action
  let hit = '';
  for (const b of BEATS) { if (!shown.has(b.id) && b.when(s)) { hit = b.id; break; } }
  if (!hit) { cand = ''; candT = 0; return; }
  if (hit !== cand) { cand = hit; candT = 0; return; }
  candT += dt; if (candT < 0.9) return;
  const beat = BEATS.find(b => b.id === hit)!;
  shown.add(beat.id); cand = ''; candT = 0; carded = true;
  coachPause?.(true); // pause so the player can read, think, and act — the field stays tappable
  paint({ title: beat.title, text: beat.text, target: beat.target, place: beat.place, tag: 'Your captain advises' },
    {
      nextLabel: 'Got it', center: !beat.target,
      onNext: () => { carded = false; coachCd = 4.5; clearCoach(); coachPause?.(false); },
    });
}
