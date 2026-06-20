// The Raids overlay: a list of optional side-battles you can storm for gold to
// fund recruitment. A styled DOM screen (no 3D map markers), reached from the
// world map. Picking one launches a normal battle against a small, weak holding.
import { Progress, Raid, raidResistance } from './campaign';

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement('style'); s.id = 'raid-styles';
  s.textContent = `
  .raidScreen{position:fixed;inset:0;z-index:50;background:linear-gradient(#15110a,#0b0805);
    color:#f2e6cf;font-family:'EB Garamond',Georgia,serif;display:flex;flex-direction:column;overflow:hidden}
  .raidTop{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;border-bottom:1px solid #5a4424}
  .raidTop h2{margin:0;font-size:22px;color:#ffe6a6;letter-spacing:.5px}
  .raidGold{font-size:17px;color:#ffd24a;font-weight:700;white-space:nowrap}
  .raidGold b{font-size:20px}
  .raidHint{font-size:12px;color:#a08c66;padding:9px 18px 6px;line-height:1.45}
  .raidBody{flex:1;overflow-y:auto;padding:8px 14px 28px}
  .raidCard{border:1px solid #5a4626;border-radius:13px;padding:13px 14px;background:#241a0f;margin-bottom:12px}
  .raidName{font-size:17px;color:#ffe6a6;font-weight:700;font-family:'Cinzel',Georgia,serif}
  .raidBlurb{font-size:13px;color:#cbb78f;line-height:1.4;margin:5px 0 10px}
  .raidMeta{display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:11px}
  .raidMeta .res{color:#d6b98a}
  .raidMeta .res b{color:#ffd98a}
  .raidReward{color:#ffd24a;font-weight:700}
  .raidGo{width:100%;border:none;border-radius:9px;padding:11px;cursor:pointer;
    font:700 15px 'Cinzel',Georgia,serif;color:#241600;background:linear-gradient(#caa33a,#9c7a22)}
  .raidGo:active{transform:translateY(1px)}
  .raidClose{border:none;border-radius:9px;padding:9px 18px;background:#3a2e1e;color:#ffe6a6;
    font:600 15px 'Cinzel',Georgia,serif;cursor:pointer}`;
  document.head.appendChild(s);
}

// Show the Raids overlay. onRaid fires with the chosen raid (and the overlay is
// torn down first); onClose fires when the player backs out to the map.
export function openRaids(prog: Progress, raids: Raid[], onRaid: (r: Raid) => void, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'raidScreen';
  root.innerHTML = `<div class="raidTop"><button class="raidClose">Back</button><h2>Raids</h2><div class="raidGold"><b>${prog.gold}</b> gold</div></div>`
    + `<div class="raidHint">Optional battles to fill the war chest. Win and the spoils are yours — but your dead don't return, so raid only what your army can break.</div>`
    + `<div class="raidBody">${raids.map(r => `<div class="raidCard"><div class="raidName">${r.name}</div>`
      + `<div class="raidBlurb">${r.blurb}</div>`
      + `<div class="raidMeta"><span class="res">Resistance: <b>${raidResistance(r.difficulty)}</b></span><span class="raidReward">+${r.reward} gold</span></div>`
      + `<button class="raidGo" data-id="${r.id}">Lead the Raid</button></div>`).join('')}</div>`;
  root.querySelector('.raidClose')!.addEventListener('click', () => { root.remove(); onClose(); });
  root.querySelectorAll<HTMLButtonElement>('.raidGo').forEach(b => b.addEventListener('click', () => {
    const r = raids.find(x => x.id === +b.dataset.id!); if (!r) return; root.remove(); onRaid(r);
  }));
  document.body.appendChild(root);
}
