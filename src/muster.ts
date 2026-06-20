// The Muster overlay: recruit companies into your standing army straight from
// the world map, so you can rebuild between sieges before committing to one.
// A styled DOM screen (mirrors the War Council / Raids overlays).
import { Progress, ArmyKey, recruitPrice, saveProgress } from './campaign';

const ROSTER: { key: ArmyKey; name: string; dsc: string; step: number }[] = [
  { key: 'heavy', name: 'Heavy Infantry', dsc: 'Tanky, slow — holds the line', step: 50 },
  { key: 'light', name: 'Light Infantry', dsc: 'Fast, fragile — swarms the breach', step: 50 },
  { key: 'archer', name: 'Archers', dsc: 'Volleys from range, limited arrows', step: 50 },
  { key: 'cavalry', name: 'Cavalry', dsc: 'Shock charge, weak in a grind', step: 25 },
  { key: 'siege', name: 'Trebuchets', dsc: 'Smash walls, few boulders', step: 1 },
];

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement('style'); s.id = 'mus-styles';
  s.textContent = `
  .musScreen{position:fixed;inset:0;z-index:50;background:linear-gradient(#0e1320,#070a11);
    color:#eaf0f7;font-family:'EB Garamond',Georgia,serif;display:flex;flex-direction:column;overflow:hidden}
  .musTop{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;border-bottom:1px solid #2c3a52}
  .musTop h2{margin:0;font-size:22px;color:#cfe0f4;letter-spacing:.5px;font-family:'Cinzel',Georgia,serif}
  .musGold{font-size:17px;color:#ffd24a;font-weight:700;white-space:nowrap}
  .musGold b{font-size:20px}
  .musHint{font-size:12px;color:#8aa0bd;padding:9px 18px 6px;line-height:1.45}
  .musBody{flex:1;overflow-y:auto;padding:8px 14px 28px}
  .musRow{display:flex;align-items:center;gap:11px;padding:11px 13px;border-radius:13px;margin-bottom:10px;
    background:linear-gradient(180deg,rgba(56,72,100,0.5),rgba(24,33,52,0.7));border:1px solid rgba(255,255,255,0.1)}
  .musInfo{flex:1;min-width:0}
  .musName{font-size:15px;font-weight:800;color:#eaf0f7}
  .musDsc{font-size:11px;color:rgba(255,255,255,0.55)}
  .musOwn{font-size:11.5px;font-weight:700;color:#9fd0ff;margin-top:3px}
  .musRec{min-width:80px;height:46px;border:none;border-radius:11px;cursor:pointer;display:flex;flex-direction:column;
    align-items:center;justify-content:center;line-height:1.1;color:#0e2408;font:800 16px 'Cinzel',Georgia,serif;
    background:linear-gradient(180deg,#8fe07a,#4faa3a);box-shadow:0 3px 0 #2f7a24}
  .musRec span{font:700 11px 'EB Garamond',Georgia,serif;color:#16330d}
  .musRec:active{transform:translateY(1px);box-shadow:0 2px 0 #2f7a24}
  .musRec:disabled{opacity:.4;box-shadow:0 3px 0 #2f5a24;cursor:default}
  .musClose{border:none;border-radius:9px;padding:9px 20px;background:#26344a;color:#cfe0f4;
    font:600 15px 'Cinzel',Georgia,serif;cursor:pointer}`;
  document.head.appendChild(s);
}

// Show the Muster overlay. `discount` is the Quartermaster recruitment multiplier
// (1 = full price). onClose fires when the player returns to the map.
export function openMuster(prog: Progress, discount: number, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'musScreen';
  const render = () => {
    root.innerHTML = `<div class="musTop"><button class="musClose">Done</button><h2>Muster the Host</h2><div class="musGold"><b>${prog.gold}</b> gold</div></div>`
      + `<div class="musHint">Recruit fresh companies into your standing army. They carry over between sieges and raids — the fallen do not, so keep your ranks full before you march.</div>`
      + `<div class="musBody">${ROSTER.map(r => {
        const price = recruitPrice(r.key, r.step, discount);
        return `<div class="musRow"><div class="musInfo"><div class="musName">${r.name}</div><div class="musDsc">${r.dsc}</div><div class="musOwn">In your host: ${prog.army[r.key]}</div></div>`
          + `<button class="musRec" data-k="${r.key}" ${prog.gold < price ? 'disabled' : ''}>+${r.step}<span>${price} gold</span></button></div>`;
      }).join('')}</div>`;
    root.querySelector('.musClose')!.addEventListener('click', () => { root.remove(); onClose(); });
    root.querySelectorAll<HTMLButtonElement>('.musRec').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.k as ArmyKey; const r = ROSTER.find(x => x.key === k)!; const price = recruitPrice(k, r.step, discount);
      if (prog.gold < price) return;
      prog.gold -= price; prog.army[k] += r.step; saveProgress(prog); render();
    }));
  };
  render();
  document.body.appendChild(root);
}
