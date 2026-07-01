import { Sim, Faction, UType, TYPE_NAME, ArmyComp, DEFAULT_COMP, AtkBuff, NO_BUFF } from './sim';
import './fonts.css';
import { Renderer } from './render';
import { generateCastles, loadProgress, saveProgress, CampaignCastle, Progress, goldReward, ArmyKey, ARMY_KEYS, recruitPrice, LEVY_LIGHT, generateRaids, Raid, currentCountry, countryBoons, countryJustConquered, biomeFor, isCoastal, Biome, vetRank, vetMultiplier, RANK_TITLES, battleXP, STARTING_GOLD, STARTING_ARMY, freshVet, RANK_XP, castleDifficulty, setActiveSlot, freshProgress, setDifficultyScalars } from './campaign';
import { loadProfile, saveProfile, recordBattle, DIFFICULTY, ACHIEVEMENTS } from './profile';
import { openMainMenu, openSettings, openAchievements } from './menu';
import { playConquest } from './conquest';
import { nextQuality } from './adaptres';
import { surveyCastle } from './sim';
import { assessBattle } from './balance';
import { WorldMap3D } from './worldmap3d';
import { computeBuffs, openUpgrades } from './upgrades';
import { openRaids } from './raids';
import { openMuster } from './muster';
import { UNIT_ART } from './uniticons';
import { battleAudio } from './audio';
import { feedback, installFeedback } from './feedback';
import { startTutorial } from './tutorial';
import { initDevPanel, DevConfig } from './devpanel';
import * as THREE from 'three';
declare const __BUILD__: string; // injected at build time (commit + timestamp)

(window as any).__started = true;
(window as any).__audio = battleAudio; // console access for tuning / preview render
// warm the bundled fonts so canvas-baked labels (map place names) get Cinzel
try { (document as any).fonts?.load("600 30px 'Cinzel'"); (document as any).fonts?.load("400 20px 'EB Garamond'"); } catch { /* ignore */ }

const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const $ = (id: string) => document.getElementById(id)!;

let sim: Sim;
let renderer: Renderer;
let selected = -1;
let attackArm = -1; // div currently in "Attack — tap an enemy" targeting mode (-1 = off)
let paused = false;
let gameSpeed = 1; // battle tempo: 1x / 2x / 3x
const pauseBtn = document.getElementById('pauseBtn'), retreatBtn = document.getElementById('retreatBtn');
const speedBtn = document.getElementById('speedBtn');
pauseBtn?.addEventListener('click', () => { paused = !paused; pauseBtn.classList.toggle('on', paused); pauseBtn.title = paused ? 'Resume' : 'Pause'; }); // icon swaps via .on in CSS
function applySpeed() { if (!speedBtn) return; speedBtn.textContent = `${gameSpeed}x`; speedBtn.classList.toggle('fast', gameSpeed > 1); }
speedBtn?.addEventListener('click', () => { gameSpeed = gameSpeed >= 3 ? 1 : gameSpeed + 1; applySpeed(); });
const helpBtn = document.getElementById('helpBtn');
helpBtn?.addEventListener('click', () => { const wasPaused = paused; paused = true; startTutorial(true, () => { paused = wasPaused; }); });
// An on-brand confirm dialog (replaces the stock browser confirm()).
function gameConfirm(opts: { title: string; body: string; confirm: string; cancel?: string; danger?: boolean; onConfirm: () => void }) {
  let el = document.getElementById('gConfirm');
  if (!el) { el = document.createElement('div'); el.id = 'gConfirm'; document.body.appendChild(el); }
  el.innerHTML = `<div class="gcCard"><div class="gcTitle">${opts.title}</div><div class="gcBody">${opts.body}</div>`
    + `<div class="gcRow"><button class="ui-btn gcCancel">${opts.cancel || 'Cancel'}</button>`
    + `<button class="ui-btn ${opts.danger ? 'ui-btn--danger' : ''} gcOk">${opts.confirm}</button></div></div>`;
  const close = () => el!.classList.remove('show');
  el.querySelector('.gcCancel')!.addEventListener('click', close);
  el.querySelector('.gcOk')!.addEventListener('click', () => { close(); opts.onConfirm(); });
  el.addEventListener('click', (e) => { if (e.target === el) close(); }); // tap the dark backdrop to dismiss
  el.classList.add('show');
}
retreatBtn?.addEventListener('click', () => gameConfirm({
  title: 'Sound the Retreat?', body: 'Your surviving troops withdraw in good order — the castle is not taken.',
  confirm: 'Sound Retreat', cancel: 'Fight On', danger: true, onConfirm: () => sim.retreat(),
}));
let showRange = true;

// ---------------- HUD refs ----------------
const cardsEl = $('cards'), attCountEl = $('attCount'), defCountEl = $('defCount');
const hintEl = $('hint'), hintText = $('hintText'), hintClose = $('hintClose'), startbar = $('startbar'), startBtn = $('startbtn'), toolsEl = $('tools');
const banner = $('banner'), bannerTitle = $('bannerTitle'), bannerText = $('bannerText'), bannerLosses = $('bannerLosses'), restartBtn = $('restartbtn');
hintClose.addEventListener('click', () => hintEl.classList.add('dismissed'));

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
    if (currentNoArtillery && r.key === 'siege') continue; // no siege train on a town raid
    const k = r.key as ArmyKey; const step = RECRUIT_STEP[k];
    const row = document.createElement('div'); row.className = 'rrow';
    row.innerHTML = `<span class="ic"><img src="${UNIT_ART[k]}" alt=""></span>
      <div class="info"><div class="nm">${r.name}</div><div class="dsc">${r.dsc}</div>
        <div class="own" data-k="${k}"></div></div>
      <div class="qty"><button class="rbtn minus">−</button><div class="ct" data-k="${k}">0</div><button class="rbtn plus">+</button></div>
      <button class="rbtn rec" data-k="${k}">Recruit</button>`;
    const ct = row.querySelector('.ct') as HTMLElement;
    row.querySelector('.minus')!.addEventListener('click', () => { (comp as any)[k] = Math.max(0, (comp as any)[k] - step); ct.textContent = String((comp as any)[k]); updateMuster(); });
    row.querySelector('.plus')!.addEventListener('click', () => { (comp as any)[k] = Math.min(bringable(k), (comp as any)[k] + step); ct.textContent = String((comp as any)[k]); updateMuster(); });
    row.querySelector('.rec')!.addEventListener('click', () => {
      const price = recruitPrice(k, step, currentDiscount);
      if (progress.gold < price) return;
      progress.gold -= price; progress.army[k] += step; saveProgress(progress);
      (comp as any)[k] = Math.min(bringable(k), (comp as any)[k] + step); // bring the new recruits too
      ct.textContent = String((comp as any)[k]);
      updateMuster(); // refresh counts/prices in place — don't rebuild (it would jump scroll to the top)
    });
    rows.appendChild(row);
  }
  updateMuster();
}
function updateMuster() {
  for (const el of Array.from(document.querySelectorAll('#rosterRows .ct')) as HTMLElement[]) el.textContent = String((comp as any)[el.dataset.k!]);
  for (const el of Array.from(document.querySelectorAll('#rosterRows .own')) as HTMLElement[]) {
    const k = el.dataset.k as ArmyKey;
    const levy = k === 'light' ? LEVY_LIGHT : 0; // always a flat +250 on top of your standing foot
    const free = k === 'siege' ? currentExtraTrebs : 0;
    el.textContent = `In your host: ${progress.army[k]}`
      + (levy ? ` (+${levy} levy)` : '') + (free ? ` (+${free} free)` : '');
  }
  for (const el of Array.from(document.querySelectorAll('#rosterRows .rec')) as HTMLButtonElement[]) {
    const k = el.dataset.k as ArmyKey; const price = recruitPrice(k, RECRUIT_STEP[k], currentDiscount);
    el.textContent = `Recruit +${RECRUIT_STEP[k]} · ${price}g`; el.disabled = progress.gold < price;
  }
  const total = comp.heavy + comp.light + comp.archer + comp.cavalry + comp.siege;
  const g = $('musterGold'), t = $('musterTotal'); if (g) g.textContent = String(progress.gold); if (t) t.textContent = String(total);
  ($('musterBtn') as HTMLButtonElement).disabled = (comp.heavy + comp.light + comp.archer + comp.cavalry) === 0;
}
$('musterBtn').addEventListener('click', () => { battleAudio.ensure(); stopMenuMusic(); $('muster').classList.remove('show'); newGame(); startTutorial(); });
document.getElementById('musterBack')?.addEventListener('click', () => { $('muster').classList.remove('show'); openMap(); });

// ---------------- New game ----------------
let currentSeed = (Date.now() & 0xffff) >>> 0;
let currentDifficulty = 1;
let currentStyle: import('./sim').CastleStyle | undefined;
let currentBiome: Biome = 'britain';
let currentCoastal = false;
let currentBuff: AtkBuff = NO_BUFF;
let currentDiscount = 1, currentExtraTrebs = 0, currentNoArtillery = false;
// per-arm veterancy multipliers to field. null = derive from the live save (normal
// play); the dev Battle Lab can pin a flat [1,1,1,1,1] to test a green host.
let currentVet: number[] | null = null;
function newGame() {
  if (renderer) { renderer.gl.dispose(); app.innerHTML = ''; }
  sim = new Sim(currentSeed, { ...comp }, currentDifficulty, currentStyle, currentBuff, currentVet ?? vetMulArray());
  (window as any).__sim = sim; // console/QA access for tuning (like __map / __audio)
  renderer = new Renderer(sim, app, { biome: currentBiome, coastal: currentCoastal });
  bindInput();
  selected = -1; showRange = true; paused = false; gameSpeed = 1; applySpeed();
  if (pauseBtn) { pauseBtn.classList.remove('on'); pauseBtn.title = 'Pause'; }
  banner.classList.remove('show'); document.getElementById('hud')?.classList.remove('over'); startbar.style.display = 'block';
  hintEl.classList.remove('dismissed'); // a fresh battle brings its guidance back
  battleAudio.stopAmbience(); // silence any prior battle's din behind the new setup
  buildCards(); updateHint(); updateTools();
}

// ---------------- Cards (one per arm/division; commands fan out to its companies) ----------------
const UTYPE_KEY = ['heavy', 'light', 'archer', 'cavalry', 'siege'] as const; // UType → ArmyKey for the card art
function buildCards() {
  cardsEl.innerHTML = '';
  for (const div of sim.playerDivs()) {
    const a = sim.divAgg(div);
    const card = document.createElement('div'); card.className = 'card'; card.dataset.div = String(div);
    const ranged = a.type === UType.Archer || a.type === UType.Siege;
    const art = UNIT_ART[UTYPE_KEY[a.type]];
    card.innerHTML = `<div class="cardTop"><img class="cardIc" src="${art}" alt=""><div class="cardTxt"><div class="name">${TYPE_NAME[a.type]}</div><div class="count">${a.alive}</div></div></div><div class="bar"><i></i></div>${ranged ? '<div class="ammo"><i></i></div>' : ''}`;
    card.addEventListener('click', () => { selected = selected === div ? -1 : div; attackArm = -1; refreshCards(); updateHint(); updateTools(); });
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
  // keep-capture meter: only meaningful once the assault is underway
  const inBattle = sim.phase === 'battle';
  pauseBtn?.classList.toggle('show', inBattle);
  speedBtn?.classList.toggle('show', inBattle);
  retreatBtn?.classList.toggle('show', inBattle);
  helpBtn?.classList.toggle('show', sim.phase === 'deploy'); // help lives on the deploy screen; battle top stays uncluttered
  const cp = sim.captureProgress;
  if (keepBar && keepFill && keepLabel) {
    const showBar = sim.phase === 'battle' && cp > 0.001;
    keepBar.classList.toggle('show', showBar);
    if (showBar) { keepFill.style.width = `${Math.round(cp * 100)}%`; keepLabel.textContent = cp >= 0.999 ? 'KEEP TAKEN' : 'RAISING YOUR BANNER OVER THE KEEP'; }
  }
}
function updateHint() {
  const a = selected >= 0 ? sim.divAgg(selected) : null;
  if (attackArm >= 0 && attackArm === selected) hintText.textContent = a && (a.type === UType.Archer) ? 'ATTACK: tap an enemy unit to focus your volleys on it' : 'ATTACK: tap an enemy unit and your arm charges in to fight it';
  else if (a && a.type === UType.Siege) hintText.textContent = 'Trebuchets: TAP A WALL to batter it · TAP ENEMY TROOPS to bombard them · drag to reposition';
  else if (a && a.type === UType.Archer) hintText.textContent = 'Archers: TAP to focus-fire · ADVANCE to move up · drag to reposition';
  else if (a) hintText.textContent = 'Tap the KEEP to storm · tap a WALL to break in there · tap ground to move · drag to set a line';
  else if (sim.phase === 'deploy') hintText.textContent = 'DEPLOY: place your arms, then Begin Battle. Each arm holds until you order its assault.';
  else hintText.textContent = 'Select an arm, then tap the keep to storm or a gate to break in — engines batter the walls on their own.';
}
// keep the cavalry charge button's label/state live (cooldown ticks every frame)
function tickChargeBtn() {
  const cb = document.getElementById('chargeTool') as HTMLButtonElement | null;
  if (!cb || selected < 0 || !sim.isCavalry(selected)) return;
  const ready = sim.chargeReadyDiv(selected); // 0 charging, 1 ready, between = recovering
  cb.textContent = ready === 0 ? 'Charging!' : ready >= 1 ? 'Charge' : 'Recovering';
  cb.classList.toggle('on', ready === 0);
  cb.disabled = ready > 0 && ready < 1;
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
  // "Attack" — for every fighting arm: tap it, then tap an enemy to attack that unit
  if (a.type !== UType.Siege && sim.phase === 'battle') {
    const on = attackArm === selected;
    const atk = document.createElement('button'); atk.className = 'tool atkTool' + (on ? ' on' : ''); atk.textContent = on ? 'Pick target…' : 'Attack';
    atk.addEventListener('click', () => { attackArm = on ? -1 : selected; updateHint(); updateTools(); });
    toolsEl.appendChild(atk);
  }
  if (canAssault) {
    const on = sim.assaultingDiv(selected);
    const ab = document.createElement('button'); ab.className = 'tool' + (on ? ' on' : '');
    ab.textContent = a.type === UType.Archer ? (on ? 'Advancing' : 'Advance') : (on ? 'Storming' : 'Storm Keep');
    ab.addEventListener('click', () => { sim.toggleAssaultDiv(selected); refreshCards(); updateTools(); });
    toolsEl.appendChild(ab);
  }
  // signature ability per melee arm
  if (a.type === UType.Cavalry) {
    const cb = document.createElement('button'); cb.id = 'chargeTool'; cb.className = 'tool';
    cb.addEventListener('click', () => { sim.chargeDiv(selected); });
    toolsEl.appendChild(cb); tickChargeBtn();
  } else if (a.type === UType.Heavy || a.type === UType.Light) {
    const on = sim.stanceOnDiv(selected);
    const sb = document.createElement('button'); sb.className = 'tool' + (on ? ' on' : '');
    sb.textContent = a.type === UType.Heavy ? 'Shield Wall' : (on ? 'Sprinting' : 'Sprint');
    sb.addEventListener('click', () => { sim.toggleStanceDiv(selected); refreshCards(); updateTools(); });
    toolsEl.appendChild(sb);
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
  if (a!.type === UType.Archer) { // aimed massed volleys: longer range, harder hits, slower cadence
    const on = sim.stanceOnDiv(selected);
    const vb = document.createElement('button'); vb.className = 'tool' + (on ? ' on' : ''); vb.textContent = 'Volley';
    vb.addEventListener('click', () => { sim.toggleStanceDiv(selected); updateTools(); });
    toolsEl.appendChild(vb);
  }
  if (a!.type === UType.Archer && comps.some(u => u.hasFocus)) {
    const cb = document.createElement('button'); cb.className = 'tool'; cb.textContent = 'Clear Aim';
    cb.addEventListener('click', () => { sim.clearFocusDiv(selected); updateTools(); });
    toolsEl.appendChild(cb);
  }
}

startBtn.addEventListener('click', () => { sim.begin(); startbar.style.display = 'none'; updateHint(); battleAudio.ensure(); battleAudio.horn('call'); battleAudio.startAmbience(); });
restartBtn.addEventListener('click', () => { banner.classList.remove('show'); if (activeCastle || activeRaid) openMap(); else { buildMuster(); $('muster').classList.add('show'); } });

function showEnd() {
  const win = sim.winner === Faction.Attacker;
  const inCampaign = !!(activeCastle || activeRaid);
  // Persistent army, keep-survivors-lose-dead: the survivors of this battle rejoin
  // your host, the fallen are gone for good. Apply the per-arm survival rate to
  // your standing army (the free levy / engineer trebuchets sit above it and just
  // disperse). Casualties stick whether you win, retreat, or are broken — raids
  // cost just as dearly, so they aren't a free purse.
  let casualtyLine = '';
  // The Butcher's Bill — a per-arm tally of who marched out and who came home, shown
  // for every battle. In a campaign the survival rate also attrits your standing host.
  const sp = sim.attackerSpawned(), al = sim.attackerAlive(), kills = sim.attackerKills;
  let brought = 0, fell = 0;
  const rows: string[] = [];
  const promotions: string[] = []; // arms that earned a higher rank this battle
  let tookCastle = false, battleSpoils = 0; // for the lifetime record
  for (let i = 0; i < ARMY_KEYS.length; i++) {
    const k = ARMY_KEYS[i];
    const rate = sp[i] > 0 ? al[i] / sp[i] : 1;
    const lost = Math.max(0, sp[i] - al[i]);
    if (inCampaign) progress.army[k] = Math.max(0, Math.round(progress.army[k] * rate));
    // veterancy: only an arm that actually FOUGHT earns experience — it must have
    // drawn blood or shed it. An arm brought along but left in reserve (no kills,
    // no losses) gains nothing, so honours reflect who did the fighting.
    const engaged = kills[i] > 0 || lost > 0;
    if (inCampaign && engaged) {
      const v = progress.vet[k], before = vetRank(v.xp);
      v.xp += battleXP({ engaged: true, kills: kills[i], survivalRate: rate, won: win });
      v.battles++; v.kills += kills[i];
      const after = vetRank(v.xp);
      if (after > before) promotions.push(`<div class="hrow"><span class="hn">${TYPE_NAME[i]}</span><span class="hv">${'★'.repeat(after)} ${RANK_TITLES[after]}</span></div>`);
    }
    if (i < 4) { brought += sp[i]; fell += lost; }   // count men, not engines
    if (sp[i] <= 0) continue;                         // arm wasn't mustered for this battle
    // engines are "wrecked", men "fell"; an untouched arm reports all returned
    const verb = i === 4 ? 'wrecked' : 'fell';
    const val = lost > 0 ? `${lost} of ${sp[i]} ${verb}` : `all ${sp[i]} returned`;
    rows.push(`<div class="lrow${lost > 0 ? '' : ' none'}"><span class="ln">${TYPE_NAME[i]}</span><span class="lv">${val}</span></div>`);
  }
  if (rows.length) {
    bannerLosses.innerHTML = `<div class="lhead">The Butcher's Bill</div>${rows.join('')}`
      + (promotions.length ? `<div class="lhead hon">Honours Won</div>${promotions.join('')}` : '');
    bannerLosses.classList.add('show');
  } else {
    bannerLosses.innerHTML = ''; bannerLosses.classList.remove('show');
  }
  if (inCampaign) casualtyLine = fell > 0 ? `  ${fell} of ${brought} fell and will not rise again.` : '  Not a single man was lost.';
  if (win && activeRaid) {
    bannerTitle.textContent = 'RAID SUCCESSFUL';
    bannerTitle.style.color = '#5fd16a';
    progress.gold += activeRaid.reward; battleSpoils = activeRaid.reward;
    bannerText.textContent = `You sack ${activeRaid.name} and ride off with the spoils.  +${activeRaid.reward} gold.`;
  } else if (win) {
    bannerTitle.textContent = 'CASTLE TAKEN';
    bannerTitle.style.color = '#5fd16a';
    bannerText.textContent = sim.captureProgress >= 0.999 ? 'Your banner flies over the keep — the castle is yours.' : 'The garrison is shattered — the castle is yours.';
    if (activeCastle) {
      const firstTake = !progress.completed.includes(activeCastle.id);
      const goldBefore = progress.gold; let goldGained = 0;
      if (firstTake) progress.completed.push(activeCastle.id);
      progress.unlocked = Math.max(progress.unlocked, Math.min(activeCastle.id + 1, castles.length - 1));
      if (firstTake) { const reward = goldReward(activeCastle.tier); progress.gold += reward; goldGained += reward; bannerText.textContent += `  +${reward} gold in spoils.`; }
      // Did that stronghold complete a whole realm? Crown the chapter and grant its boon.
      const realm = firstTake ? countryJustConquered(activeCastle.id, progress, castles) : null;
      if (realm) {
        if (realm.key === 'The Holy Land') {
          bannerTitle.textContent = 'JERUSALEM TAKEN';
          bannerText.textContent = 'The Holy City falls. Your banner flies over Jerusalem — the Crusade is won.';
        } else {
          if (realm.boon.gold) { progress.gold += realm.boon.gold; goldGained += realm.boon.gold; }
          bannerTitle.textContent = `${realm.name.toUpperCase()} CONQUERED`;
          bannerText.textContent = `${realm.name} is yours. ${realm.boonLabel} join your host — ${realm.boonDesc}.`;
        }
        bannerTitle.style.color = '#ffd24a';
      }
      if (firstTake) { tookCastle = true; battleSpoils = goldGained; }
      // queue the grand conquest flourish to play once we're back on the campaign map
      if (firstTake) pendingConquest = { id: activeCastle.id, name: activeCastle.name, goldBefore, goldGained, realm: realm && realm.key !== 'The Holy Land' ? realm.name : realm ? 'Jerusalem' : null };
    }
  } else if (sim.retreated) {
    bannerTitle.textContent = 'RETREAT SOUNDED';
    bannerTitle.style.color = '#e8c54a';
    bannerText.textContent = activeRaid ? 'You break off the raid and withdraw your survivors.' : 'Your survivors withdraw in good order — the castle stands, unconquered.';
  } else {
    bannerTitle.textContent = activeRaid ? 'RAID REPULSED' : 'ASSAULT BROKEN';
    bannerTitle.style.color = '#e8513a';
    bannerText.textContent = activeRaid ? 'They drove your raiders off empty-handed.' : 'Your assault was thrown back from the walls.';
  }
  bannerText.textContent += casualtyLine;
  // ---- lifetime record + achievements (every battle, campaign or not) ----
  const campaignWon = win && !!activeCastle && progress.completed.length >= castles.length;
  const totalKills = kills.reduce((a, b) => a + b, 0);
  const newAch = recordBattle(profile, {
    won: win, castleTaken: tookCastle, raidWon: win && !!activeRaid, kills: totalKills,
    gold: battleSpoils, menLost: fell, campaignWon,
  });
  saveProfile(profile);
  if (newAch.length) { // announce freshly-earned honours under the Butcher's Bill
    const names = newAch.map(id => ACHIEVEMENTS.find(a => a.id === id)?.name).filter(Boolean);
    const html = bannerLosses.innerHTML + `<div class="lhead hon">Honour${names.length > 1 ? 's' : ''} Earned</div>`
      + names.map(n => `<div class="hrow"><span class="hn">★ ${n}</span><span class="hv"></span></div>`).join('');
    bannerLosses.innerHTML = html; bannerLosses.classList.add('show');
  }
  if (inCampaign) saveProgress(progress);
  restartBtn.textContent = inCampaign ? (activeCastle && win ? 'March On' : 'Back to the Map') : 'Fight Again';
  document.getElementById('hud')?.classList.add('over'); // hide the live HUD behind the end card
  battleAudio.stopAmbience();
  // a beat of cinema before the end card: a screen flash, a jolt, and on victory a
  // slow push-in over the captured keep
  const flash = document.getElementById('flash');
  if (flash) {
    flash.style.background = win ? 'radial-gradient(circle at 50% 45%, rgba(255,216,96,0.9), rgba(255,170,40,0.15) 70%)' : 'radial-gradient(circle at 50% 45%, rgba(150,24,24,0.8), rgba(30,0,0,0.15) 70%)';
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
  }
  if (win) {
    battleAudio.victory(); renderer.focusKeep(sim.keepX, sim.keepZ); renderer.shake(1.4);
    setTimeout(() => { banner.classList.add('show'); feedback.reward(); }, 850);
  } else {
    battleAudio.defeat(); renderer.shake(0.8);
    setTimeout(() => banner.classList.add('show'), 350);
  }
}

// ---------------- Input ----------------
const pointers = new Map<number, { x: number; y: number }>();
let gesture: 'none' | 'orbit' | 'command' | 'camera' = 'none';
let downAt = { x: 0, y: 0, t: 0 }; let moved = false;
let cmdP0: THREE.Vector3 | null = null, cmdP1: THREE.Vector3 | null = null;
let pinchDist = 0, panMid = { x: 0, y: 0 };

const ndc = (cx: number, cy: number): [number, number] => [(cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1];
function groundAt(cx: number, cy: number) { const [a, b] = ndc(cx, cy); return renderer.raycastGround(a, b); }
// a command point, kept outside the walls while mustering (matches orderDivision)
function cmdGround(cx: number, cy: number) { const p = groundAt(cx, cy); if (p && sim.phase === 'deploy') p.z = Math.max(p.z, sim.deployLine()); return p; }
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
    if (selected >= 0 && sim.phase !== 'over') { gesture = 'command'; cmdP0 = cmdGround(e.clientX, e.clientY); } else gesture = 'orbit';
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
      cmdP1 = cmdGround(e.clientX, e.clientY);
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
  // ATTACK mode: this tap names the enemy to attack (focus-fire / charge in)
  if (attackArm >= 0 && attackArm === selected && sim.phase !== 'over') {
    const tgt = sim.enemyPosNear(p.x, p.z, 24);
    if (tgt) { sim.attackTargetDiv(selected, tgt.x, tgt.z); renderer.pingMove(tgt.x, tgt.z); }
    attackArm = -1; refreshCards(); updateHint(); updateTools(); return;
  }
  // tapping near your troops selects that ARM (the nearest company's division)
  let best = -1, bd = 13;
  for (const u of sim.playerUnits()) { if (u.alive <= 0) continue; const d = Math.hypot(u.cx - p.x, u.cz - p.z); if (d < bd) { bd = d; best = u.div; } }
  if (best >= 0) { selected = best; attackArm = -1; refreshCards(); updateHint(); updateTools(); return; }
  if (selected >= 0 && sim.phase !== 'over') {
    const a = sim.divAgg(selected);
    if (a.type === UType.Siege) {
      // trebuchets: tap a WALL to batter it, tap enemy TROOPS to bombard them, tap open ground to reposition
      const seg = sim.wallSegAt(p.x, p.z); if (seg >= 0) { sim.setSiegeTargetDiv(selected, seg); updateHint(); return; }
      const foe = sim.phase === 'battle' ? sim.enemyPosNear(p.x, p.z, 16) : null;
      if (foe) { sim.setSiegeBombardDiv(selected, foe.x, foe.z); renderer.pingMove(foe.x, foe.z); updateHint(); return; }
      sim.orderDivision(selected, p.x, p.z, p.x, p.z); renderer.pingMove(p.x, p.z);
    }
    else if (a.type === UType.Archer) { sim.setFocusDiv(selected, p.x, p.z); updateTools(); }
    else if (sim.phase === 'battle' && sim.wallSegAt(p.x, p.z, 9) >= 0) {
      // tapped a standing wall/gate with a melee arm → break in HERE
      const seg = sim.wallSegAt(p.x, p.z, 9); sim.breachSegDiv(selected, seg);
      const [sx, sz] = sim.segCenter(seg); renderer.pingMove(sx, sz); refreshCards(); updateTools();
    }
    else if (sim.phase === 'battle' && (sim.keepTapped(p.x, p.z) || sim.insideWalls(p.x, p.z))) {
      // tapped the keep, or anywhere inside the walls → storm it (fight your way in)
      sim.assaultDiv(selected); renderer.pingMove(sim.keepX, sim.keepZ); refreshCards(); updateTools();
    }
    else { sim.orderDivision(selected, p.x, p.z, p.x, p.z); renderer.pingMove(p.x, p.z); }
  }
}

// ---------------- Campaign screens ----------------
const castles = generateCastles();
const raids = generateRaids();
let progress: Progress = loadProgress();
let profile = loadProfile();
// The main menu: pick a save slot (or start fresh), reachable from the title.
function showMainMenu() {
  openMainMenu({
    castles, profile,
    onPlay: (slot, isNew) => {
      setActiveSlot(slot);
      progress = isNew ? freshProgress() : loadProgress();
      if (isNew) { progress.started = Date.now(); saveProgress(progress); }
      openMap();
    },
    onSettings: () => openSettings(profile, applySettings, () => {}),
    onAchievements: () => openAchievements(profile, () => {}),
  });
}
// apply live settings (volume / mute / difficulty) and persist the profile
function applySettings() {
  audioMuted = profile.settings.muted;
  battleAudio.setMuted(audioMuted);
  battleAudio.setVolume?.(profile.settings.volume);
  if (titleMusic) { titleMusic.muted = audioMuted; }
  document.getElementById('muteBtn')?.classList.toggle('off', audioMuted);
  const d = DIFFICULTY[profile.settings.difficulty];
  setDifficultyScalars(d.garrison, d.reward);
  saveProfile(profile);
}
// fold the saved difficulty mode into the campaign scalars right away
setDifficultyScalars(DIFFICULTY[profile.settings.difficulty].garrison, DIFFICULTY[profile.settings.difficulty].reward);
let activeCastle: CampaignCastle | null = null;
let activeRaid: Raid | null = null;
let map: WorldMap3D | null = null;
// a freshly-taken castle, queued so its conquest flourish plays when we land on the map
let pendingConquest: { id: number; name: string; goldBefore: number; goldGained: number; realm: string | null } | null = null;

function show(id: string, on: boolean) { const el = document.getElementById(id); if (el) el.classList.toggle('show', on); }

function refreshGoldLabel() { const g = document.getElementById('mapGoldVal'); if (g) g.textContent = String(progress.gold); }
// The war buff actually fielded: War-Council upgrades PLUS the permanent boons of
// every realm already conquered (so the host grows as the Crusade advances east).
function warBuffs(): { atk: AtkBuff; discount: number; trebs: number } {
  const b = computeBuffs(progress.upg), cb = countryBoons(progress, castles);
  return { atk: { hp: b.atk.hp + cb.hp, melee: b.atk.melee + cb.melee, archer: b.atk.archer + cb.archer, fire: b.atk.fire, siege: b.atk.siege + cb.siege, reload: b.atk.reload },
    discount: b.recruitDiscount, trebs: b.extraTrebs + cb.trebs };
}
// per-arm veterancy combat multiplier, indexed by UType (= ARMY_KEYS order), folded
// into the Sim so a long-served arm fields hardier, deadlier men.
function vetMulArray(): number[] { return ARMY_KEYS.map(k => vetMultiplier(vetRank(progress.vet[k].xp))); }
function openMap() {
  activeCastle = null; activeRaid = null;
  show('titleScreen', false); show('muster', false); show('map', true); // (the sting overlay, if up, fades itself out over the now-visible map)
  banner.classList.remove('show');
  refreshGoldLabel();
  if (map) map.destroy();
  const canvas = $('mapCanvas') as HTMLCanvasElement; // re-fetch (destroy swaps the node)
  map = new WorldMap3D(canvas, castles, progress, enterCastle);
  updateMapHeader();
  resumeMenuMusic(); // the menu theme carries on across the map (until a battle)
  // a castle just fell? play its conquest flourish over the now-visible map.
  if (pendingConquest) {
    const pc = pendingConquest; pendingConquest = null;
    const goldEl = document.getElementById('mapGoldVal');
    if (goldEl) goldEl.textContent = String(pc.goldBefore); // start at the pre-spoils sum; the coins tick it up
    const from = map.screenOf(pc.id); map.flourishConquest(pc.id);
    playConquest({
      name: pc.name, realm: pc.realm, from, goldBefore: pc.goldBefore, goldGained: pc.goldGained,
      goldEl, coffer: document.getElementById('mapGold'),
      onCoin: () => feedback.coin(), onLand: () => feedback.reward(),
    });
  }
}
// Map header doubles as the campaign objective: which realm you're in, how much
// of it has fallen, and a line on what makes its war different.
function updateMapHeader() {
  const h = document.getElementById('mapHeader'); if (!h) return;
  const cc = currentCountry(progress, castles);
  const onJerusalem = cc.key === 'The Holy Land' && cc.taken >= cc.total - 1 && cc.total > 0;
  h.innerHTML = onJerusalem
    ? `<b style="letter-spacing:1.6px">THE ROAD TO JERUSALEM</b>`
    : `<b style="letter-spacing:1.6px">${cc.name.toUpperCase()}</b><span style="opacity:.7"> · ${cc.taken}/${cc.total} taken</span>` +
      `<div style="font:600 10px 'EB Garamond',serif;letter-spacing:.3px;opacity:.82;margin-top:3px;white-space:normal;color:#e7d3a6">${cc.twist}</div>` +
      `<div class="mapProg"><i style="width:${cc.total ? Math.round(cc.taken / cc.total * 100) : 0}%"></i></div>`;
}
document.getElementById('mapMenuBtn')?.addEventListener('click', () => { feedback.open(); if (map) map.destroy(); map = null; show('map', false); showMainMenu(); });
document.getElementById('warCouncilBtn')?.addEventListener('click', () => { feedback.open(); openUpgrades(progress, refreshGoldLabel); });
document.getElementById('raidsBtn')?.addEventListener('click', () => { feedback.open(); openRaids(progress, raids, enterRaid, refreshGoldLabel); });
document.getElementById('musterMapBtn')?.addEventListener('click', () => { feedback.open(); openMuster(progress, computeBuffs(progress.upg).recruitDiscount, warBuffs().atk, refreshGoldLabel); });

// the most you can field of a kind: your standing army, plus the free light levy
// and any free engineer-corps trebuchets
function bringable(key: ArmyKey): number {
  // the free peasant levy is a flat bonus ON TOP of your standing light foot, so
  // every spearman you recruit genuinely swells the host (and a wiped army still
  // fields the levy, so the campaign never softlocks)
  if (key === 'light') return progress.army.light + LEVY_LIGHT;
  if (key === 'siege') return currentNoArtillery ? 0 : progress.army.siege + currentExtraTrebs;
  return progress.army[key];
}
function enterCastle(c: CampaignCastle) {
  activeCastle = c; activeRaid = null; currentNoArtillery = false; currentVet = null;
  const w = warBuffs(); currentBuff = w.atk; currentDiscount = w.discount; currentExtraTrebs = w.trebs;
  currentSeed = c.seed; currentDifficulty = castleDifficulty(c.tier); currentStyle = c.style;
  currentBiome = biomeFor(c.region); currentCoastal = isCoastal(c.name);
  // default: bring your whole army
  for (const k of ARMY_KEYS) (comp as any)[k] = bringable(k);
  show('map', false);
  ($('musterTitle') as HTMLElement) && (($('musterTitle') as HTMLElement).textContent = `${c.name} · ${c.region}`);
  feedback.open();
  buildMuster(); $('muster').classList.add('show');
  newGame(); // backdrop of the actual castle while mustering
}
// Debug/QA hook: jump straight into a chosen campaign castle's muster (used by the
// headless screenshot harness, which can't reliably pick a 3D map marker).
(window as any).__battle = (n = 0) => { try { stopMenuMusic(); document.querySelectorAll('.show').forEach(e => e.classList.remove('show')); enterCastle(castles[Math.max(0, Math.min(n, castles.length - 1))]); } catch (e) { console.error(e); } };
// A raid: a smaller, weaker holding. Same muster → battle flow, but on a win it
// pays its gold reward (repeatable) instead of unlocking the next siege. A fresh
// seed each time so the fort varies from raid to raid.
function enterRaid(r: Raid) {
  activeRaid = r; activeCastle = null; currentVet = null;
  // a palisade-town raid is an infantry affair — no siege train
  currentNoArtillery = !!r.style.palisade;
  const w = warBuffs(); currentBuff = w.atk; currentDiscount = w.discount; currentExtraTrebs = w.trebs;
  currentSeed = (r.seedBase + (Date.now() & 0x3ff)) >>> 0; currentDifficulty = r.difficulty; currentStyle = r.style;
  currentBiome = 'britain'; currentCoastal = false; // raids are generic holdings — keep the home greenwood
  for (const k of ARMY_KEYS) (comp as any)[k] = bringable(k);
  show('map', false);
  ($('musterTitle') as HTMLElement) && (($('musterTitle') as HTMLElement).textContent = `Raid · ${r.name}`);
  feedback.open();
  buildMuster(); $('muster').classList.add('show');
  newGame();
}

// Title → start
// ---- menu music: plays across the title AND the campaign map (stops once a
// battle begins). Drop the track at public/theme.mp3; only its first
// MUSIC_LOOP_END seconds are used, looped. ----
const titleMusic = document.getElementById('titleMusic') as HTMLAudioElement | null;
const MUSIC_SRC = './theme.mp3';   // served from the deploy root, like intro.mp4
const MUSIC_VOL = 0.55;
const MUSIC_LOOP_END = 38;         // loop just the first 38 seconds of the track
let musicArmed = false, musicStarting = false;
// loop the opening MUSIC_LOOP_END seconds rather than the whole file
titleMusic?.addEventListener('timeupdate', () => { if (titleMusic.currentTime >= MUSIC_LOOP_END) titleMusic.currentTime = 0; });
function rampVolume(a: HTMLAudioElement, to: number, ms: number, thenPause = false) {
  const from = a.volume, t0 = performance.now();
  const tick = () => { const k = Math.min(1, (performance.now() - t0) / ms); a.volume = Math.max(0, Math.min(1, from + (to - from) * k)); if (k < 1) requestAnimationFrame(tick); else if (thenPause) a.pause(); };
  requestAnimationFrame(tick);
}
// first start (on the title) — handles the browser autoplay-gesture gate
function startMenuMusic() {
  if (!titleMusic || musicArmed || musicStarting) return;
  musicStarting = true;
  const tryPlay = () => {
    if (musicArmed) return;
    if (!titleMusic.src) titleMusic.src = MUSIC_SRC;
    titleMusic.volume = 0;
    titleMusic.play().then(() => { musicArmed = true; musicStarting = false; rampVolume(titleMusic, MUSIC_VOL, 1600); })
      .catch(() => { musicStarting = false; document.addEventListener('pointerdown', tryPlay, { once: true }); }); // blocked → start on first touch
  };
  tryPlay();
}
// keep the menu music going (or revive it) when back on the map after a battle
function resumeMenuMusic() {
  if (!titleMusic) return;
  if (!musicArmed) { startMenuMusic(); return; }
  if (titleMusic.paused) titleMusic.play().catch(() => { /* ignore */ });
  rampVolume(titleMusic, MUSIC_VOL, 900);
}
// fade the menu music out (slowly) when the fighting starts
function stopMenuMusic() { if (titleMusic && !titleMusic.paused) rampVolume(titleMusic, 0, 2200, true); }

// ---- master mute (persistent, always reachable) ----
// We force audio on at the gate, so a one-tap mute is a hard requirement, not a nicety.
let audioMuted = profile.settings.muted; // mute now lives in the profile
function applyMute() {
  battleAudio.setMuted(audioMuted);
  battleAudio.setVolume?.(profile.settings.volume);
  if (titleMusic) titleMusic.muted = audioMuted;
  document.getElementById('muteBtn')?.classList.toggle('off', audioMuted);
}
function initMuteControl() {
  applyMute();
  document.getElementById('muteBtn')?.addEventListener('click', () => {
    audioMuted = !audioMuted; profile.settings.muted = audioMuted; saveProfile(profile);
    battleAudio.unlock?.(); applyMute(); // the toggle can double as the first audio-unlock gesture
  });
}

// The GAME is the hero: the player lands straight on the Castle Hassle title. It
// loads silent (web audio can't start without a gesture), and "March to War" is
// the gate — that tap unlocks audio, plays the studio sting WITH sound as a brief
// "Scheidel Interactive presents" transition, then drops into the campaign.
$('startGameBtn')?.addEventListener('click', () => playStudioSting(() => showMainMenu()), { once: true });
function playStudioSting(then: () => void) {
  battleAudio.unlock?.();
  const vid = document.getElementById('introVideo') as HTMLVideoElement | null;
  const intro = document.getElementById('intro');
  const card = document.getElementById('introCard'); if (card) card.style.display = 'none'; // boot no longer uses the card
  let done = false, musicKicked = false;
  // start the campaign theme UNDER the sting's tail so there's no silent gap / hard onset
  const kickMusic = () => { if (musicKicked) return; musicKicked = true; startMenuMusic(); };
  const go = () => {
    if (done) return; done = true;
    kickMusic();
    then(); // build & show the map BENEATH the still-visible sting…
    if (intro) { // …then dissolve the sting away to reveal it (a clean visual crossfade)
      intro.classList.add('fadeout');
      setTimeout(() => { try { vid?.pause?.(); } catch { /* ignore */ } if (vid) vid.style.display = 'none'; show('intro', false); intro.classList.remove('fadeout'); }, 720);
    } else show('intro', false);
  };
  if (!vid) { kickMusic(); then(); return; }
  show('titleScreen', false); show('intro', true);
  vid.src = './intro.mp4'; vid.style.display = 'block'; vid.muted = battleAudio.muted; vid.playsInline = true; vid.volume = 1;
  // audio crossfade: in the last ~1.15s duck the sting out as the theme rises in
  vid.addEventListener('timeupdate', () => {
    const rem = (vid.duration || 9) - vid.currentTime;
    if (rem < 1.15) { kickMusic(); vid.volume = Math.max(0, Math.min(1, rem / 1.15)); }
  });
  vid.addEventListener('ended', go, { once: true });
  vid.addEventListener('error', () => setTimeout(go, 300), { once: true });
  vid.play().catch(() => setTimeout(go, 300));
  intro?.addEventListener('pointerdown', go, { once: true }); // tap to skip — never trap the player
  setTimeout(go, 9000); // safety
}

(window as any).__campaignWin = () => {}; // (placeholder hook)

buildMuster();
newGame(); // a quiet backdrop sim behind the menus
battleAudio.installUnlock(); // unlock Web Audio on the first real touch (esp. iOS)
installFeedback(); // game-wide click/press sounds + haptics
loading.remove();
show('titleScreen', true); // land on the game's own title — the hero, and the audio gate
initMuteControl();
(window as any).__running = true;

// perf readout (fps / ms / unit count) for on-device testing; tap to hide
const perfEl = document.getElementById('perf');

// ---------------- Dev panel (secret: tap the perf bar 5x) ----------------
function devTelemetry(): [string, string][] {
  const info = renderer ? renderer.gl.info : null;
  const mem = (performance as any).memory;
  const att = sim ? sim.countAlive(Faction.Attacker) : 0;
  const def = sim ? sim.countAlive(Faction.Defender) : 0;
  const proj = sim ? sim.projectiles.reduce((n, p) => n + (p.active ? 1 : 0), 0) : 0;
  const pf = sim ? sim.profSnapshot() : null;
  return [
    ['build', typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev'],
    ['fps', telFps.toFixed(0)],
    ['frame ms', (telSimMs + telGfxMs).toFixed(1)],
    ['sim ms', telSimMs.toFixed(1)],
    ['gfx ms', telGfxMs.toFixed(1)],
    ['  sim:hash', pf ? pf.hash.toFixed(1) : '-'],
    ['  sim:pre-pass', pf ? pf.pre.toFixed(1) : '-'],
    ['  sim:main-loop', pf ? pf.main.toFixed(1) : '-'],
    ['  sim:combat', pf ? pf.post.toFixed(1) : '-'],
    ['sim steps/frame', String(lastSteps)],
    ['units (slots)', sim ? String(sim.n) : '0'],
    ['attackers alive', String(att)],
    ['defenders alive', String(def)],
    ['projectiles', String(proj)],
    ['ladders', sim ? String(sim.ladders.length) : '0'],
    ['resolution', renderer ? Math.round(renderer.quality * 100) + '%' : '-'],
    ['draw calls', info ? String(info.render.calls) : '-'],
    ['triangles', info ? info.render.triangles.toLocaleString() : '-'],
    ['geometries', info ? String(info.memory.geometries) : '-'],
    ['textures', info ? String(info.memory.textures) : '-'],
    ['JS heap MB', mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) : 'n/a'],
    ['phase', sim ? sim.phase : '-'],
    ['speed', gameSpeed + 'x' + (paused ? ' paused' : '')],
    ...assaultRows(),
  ];
}
// Live assault breakdown — answers "why no ladders": where the attacker host is,
// and the per-window rate of the escalade events (units reaching a wall, calling
// useLadder, ladders actually made vs blocked by the per-section cap).
function assaultRows(): [string, string][] {
  if (!sim || sim.phase !== 'battle') return [['── assault ──', 'n/a']];
  const a = sim.assaultDiag(), e = a.ev;
  return [
    ['── assault ──', `${a.total} att`],
    ['  storming', String(a.storm)],
    ['  breaching', String(a.breach)],
    ['  moving/other', String(a.move)],
    ['  holding', String(a.hold)],
    ['  AT A WALL', String(a.atFoot)],
    ['  climbing', String(a.climbing)],
    ['  ATT on wall', String(a.onWall)],
    ['  DEF on wall', String(a.defWall)],
    ['  sections assaulted', String(a.secs)],
    ['  ladders up', String(a.ladders)],
    ['  engageWall/win', String(e.engWall)],
    ['  engageGate/win', String(e.engGate)],
    ['  useLadder/win', String(e.useLadder)],
    ['  ladderMade/win', String(e.ladMade)],
    ['  ladCapBlocked', String(e.ladCap)],
    ['  noWallToGoal', String(e.noWall)],
    ['  assaultMove/win', String(e.aMove)],
  ];
}
// Full diagnostic blob the dev panel can copy to the clipboard for sharing.
function devDiagText(): string {
  const rows = devTelemetry();
  return rows.map(([k, v]) => `${k}: ${v}`).join('\n');
}
function startCustomBattle(cfg: DevConfig) {
  comp.heavy = cfg.army.heavy; comp.light = cfg.army.light; comp.archer = cfg.army.archer;
  comp.cavalry = cfg.army.cavalry; comp.siege = cfg.army.siege;
  currentSeed = (cfg.seed >>> 0) || 1; currentDifficulty = cfg.difficulty; currentStyle = cfg.style;
  currentNoArtillery = false;
  // optionally fold in the player's real progression so a dev battle reflects an
  // upgraded, veteran host; otherwise field a clean, un-buffed, green army.
  if (cfg.progression) { const w = warBuffs(); currentBuff = w.atk; currentDiscount = w.discount; currentExtraTrebs = w.trebs; currentVet = null; }
  else { currentBuff = NO_BUFF; currentDiscount = 1; currentExtraTrebs = 0; currentVet = [1, 1, 1, 1, 1]; }
  activeCastle = null; activeRaid = null;
  stopMenuMusic();
  for (const id of ['intro', 'titleScreen', 'map', 'muster', 'banner']) show(id, false);
  document.getElementById('hud')?.classList.remove('over');
  newGame();
  if (cfg.autoBegin) { sim.begin(); startbar.style.display = 'none'; updateHint(); battleAudio.ensure(); battleAudio.horn('call'); battleAudio.startAmbience(); }
}
// ---- dev campaign god-tools (delegated to from the dev panel) ----
const ARM_NAMES = ARMY_KEYS.map((_, i) => TYPE_NAME[i]);
const onMapScreen = () => !!document.getElementById('map')?.classList.contains('show');
// reflect a save change: refresh the gold chip, and if we're on the map, rebuild it
// so marker unlock/complete states update (openMap re-instances WorldMap3D).
function devRefreshMap() { refreshGoldLabel(); if (onMapScreen()) openMap(); else updateMapHeader(); }
// play the conquest flourish over the current objective as a preview (grants a token
// 500 gold so the coffer tick is real and the save stays consistent).
function devPreviewConquest() {
  if (!onMapScreen()) openMap();
  if (!map) return;
  const id = Math.min(progress.unlocked, castles.length - 1);
  const before = progress.gold, gain = 500; progress.gold += gain; saveProgress(progress);
  const goldEl = document.getElementById('mapGoldVal'); if (goldEl) goldEl.textContent = String(before);
  map.flourishConquest(id);
  playConquest({ name: castles[id].name, realm: null, from: map.screenOf(id), goldBefore: before, goldGained: gain,
    goldEl, coffer: document.getElementById('mapGold'), onCoin: () => feedback.coin(), onLand: () => feedback.reward() });
}
const devCampaign = {
  state: () => {
    const cc = currentCountry(progress, castles);
    return {
      gold: progress.gold, unlocked: progress.unlocked, completed: progress.completed.length,
      totalCastles: castles.length, realm: cc.name,
      vet: ARMY_KEYS.map((k, i) => { const r = vetRank(progress.vet[k].xp); return { key: k, name: ARM_NAMES[i], rank: r, title: RANK_TITLES[r], kills: progress.vet[k].kills }; }),
      castles: castles.map(c => ({ id: c.id, name: c.name, done: progress.completed.includes(c.id), locked: c.id > progress.unlocked })),
    };
  },
  setGold: (g: number) => { progress.gold = Math.max(0, Math.floor(g)); saveProgress(progress); refreshGoldLabel(); },
  addGold: (d: number) => { progress.gold = Math.max(0, progress.gold + d); saveProgress(progress); refreshGoldLabel(); },
  unlockAll: () => { progress.unlocked = castles.length - 1; saveProgress(progress); devRefreshMap(); },
  completeRealm: () => {
    const cc = currentCountry(progress, castles);
    for (const id of cc.ids) if (!progress.completed.includes(id)) progress.completed.push(id);
    progress.unlocked = Math.min(castles.length - 1, Math.max(progress.unlocked, (cc.ids.length ? Math.max(...cc.ids) : 0) + 1));
    saveProgress(progress); devRefreshMap();
  },
  resetProgress: () => {
    progress.gold = STARTING_GOLD; progress.completed = []; progress.unlocked = 0;
    progress.upg = {}; progress.army = { ...STARTING_ARMY }; progress.vet = freshVet();
    try { localStorage.removeItem('castlehassle.tutorial.v1'); } catch { /* ignore */ } // true clean slate: see onboarding again
    saveProgress(progress); devRefreshMap();
  },
  bumpVet: (key: string, dir: number) => { const v = progress.vet[key as ArmyKey]; const r = Math.max(0, Math.min(RANK_XP.length - 1, vetRank(v.xp) + dir)); v.xp = RANK_XP[r]; saveProgress(progress); },
  maxVet: () => { for (const k of ARMY_KEYS) progress.vet[k].xp = RANK_XP[RANK_XP.length - 1]; saveProgress(progress); },
  resetVet: () => { progress.vet = freshVet(); saveProgress(progress); },
  enterCastle: (id: number) => enterCastle(castles[Math.max(0, Math.min(castles.length - 1, id))]),
  previewConquest: () => devPreviewConquest(),
};
// ---- balance readout: your CURRENT host's force-ratio vs every castle's real
// garrison, so the whole difficulty curve reads at a glance (a tuning lens). ----
const devBalance = {
  host: () => {
    const men = progress.army.heavy + Math.max(progress.army.light, 0) + LEVY_LIGHT + progress.army.archer + progress.army.cavalry;
    const engines = progress.army.siege + warBuffs().trebs;
    return { men, engines, note: `${men.toLocaleString()} men (incl. ${LEVY_LIGHT} levy) · ${engines} engines` };
  },
  rows: () => {
    const w = warBuffs(), vm = vetMulArray();
    const host = {
      arms: { heavy: progress.army.heavy, light: progress.army.light + LEVY_LIGHT, archer: progress.army.archer, cavalry: progress.army.cavalry, siege: progress.army.siege + w.trebs },
      vetMul: vm, hpBuff: w.atk.hp, meleeBuff: w.atk.melee, archerBuff: w.atk.archer, siegeBuff: w.atk.siege,
    };
    return castles.map(c => {
      const s = surveyCastle(c.seed, c.style, castleDifficulty(c.tier)), pl = s.plan;
      const a = assessBattle(host, {
        garrison: pl.garrison, reserves: pl.reserves, archers: pl.wallArchers.length + pl.towerArchers + pl.citArchers.length,
        citGuard: pl.citGuard, total: s.total, concentric: s.concentric, citadel: s.citadel, towers: s.towers,
      });
      return { id: c.id, name: c.name, garrison: s.total, ratio: a.ratio, band: a.band, done: progress.completed.includes(c.id), unlocked: c.id <= progress.unlocked };
    });
  },
};
(window as any).__nextQuality = nextQuality; // QA hook for the adaptive-resolution decision
(window as any).__surveyCastle = surveyCastle; (window as any).__castles = castles; // QA: card garrison vs real siege
(window as any).__balance = devBalance; // QA: campaign force-ratio curve
(window as any).__raids = raids; // QA: raid economy analysis
const devPanel = initDevPanel({ getTelemetry: devTelemetry, launch: startCustomBattle, exportText: devDiagText, campaign: devCampaign, balance: devBalance });
let perfTaps = 0, perfTapT = 0;
perfEl?.addEventListener('click', () => {
  const now = performance.now();
  if (now - perfTapT > 1200) perfTaps = 0;
  perfTapT = now;
  if (++perfTaps >= 5) { perfTaps = 0; devPanel.open(); }
});
// the campaign map's discreet dev affordance: a ⚙ chip that opens the panel directly
document.getElementById('devMapBtn')?.addEventListener('click', () => devPanel.open());
let perfAcc = 0, perfFrames = 0, adaptCooldown = 0;

const SIM_DT = 1 / 30; let acc = 0, last = performance.now(), ended = false;
let simMs = 0, gfxMs = 0;
let lastSteps = 0, telFps = 0, telSimMs = 0, telGfxMs = 0; // dev-panel telemetry
function frame(now: number) {
  let dt = (now - last) / 1000; last = now; if (dt > 0.1) dt = 0.1;
  // At most ONE sim step per frame, and never accumulate a backlog — otherwise a
  // slow frame triggers extra steps that slow it further (a death spiral). Under
  // heavy load the battle just runs slightly slow-mo instead of locking up.
  const ts = performance.now();
  // Run the fixed-timestep sim at the chosen tempo: gameSpeed steps' worth of time
  // accrues per frame, stepped up to a hard cap so a slow frame can't death-spiral.
  acc += dt * gameSpeed;
  let steps = 0;
  // Time-budgeted catch-up: always advance once, but only run additional steps if
  // a step is cheap enough to fit. A normal battle steps 2-3x to track real time;
  // a vast one (where a single step already eats the frame) takes one step and eases
  // into slight slow-motion rather than stacking steps and collapsing to single-digit
  // fps. Self-tuning to the device — the budget is measured wall-clock, not a count.
  while (!paused && acc >= SIM_DT && steps < 4) {
    const st = performance.now();
    sim.step(SIM_DT); acc -= SIM_DT; steps++;
    if (performance.now() - st > 13) break;
  }
  if (acc > SIM_DT) acc = SIM_DT; // drop any backlog beyond one step
  if (paused) acc = 0;
  simMs += performance.now() - ts;

  // procedural battle audio: aggregate the frame's combat tallies into sound
  const sf = sim.drainSfx();
  if (sim.phase === 'battle' && !paused) {
    const intensity = Math.min(1, (sf.melee + sf.arrows * 0.5 + sf.hits * 3) / 35);
    battleAudio.update(dt, sf, intensity);
    // camera juice: a wall coming down jolts hard, boulder strikes shove, the
    // trebuchet's own release gives a little kick
    if (sf.breaches) renderer.shake(0.9 * sf.breaches);
    if (sf.hits) renderer.shake(Math.min(0.6, sf.hits * 0.2));
    if (sf.boulders) renderer.shake(Math.min(0.25, sf.boulders * 0.06));
  }

  lastSteps = steps;
  perfAcc += dt; perfFrames++;
  if (perfAcc >= 0.5) {
    const fps = perfFrames / perfAcc;
    const q = renderer.quality;
    telFps = fps; telSimMs = simMs / perfFrames; telGfxMs = gfxMs / perfFrames;
    if (perfEl) perfEl.textContent = `${fps.toFixed(0)}fps · ${sim.n}u · ${Math.round(q * 100)}%`;
    // Adaptive resolution — only sheds pixels when RENDER is the bottleneck, and
    // restores quality when the SIM is what's capping fps (see adaptres.ts).
    if (adaptCooldown > 0) adaptCooldown--;
    else { const nq = nextQuality(q, fps, telSimMs, telGfxMs); if (nq !== q) { renderer.setQuality(nq); adaptCooldown = 3; } }
    perfAcc = 0; perfFrames = 0; simMs = 0; gfxMs = 0;
  }

  const a = selected >= 0 ? sim.divAgg(selected) : null;
  const rep = selected >= 0 ? sim.divCompanies(selected)[0] : undefined; // a representative company
  if (a && a.alive > 0) renderer.setSelection(a.cx, a.cz); else renderer.setSelection(null, null);
  // aim marker + range fan for the selected ranged arm (driven by a representative company)
  if (a && a.type === UType.Siege && rep && rep.siegeTargetSeg >= 0) { const [tx, tz] = sim.segCenter(rep.siegeTargetSeg); renderer.setTargetMarker(tx, tz); }
  else if (a && a.type === UType.Siege && rep && rep.hasFocus) renderer.setTargetMarker(rep.focusX, rep.focusZ); // bombardment point
  else if (a && a.type === UType.Archer && rep && rep.hasFocus) renderer.setTargetMarker(rep.focusX, rep.focusZ);
  // melee order marker: a 'break in here' target on the wall, or the keep when storming
  else if (a && rep && rep.objKind === 'breach' && rep.objSeg >= 0) { const [tx, tz] = sim.segCenter(rep.objSeg); renderer.setTargetMarker(tx, tz); }
  else if (a && rep && rep.objKind === 'storm') renderer.setTargetMarker(sim.keepX, sim.keepZ);
  else renderer.setTargetMarker(null, null);
  // range overlay: one fan per company, so the reach reads from each group's
  // position (deploy the front ranks forward and you can see them gain the wall)
  if (a && a.alive > 0 && (a.type === UType.Archer || a.type === UType.Siege) && showRange && rep) {
    // One soft disc PER COMPANY at the TRUE firing radius — they union into a single
    // honest reach region (no inflated ring that claims range the archers don't have,
    // and nothing that grows while focus-firing).
    const r = sim.unitRange(rep.id);
    renderer.setRangeFans(sim.divCompanies(selected).filter(u => u.alive > 0).map(u => ({ x: u.cx, z: u.cz, r })));
  } else renderer.setRangeFans(null);

  // Skip the battle render while a full-screen overlay covers it (the 3D map,
  // title or splash) — no point drawing two WebGL scenes at once.
  const covered = ['map', 'titleScreen', 'intro'].some(id => document.getElementById(id)?.classList.contains('show'));
  const tg = performance.now();
  if (!covered) renderer.render(Math.min(dt, 0.05));
  gfxMs += performance.now() - tg;
  refreshCards(); updateTopbar(); tickChargeBtn();
  if (sim.phase === 'over' && !ended) { ended = true; showEnd(); }
  if (sim.phase !== 'over') ended = false;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
