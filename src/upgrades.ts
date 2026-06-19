// Persistent upgrade trees ("War Council"): spend gold earned by taking castles
// on permanent buffs to your army. Data + buff maths + a self-contained overlay
// UI. Buffs are applied to the Sim (combat) and the budget (army size) in main.
import { AtkBuff } from './sim';
import { Progress, saveProgress } from './campaign';

export interface UpgNode { name: string; desc: string; cost: number; }
export interface UpgTree { key: string; title: string; nodes: UpgNode[]; }

export const TREES: UpgTree[] = [
  { key: 'quartermaster', title: 'Quartermaster', nodes: [
    { name: 'Supply Lines', desc: '+8% army budget', cost: 120 },
    { name: 'War Chest', desc: '+16% army budget', cost: 280 },
    { name: 'Grand Logistics', desc: '+24% army budget', cost: 520 },
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

export function computeBuffs(upg: Record<string, number>): { atk: AtkBuff; budgetMult: number; extraTrebs: number } {
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
    budgetMult: 1 + 0.08 * L('quartermaster'),
    extraTrebs: L('engineer') >= 2 ? 2 : 0,
  };
}

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement('style'); s.id = 'upg-styles';
  s.textContent = `
  .upgScreen{position:fixed;inset:0;z-index:50;background:linear-gradient(#1a130b,#0d0905);
    color:#f2e6cf;font-family:Georgia,serif;display:flex;flex-direction:column;overflow:hidden}
  .upgTop{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;border-bottom:1px solid #5a4424}
  .upgTop h2{margin:0;font-size:22px;color:#ffe6a6;letter-spacing:.5px}
  .upgGold{font-size:17px;color:#ffd24a;font-weight:700;white-space:nowrap}
  .upgGold b{font-size:20px}
  .upgBody{flex:1;overflow-y:auto;padding:12px 14px 28px}
  .upgTree{margin-bottom:16px}
  .upgTree h3{margin:0 0 8px;font-size:16px;color:#e9cf9a;display:flex;align-items:center;gap:8px}
  .upgRow{display:flex;gap:9px}
  .upgNode{flex:1;border:1px solid #5a4626;border-radius:11px;padding:9px 9px 10px;background:#241a0f;position:relative;text-align:center;min-width:0}
  .upgNode .nm{font-size:12.5px;color:#ffe6a6;font-weight:600;line-height:1.15}
  .upgNode .ds{font-size:11px;color:#cbb78f;margin:4px 0 8px;line-height:1.25;min-height:28px}
  .upgNode .buy{border:none;border-radius:7px;padding:7px 4px;font:600 12px Georgia,serif;width:100%;cursor:pointer}
  .upgNode.bought{border-color:#3f7a3a;background:#1c2c18}
  .upgNode.bought .buy{background:#2f5a2a;color:#bfe6b4}
  .upgNode.canbuy .buy{background:linear-gradient(#caa33a,#9c7a22);color:#241600}
  .upgNode.locked{opacity:.55}
  .upgNode.locked .buy{background:#3a2e1e;color:#9a896c}
  .upgConn{position:absolute;left:-9px;top:50%;width:9px;height:2px;background:#5a4626}
  .upgDone{position:absolute;top:6px;right:8px;color:#7fd06a;font-size:13px;font-weight:700}
  .upgClose{border:none;border-radius:9px;padding:9px 18px;background:#3a2e1e;color:#ffe6a6;font:600 15px Georgia,serif;cursor:pointer}
  .upgHint{font-size:11.5px;color:#a08c66;padding:0 18px 12px}`;
  document.head.appendChild(s);
}

// Build & show the War Council overlay. onClose fires when the player leaves
// (so the caller can re-apply buffs to the current army budget, etc.).
export function openUpgrades(prog: Progress, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'upgScreen';
  const render = () => {
    root.innerHTML = `<div class="upgTop"><button class="upgClose">Back</button><h2>War Council</h2><div class="upgGold"><b>${prog.gold}</b> gold</div></div>`
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
