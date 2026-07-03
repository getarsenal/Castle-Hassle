// The War Council: spend the spoils of conquest on permanent doctrine for each
// arm of your host. Every arm has a BASE upgrade, then a fork — two mutually
// exclusive doctrines (e.g. archers go Longbow: damage & reach, or Shortbow:
// speed & volume). Choosing one forsakes the other for the campaign, so the
// council is a build, not a checklist.
import { AtkBuff } from './sim';
import { Progress, saveProgress } from './campaign';

export interface UpgNode { name: string; desc: string; cost: number; }
export interface UpgPath { title: string; blurb: string; nodes: UpgNode[]; }
export interface UpgTree { key: string; legacy?: string; legacyPath?: 1 | 2; title: string; base: UpgNode; paths: [UpgPath, UpgPath]; }

export const TREES: UpgTree[] = [
  { key: 'heavy', legacy: 'armorer', legacyPath: 1, title: "Armorer's Hall — Heavy Infantry",
    base: { name: 'Hardened Mail', desc: '+12% heavy infantry health', cost: 120 },
    paths: [
      { title: 'Bulwark', blurb: 'The unbreakable wall', nodes: [
        { name: 'Tower Shields', desc: '+14% health; a braced wall punishes cavalry far harder', cost: 280 },
        { name: 'Iron Discipline', desc: '+14% health; the shield-wall marches quicker', cost: 520 } ] },
      { title: 'Vanguard', blurb: 'The tip of the spear', nodes: [
        { name: 'Heavy Blades', desc: '+18% melee damage', cost: 280 },
        { name: 'Shock Doctrine', desc: '+14% damage, +10% speed', cost: 520 } ] },
    ] },
  { key: 'light', legacy: 'weaponsmith', legacyPath: 2, title: "Drillmaster's Yard — Light Infantry",
    base: { name: 'Drilled Levies', desc: '+10% light infantry health', cost: 110 },
    paths: [
      { title: 'Skirmishers', blurb: 'Fast, and always on your flank', nodes: [
        { name: 'Fleet of Foot', desc: '+12% speed; flanking blows bite far harder', cost: 250 },
        { name: 'Ghost Companies', desc: '+10% speed, +12% damage', cost: 470 } ] },
      { title: 'Men-at-Arms', blurb: 'Levies no longer', nodes: [
        { name: 'Boiled Leather', desc: '+14% health', cost: 250 },
        { name: 'Veteran Sergeants', desc: '+14% damage', cost: 470 } ] },
    ] },
  { key: 'archer', legacy: 'fletcher', legacyPath: 1, title: "Fletcher's Guild — Archers",
    base: { name: 'Bodkin Points', desc: '+15% arrow damage', cost: 120 },
    paths: [
      { title: 'Longbows', blurb: 'Fewer shafts, each a killer', nodes: [
        { name: 'Yew Longbows', desc: '+20% damage, +12% range', cost: 300 },
        { name: 'Fire Arrows', desc: 'Flaming shafts (burn engines & thatch), +8% range', cost: 560 } ] },
      { title: 'Shortbow Corps', blurb: 'A sky dark with arrows', nodes: [
        { name: 'Rapid Nock', desc: 'Loose 20% faster, +25% arrows carried', cost: 300 },
        { name: 'Arrow Storm', desc: '15% faster still, +25% arrows, +10% speed', cost: 560 } ] },
    ] },
  { key: 'cavalry', title: "Marshal's Stables — Cavalry",
    base: { name: 'Warhorses', desc: '+12% cavalry health', cost: 130 },
    paths: [
      { title: 'Lancers', blurb: 'One charge ends the argument', nodes: [
        { name: 'Couched Lances', desc: 'Charges hit harder and last +1.5s', cost: 320 },
        { name: 'Full Barding', desc: '+16% health, heavier impact still', cost: 580 } ] },
      { title: 'Outriders', blurb: 'Struck, gone, and back again', nodes: [
        { name: 'Fresh Remounts', desc: 'Charge recovers 35% faster, +10% speed', cost: 320 },
        { name: 'Sabres', desc: '+12% damage, +8% speed', cost: 580 } ] },
    ] },
  { key: 'siege', legacy: 'engineer', legacyPath: 1, title: "Engineer's Lodge — Trebuchets",
    base: { name: 'Counterweights', desc: '+22% boulder damage', cost: 150 },
    paths: [
      { title: 'Master Engineers', blurb: 'Stone, delivered precisely', nodes: [
        { name: 'Trained Crews', desc: '+24% damage, 15% faster reload', cost: 360 },
        { name: 'Siege Works', desc: '+2 free engines each siege, +20% range', cost: 640 } ] },
      { title: 'Incendiaries', blurb: 'Let the sky rain fire', nodes: [
        { name: 'Firepots', desc: 'Incendiary ammo: pots of burning pitch (toggle per battery)', cost: 360 },
        { name: 'Greek Fire', desc: 'The pitch burns half again as long', cost: 640 } ] },
    ] },
  { key: 'quartermaster', legacy: 'quartermaster', legacyPath: 2, title: 'Quartermaster — The Host',
    base: { name: 'Supply Lines', desc: '\u221210% recruitment cost', cost: 120 },
    paths: [
      { title: 'Field Surgeons', blurb: 'The fallen walk again', nodes: [
        { name: 'Surgeon Corps', desc: '20% of your fallen recover after a victory', cost: 300 },
        { name: 'Hospitallers', desc: '35% of your fallen recover after a victory', cost: 540 } ] },
      { title: 'War Chest', blurb: 'Gold wins wars too', nodes: [
        { name: 'Tithes', desc: '\u221210% further recruitment cost', cost: 300 },
        { name: 'Crown Backing', desc: '\u22128% further recruitment cost', cost: 540 } ] },
    ] },
];

// level: 0 none, 1 base, 2 base+first path node, 3 both path nodes.
// path: 1 = first doctrine, 2 = second (0 = not yet chosen).
export function treeState(upg: Record<string, number>, t: UpgTree): { lvl: number; path: number } {
  let lvl = upg[t.key] ?? 0, path = upg[t.key + 'P'] ?? 0;
  if (!lvl && t.legacy && upg[t.legacy]) { lvl = Math.min(3, upg[t.legacy]); path = lvl > 1 ? (t.legacyPath ?? 1) : 0; } // old saves keep their progress
  return { lvl, path };
}

export function computeBuffs(upg: Record<string, number>): { atk: AtkBuff; recruitDiscount: number; extraTrebs: number } {
  const hpA = [1, 1, 1, 1, 1], dmgA = [1, 1, 1, 1, 1], spdA = [1, 1, 1, 1, 1], cdA = [1, 1, 1, 1, 1], rngA = [1, 1, 1, 1, 1], ammoA = [1, 1, 1, 1, 1];
  const atk: AtkBuff = { hp: 1, melee: 1, archer: 1, fire: false, siege: 1, reload: 1, hpA, dmgA, spdA, cdA, rngA, ammoA };
  let discount = 1, extraTrebs = 0, surgeons = 0;
  const S = Object.fromEntries(TREES.map(t => [t.key, treeState(upg, t)]));
  { const { lvl, path } = S.heavy; // Armorer's Hall
    if (lvl >= 1) hpA[0] *= 1.12;
    if (path === 1) { if (lvl >= 2) { hpA[0] *= 1.14; atk.braceMul = 2.3; } if (lvl >= 3) { hpA[0] *= 1.14; spdA[0] *= 1.08; } }
    if (path === 2) { if (lvl >= 2) dmgA[0] *= 1.18; if (lvl >= 3) { dmgA[0] *= 1.14; spdA[0] *= 1.1; } } }
  { const { lvl, path } = S.light; // Drillmaster's Yard
    if (lvl >= 1) hpA[1] *= 1.10;
    if (path === 1) { if (lvl >= 2) { spdA[1] *= 1.12; atk.lightFlank = 1.45; } if (lvl >= 3) { spdA[1] *= 1.1; dmgA[1] *= 1.12; } }
    if (path === 2) { if (lvl >= 2) hpA[1] *= 1.14; if (lvl >= 3) dmgA[1] *= 1.14; } }
  { const { lvl, path } = S.archer; // Fletcher's Guild
    if (lvl >= 1) dmgA[2] *= 1.15;
    if (path === 1) { if (lvl >= 2) { dmgA[2] *= 1.2; rngA[2] *= 1.12; } if (lvl >= 3) { atk.fire = true; rngA[2] *= 1.08; } }
    if (path === 2) { if (lvl >= 2) { cdA[2] *= 0.8; ammoA[2] *= 1.25; } if (lvl >= 3) { cdA[2] *= 0.85; ammoA[2] *= 1.25; spdA[2] *= 1.1; } } }
  { const { lvl, path } = S.cavalry; // Marshal's Stables
    if (lvl >= 1) hpA[3] *= 1.12;
    if (path === 1) { if (lvl >= 2) { atk.chargeMul = 3.3; atk.chargeDur = 1.5; } if (lvl >= 3) { hpA[3] *= 1.16; atk.chargeMul = 3.6; } }
    if (path === 2) { if (lvl >= 2) { atk.chargeCd = 0.65; spdA[3] *= 1.1; } if (lvl >= 3) { dmgA[3] *= 1.12; spdA[3] *= 1.08; } } }
  { const { lvl, path } = S.siege; // Engineer's Lodge
    if (lvl >= 1) atk.siege *= 1.22;
    if (path === 1) { if (lvl >= 2) { atk.siege *= 1.24; atk.reload *= 0.85; } if (lvl >= 3) { extraTrebs = 2; rngA[4] *= 1.2; } }
    if (path === 2) { if (lvl >= 2) atk.firepot = true; if (lvl >= 3) atk.burnMul = 1.5; } }
  { const { lvl, path } = S.quartermaster; // Quartermaster
    if (lvl >= 1) discount -= 0.10;
    if (path === 1) { if (lvl >= 2) surgeons = 0.2; if (lvl >= 3) surgeons = 0.35; }
    if (path === 2) { if (lvl >= 2) discount -= 0.10; if (lvl >= 3) discount -= 0.08; } }
  atk.surgeons = surgeons;
  return { atk, recruitDiscount: discount, extraTrebs };
}

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement('style'); s.id = 'upg-styles';
  s.textContent = `
  .upgScreen{position:fixed;inset:0;z-index:50;color:#f2e6cf;font-family:'EB Garamond',Georgia,serif;display:flex;flex-direction:column;overflow:hidden;
    background:radial-gradient(125% 70% at 50% -8%,rgba(150,104,48,0.4),transparent 58%),repeating-linear-gradient(50deg,rgba(255,235,190,0.02) 0 2px,rgba(0,0,0,0.03) 2px 4px),linear-gradient(180deg,#2c1f10,#160f07)}
  .upgTop{display:flex;flex-direction:column;align-items:center;gap:11px;padding:calc(var(--safe-top) + 12px) 14px 13px;border-bottom:1px solid #6a4f28}
  .upgBar{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding-right:50px}
  .upgTop h2{margin:0;display:inline-flex}
  .upgGold{display:flex;align-items:center;gap:6px;font-size:var(--fs-heading);color:var(--gold-soft);font-weight:700;white-space:nowrap;
    padding:6px 14px;border-radius:var(--r-pill);background:linear-gradient(180deg,rgba(64,46,24,0.95),rgba(30,21,11,0.95));border:1px solid rgba(255,225,160,0.3);box-shadow:var(--sh-1),inset 0 1px 0 rgba(255,235,190,0.18)}
  .upgGold b{font-size:var(--fs-title);color:#ffd24a}
  .upgBody{flex:1;overflow-y:auto;padding:14px 14px 28px}
  .upgTree{margin-bottom:18px}
  .upgTree h3{margin:0 0 9px;font-size:var(--fs-heading);color:#ffe0a4;font-family:'Cinzel',Georgia,serif;display:flex;align-items:center;gap:8px}
  .upgRow{display:flex;gap:9px}
  .upgNode{flex:1;border:1px solid #6a5230;border-top:1px solid rgba(255,225,160,0.22);border-radius:var(--r-md);padding:10px 9px 11px;position:relative;text-align:center;min-width:0;
    background:repeating-linear-gradient(50deg,rgba(255,235,190,0.02) 0 2px,rgba(0,0,0,0.03) 2px 4px),linear-gradient(180deg,#46331c,#241809);
    box-shadow:0 4px 12px rgba(0,0,0,0.35),inset 0 1px 0 rgba(255,225,160,0.12)}
  .upgNode .nm{font-size:var(--fs-label);color:#ffe6a6;font-weight:700;line-height:1.15;overflow-wrap:break-word;hyphens:auto}
  .upgNode .ds{font-size:var(--fs-caption);color:#d3bd92;margin:4px 0 9px;line-height:1.25;min-height:28px}
  .upgNode .buy{border:none;border-radius:var(--r-sm);min-height:44px;padding:8px 4px;font:800 var(--fs-label) 'Cinzel',Georgia,serif;width:100%;cursor:pointer;
    color:#8a7a5c;background:linear-gradient(#4a3c26,#34291a);box-shadow:0 3px 0 #241a10}
  .upgNode .buy:active{transform:translateY(2px);box-shadow:0 1px 0 #241a10}
  .upgNode.bought{border-color:#4a8a42;background:linear-gradient(180deg,#244a1e,#16300f)}
  .upgNode.bought .buy{background:linear-gradient(#3f7a37,#2c5a26);color:#cdeec2;border-top:1px solid rgba(180,240,170,0.4);box-shadow:0 3px 0 #1c3a16}
  .upgNode.canbuy{border-color:rgba(255,210,120,0.5)}
  .upgNode.canbuy .buy{background:linear-gradient(var(--gold-bright),var(--gold-deep));color:#2c1a06;border-top:1px solid #fff1c4;box-shadow:var(--gold-drop)}
  .upgNode.canbuy .buy:active{box-shadow:var(--gold-drop-press)}
  .upgNode.locked{opacity:.6}
  .upgConn{position:absolute;left:-9px;top:50%;width:9px;height:2px;background:#6a5230}
  .upgDone{position:absolute;top:6px;right:8px;color:#8fe07a;font-size:var(--fs-label);font-weight:700}
  .upgClose{border:1px solid rgba(255,225,160,0.22);border-radius:var(--r-md);min-height:44px;padding:9px 16px;color:var(--gold-soft);font:700 var(--fs-body) 'Cinzel',Georgia,serif;cursor:pointer;
    background:linear-gradient(180deg,rgba(64,46,24,0.95),rgba(30,21,11,0.95));box-shadow:var(--sh-1),inset 0 1px 0 rgba(255,235,190,0.12)}
  .upgClose:active{transform:translateY(1px)}
  .upgHint{font-size:var(--fs-caption);color:#b6a079;padding:10px 18px 4px}
  .upgFork{display:flex;gap:9px;margin-top:9px}
  .upgPath{flex:1;border:1px dashed rgba(255,225,160,0.25);border-radius:var(--r-md);padding:8px 7px;min-width:0}
  .upgPath h4{margin:0 0 2px;font:800 var(--fs-label) 'Cinzel',Georgia,serif;color:#ffd98e;text-align:center}
  .upgPath .pb{margin:0 0 8px;font-size:var(--fs-caption);color:#b6a079;text-align:center;font-style:italic}
  .upgPath.chosen{border-style:solid;border-color:rgba(143,224,122,0.45)}
  .upgPath.forsaken{opacity:.38;filter:saturate(0.4)}
  .upgPath .upgNode{margin-bottom:8px}
  .upgPath .upgNode:last-child{margin-bottom:0}`;
  document.head.appendChild(s);
}

// Build & show the War Council overlay. onClose fires when the player leaves
// (so the caller can re-apply buffs to the current army budget, etc.).
export function openUpgrades(prog: Progress, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'upgScreen';
  const render = () => {
    root.innerHTML = `<div class="upgTop"><div class="upgBar"><button class="upgClose">Back</button><div class="upgGold"><b>${prog.gold}</b> gold</div></div><h2><span class="gameRibbon">War Council</span></h2></div>`
      + `<div class="upgHint">Each arm follows ONE doctrine — the fork is a choice, not a checklist. Choose the war you want to fight.</div>`
      + `<div class="upgBody">${TREES.map(t => {
        const { lvl, path } = treeState(prog.upg, t);
        const baseB = lvl >= 1, baseCan = !baseB && prog.gold >= t.base.cost;
        const node = (nd: UpgNode, owned: boolean, can: boolean, k: string, i: number) =>
          `<div class="upgNode ${owned ? 'bought' : can ? 'canbuy' : 'locked'}">`
          + `<div class="nm">${nd.name}</div><div class="ds">${nd.desc}</div>`
          + `<button class="buy" data-k="${k}" data-i="${i}" ${owned || !can ? 'disabled' : ''}>${owned ? 'Owned' : nd.cost + ' gold'}</button></div>`;
        const pathHtml = (p: UpgPath, pi: number) => {
          const mine = path === pi + 1, forsaken = path !== 0 && !mine;
          const pLvl = mine ? lvl - 1 : 0; // nodes owned within this path
          return `<div class="upgPath ${mine ? 'chosen' : forsaken ? 'forsaken' : ''}"><h4>${p.title}</h4><div class="pb">${p.blurb}</div>`
            + p.nodes.map((nd, ni) => node(nd, pLvl > ni, baseB && !forsaken && pLvl === ni && prog.gold >= nd.cost, t.key, ni + 1)).join('')
            + `</div>`;
        };
        return `<div class="upgTree"><h3>${t.title}</h3>${node(t.base, baseB, baseCan, t.key, 0)}`
          + `<div class="upgFork">${pathHtml(t.paths[0], 0)}${pathHtml(t.paths[1], 1)}</div></div>`;
      }).join('')}</div>`;
    root.querySelector('.upgClose')!.addEventListener('click', () => { root.remove(); onClose(); });
    root.querySelectorAll<HTMLButtonElement>('.buy').forEach(b => b.addEventListener('click', () => {
      const t = TREES.find(tr => tr.key === b.dataset.k)!; const i = +b.dataset.i!;
      const { lvl, path } = treeState(prog.upg, t);
      let cost = 0;
      if (i === 0) { if (lvl >= 1) return; cost = t.base.cost; }
      else {
        // buying into a path: the first purchase CHOOSES the doctrine and forsakes the other
        const pi = b.closest('.upgPath') === b.closest('.upgFork')?.firstElementChild ? 1 : 2;
        if (lvl < 1 || (path !== 0 && path !== pi)) return;
        const want = lvl; // next node index within the path == lvl-1; button i is ni+1 == lvl
        if (i !== want) return;
        cost = t.paths[pi - 1].nodes[i - 1].cost;
        if (prog.gold < cost) return;
        prog.gold -= cost; prog.upg[t.key] = lvl + 1; prog.upg[t.key + 'P'] = pi;
        if (t.legacy) delete prog.upg[t.legacy]; // migrated — retire the old key
        saveProgress(prog); render(); return;
      }
      if (prog.gold < cost) return;
      prog.gold -= cost; prog.upg[t.key] = Math.max(1, lvl);
      if (t.legacy) { const st = treeState(prog.upg, t); prog.upg[t.key] = Math.max(1, st.lvl); delete prog.upg[t.legacy]; }
      prog.upg[t.key] = Math.max(1, prog.upg[t.key] ?? 0);
      saveProgress(prog); render();
    }));
  };
  render();
  document.body.appendChild(root);
}
