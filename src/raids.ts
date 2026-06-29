// The Raids overlay: a list of optional side-battles you can storm for gold to
// fund recruitment. A styled DOM screen (no 3D map markers), reached from the
// world map. Picking one launches a normal battle against a small, weak holding.
import { Progress, Raid, raidResistance } from './campaign';

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement('style'); s.id = 'raid-styles';
  s.textContent = `
  .raidScreen{position:fixed;inset:0;z-index:50;color:#f2e6cf;font-family:'EB Garamond',Georgia,serif;display:flex;flex-direction:column;overflow:hidden;
    background:radial-gradient(125% 70% at 50% -8%,rgba(150,80,48,0.36),transparent 58%),repeating-linear-gradient(50deg,rgba(255,235,190,0.02) 0 2px,rgba(0,0,0,0.03) 2px 4px),linear-gradient(180deg,#291810,#160d07)}
  .raidTop{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:calc(var(--safe-top) + 14px) 62px 12px 16px;border-bottom:1px solid #6a4428}
  .raidTop h2{margin:0;display:inline-flex}
  .raidGold{display:flex;align-items:center;gap:6px;font-size:var(--fs-heading);color:var(--gold-soft);font-weight:700;white-space:nowrap;
    padding:6px 14px;border-radius:var(--r-pill);background:linear-gradient(180deg,rgba(64,46,24,0.95),rgba(30,21,11,0.95));border:1px solid rgba(255,225,160,0.3);box-shadow:var(--sh-1),inset 0 1px 0 rgba(255,235,190,0.18)}
  .raidGold b{font-size:var(--fs-title);color:#ffd24a}
  .raidHint{font-size:var(--fs-label);color:#b6a079;padding:11px 18px 6px;line-height:1.45}
  .raidBody{flex:1;overflow-y:auto;padding:8px 14px 28px}
  .raidCard{border:1px solid #6a5230;border-top:1px solid rgba(255,225,160,0.2);border-left:3px solid #c2503a;border-radius:var(--r-lg);padding:14px 15px;margin-bottom:13px;
    background:repeating-linear-gradient(50deg,rgba(255,235,190,0.02) 0 2px,rgba(0,0,0,0.03) 2px 4px),linear-gradient(180deg,#46331c,#241809);
    box-shadow:0 5px 15px rgba(0,0,0,0.36),inset 0 1px 0 rgba(255,225,160,0.1)}
  .raidName{font-size:var(--fs-heading);color:#ffe6a6;font-weight:700;font-family:'Cinzel',Georgia,serif}
  .raidBlurb{font-size:var(--fs-label);color:#d3bd92;line-height:1.4;margin:5px 0 11px}
  .raidMeta{display:flex;justify-content:space-between;align-items:center;font-size:var(--fs-label);margin-bottom:12px}
  .raidMeta .res{color:#d6b98a}
  .raidMeta .res b{color:#ffd98a}
  .raidReward{display:inline-flex;align-items:center;gap:5px;color:#2c1a06;font-weight:800;font-family:'Cinzel',Georgia,serif;font-size:var(--fs-label);
    padding:4px 12px;border-radius:var(--r-pill);background:linear-gradient(180deg,var(--gold-bright),var(--gold-deep));border-top:1px solid #fff1c4;box-shadow:0 2px 5px rgba(0,0,0,0.3)}
  .raidGo{width:100%;border:none;border-top:1px solid rgba(255,180,150,0.5);border-radius:var(--r-md);min-height:46px;padding:13px;cursor:pointer;
    font:800 var(--fs-body) 'Cinzel',Georgia,serif;letter-spacing:.4px;color:#ffe7dd;background:radial-gradient(circle at 42% 28%,#b54632,#6f261c);box-shadow:0 4px 0 #4a160e,var(--sh-1)}
  .raidGo:active{transform:translateY(2px);box-shadow:0 2px 0 #4a160e}
  .raidClose{border:1px solid rgba(255,225,160,0.22);border-radius:var(--r-md);min-height:44px;padding:9px 16px;color:var(--gold-soft);
    font:700 var(--fs-body) 'Cinzel',Georgia,serif;cursor:pointer;background:linear-gradient(180deg,rgba(64,46,24,0.95),rgba(30,21,11,0.95));box-shadow:var(--sh-1),inset 0 1px 0 rgba(255,235,190,0.12)}
  .raidClose:active{transform:translateY(1px)}`;
  document.head.appendChild(s);
}

// Show the Raids overlay. onRaid fires with the chosen raid (and the overlay is
// torn down first); onClose fires when the player backs out to the map.
export function openRaids(prog: Progress, raids: Raid[], onRaid: (r: Raid) => void, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'raidScreen';
  root.innerHTML = `<div class="raidTop"><button class="raidClose">Back</button><h2><span class="gameRibbon crim">Raids</span></h2><div class="raidGold"><b>${prog.gold}</b> gold</div></div>`
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
