// Persistent upgrade trees ("War Council"): spend gold earned by taking castles
// on permanent buffs to your army. Data + buff maths + a self-contained overlay
// UI. Buffs are applied to the Sim (combat) and the budget (army size) in main.
import { AtkBuff } from './sim';
import { Progress, saveProgress } from './campaign';

export interface UpgNode { name: string; desc: string; cost: number; }
export interface UpgTree { key: string; title: string; nodes: UpgNode[]; }

export const TREES: UpgTree[] = [
  { key: 'quartermaster', title: 'Quartermaster', nodes: [
    { name: 'Supply Lines', desc: '−8% recruitment cost', cost: 120 },
    { name: 'War Chest', desc: '−16% recruitment cost', cost: 280 },
    { name: 'Grand Logistics', desc: '−24% recruitment cost', cost: 520 },
  ] },
  { key: 'armorer', title: 'Armorer', nodes: [
    { name: 'Hardened Mail', desc: '+12% infantry health', cost: 120 },
    { name: 'Plate Harness', desc: '+24% infantry health', cost: 280 },
    { name: 'Masterwork Plate', desc: '+36% infantry health', cost: 520 },
  ] },
  { key: 'weaponsmith', title: 'Weaponsmith', nodes: [
    { name: 'Whetstones', desc: '+12% melee damage', cost: 120 },
    { name: 'Tempered Steel', desc: '+24% melee damage', cost: 280 },
    { name: 'Damascus Edge', desc: '+36% melee damage', cost: 520 },
  ] },
  { key: 'fletcher', title: 'Master Fletcher', nodes: [
    { name: 'Bodkin Points', desc: '+15% arrow damage', cost: 120 },
    { name: 'Yew Longbows', desc: '+30% arrow damage', cost: 300 },
    { name: 'Fire Arrows', desc: 'Your archers loose flaming arrows', cost: 560 },
  ] },
  { key: 'engineer', title: 'Siege Engineer', nodes: [
    { name: 'Counterweights', desc: '+22% boulder damage', cost: 150 },
    { name: 'Siege Workshop', desc: '+2 free trebuchets', cost: 340 },
    { name: 'Master Engineers', desc: '+44% boulder damage, faster reload', cost: 600 },
  ] },
];

export function computeBuffs(upg: Record<string, number>): { atk: AtkBuff; recruitDiscount: number; extraTrebs: number } {
  const L = (k: string) => upg[k] || 0;
  return {
    atk: {
      hp: 1 + 0.12 * L('armorer'),
      melee: 1 + 0.12 * L('weaponsmith'),
      archer: 1 + 0.15 * Math.min(2, L('fletcher')),
      fire: L('fletcher') >= 3,
      siege: 1 + 0.22 * L('engineer'),
      reload: L('engineer') >= 3 ? 0.8 : 1,
    },
    recruitDiscount: 1 - 0.08 * L('quartermaster'), // cheaper troops
    extraTrebs: L('engineer') >= 2 ? 2 : 0,          // free trebuchets fielded each siege
  };
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
  .upgNode .nm{font-size:var(--fs-label);color:#ffe6a6;font-weight:700;line-height:1.15}
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
  .upgHint{font-size:var(--fs-caption);color:#b6a079;padding:10px 18px 4px}`;
  document.head.appendChild(s);
}

// Build & show the War Council overlay. onClose fires when the player leaves
// (so the caller can re-apply buffs to the current army budget, etc.).
export function openUpgrades(prog: Progress, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'upgScreen';
  const render = () => {
    root.innerHTML = `<div class="upgTop"><div class="upgBar"><button class="upgClose">Back</button><div class="upgGold"><b>${prog.gold}</b> gold</div></div><h2><span class="gameRibbon">War Council</span></h2></div>`
      + `<div class="upgHint">Spend the spoils of conquest on permanent upgrades for your army.</div>`
      + `<div class="upgBody">${TREES.map(t => {
        const lvl = prog.upg[t.key] || 0;
        return `<div class="upgTree"><h3>${t.title}</h3><div class="upgRow">${t.nodes.map((nd, i) => {
          const bought = i < lvl, canbuy = i === lvl && prog.gold >= nd.cost, locked = !bought && !canbuy;
          const cls = bought ? 'bought' : canbuy ? 'canbuy' : 'locked';
          const btn = bought ? 'Owned' : `${nd.cost} gold`;
          return `<div class="upgNode ${cls}">${i > 0 ? '<div class="upgConn"></div>' : ''}`
            + `<div class="nm">${nd.name}</div><div class="ds">${nd.desc}</div>`
            + `<button class="buy" data-k="${t.key}" data-i="${i}" ${bought || locked ? 'disabled' : ''}>${btn}</button></div>`;
        }).join('')}</div></div>`;
      }).join('')}</div>`;
    root.querySelector('.upgClose')!.addEventListener('click', () => { root.remove(); onClose(); });
    root.querySelectorAll<HTMLButtonElement>('.buy').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.k!, i = +b.dataset.i!; const lvl = prog.upg[k] || 0; const node = TREES.find(t => t.key === k)!.nodes[i];
      if (i !== lvl || prog.gold < node.cost) return;
      prog.gold -= node.cost; prog.upg[k] = lvl + 1; saveProgress(prog); render();
    }));
  };
  render();
  document.body.appendChild(root);
}
