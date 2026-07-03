// The front-of-house: a main menu with save slots, plus the settings and
// achievements screens. Self-contained styled DOM overlays (like muster.ts /
// upgrades.ts), driven by callbacks into main.ts.
import { CampaignCastle, slotSummary, deleteSlot, NUM_SLOTS } from './campaign';
import { Profile, ACHIEVEMENTS, DIFFICULTY, Difficulty } from './profile';
import { LOGO } from './logodata';
import { isDirectorEnabled, setDirectorEnabled } from './director';

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement('style'); s.id = 'menu-styles';
  s.textContent = `
  .menuScreen{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;overflow-y:auto;
    color:#f2e6cf;font-family:'EB Garamond',Georgia,serif;padding:calc(var(--safe-top) + 20px) 18px calc(var(--safe-bottom) + 24px);
    background:radial-gradient(125% 75% at 50% -8%,rgba(150,104,48,0.4),transparent 60%),linear-gradient(180deg,#241a0f,#120c07)}
  .menuScreen h1{margin:4px 0 2px;font:800 30px 'Cinzel',Georgia,serif;letter-spacing:1px;color:#ffe1a0;text-align:center;text-shadow:0 3px 12px rgba(0,0,0,.5)}
  .menuScreen .menuLogo{width:min(88vw,420px);height:auto;display:block;margin:6px auto 2px;filter:drop-shadow(0 8px 20px rgba(0,0,0,.6))}
  .menuScreen .msub{font-size:13px;font-style:italic;color:#c7a86e;margin-bottom:20px;text-align:center}
  .menuWrap{width:min(94vw,440px);display:flex;flex-direction:column;gap:12px}
  .slotCard{border:1px solid var(--leather-edge,#7a5e2e);border-radius:14px;padding:15px 16px;
    background:var(--grain),linear-gradient(180deg,rgba(74,54,28,0.85),rgba(36,26,14,0.9));box-shadow:var(--sh-2,0 6px 18px rgba(0,0,0,.5))}
  .slotCard .st{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .slotCard .sn{font:700 16px 'Cinzel',Georgia,serif;color:#ffe6a6}
  .slotCard .sd{font-size:12.5px;color:#d8c8a8;margin-top:3px;line-height:1.5}
  .slotCard .sd b{color:#ffd98a}
  .slotCard.empty .sd{color:#9a8760;font-style:italic}
  .slotCard .srow{display:flex;gap:9px;margin-top:12px}
  .mbtn{flex:1;border:none;border-radius:10px;min-height:44px;padding:11px 14px;cursor:pointer;font:700 14px 'Cinzel',Georgia,serif;line-height:1.1}
  .mbtn.play{background:linear-gradient(var(--gold-bright,#ffe27a),var(--gold-deep,#ffbe34));color:#2c1a06;box-shadow:var(--gold-drop,0 3px 0 #b07d16)}
  .mbtn.play:active{transform:translateY(2px)}
  .mbtn.ghost{flex:0 0 auto;background:rgba(120,88,45,0.2);border:1px solid #6a4f28;color:#e3d4ba}
  .mbtn.danger{flex:0 0 auto;background:rgba(120,40,36,0.25);border:1px solid #7a3030;color:#ffb0a0}
  .menuFoot{width:min(94vw,440px);display:flex;gap:10px;margin-top:18px}
  .menuFoot .mbtn{background:rgba(120,88,45,0.18);border:1px solid #6a4f28;color:#e9d9b8}
  .menuStats{width:min(94vw,440px);margin-top:16px;display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:center;font-size:12px;color:#b6a079}
  .menuStats b{color:#ffd98a}
  /* settings + achievements share the panel look */
  .ovPanel{position:fixed;inset:0;z-index:64;display:flex;flex-direction:column;align-items:center;overflow-y:auto;
    color:#f2e6cf;font-family:'EB Garamond',Georgia,serif;padding:calc(var(--safe-top) + 18px) 18px calc(var(--safe-bottom) + 24px);
    background:radial-gradient(125% 75% at 50% -8%,rgba(150,104,48,0.34),transparent 60%),linear-gradient(180deg,#221810,#0f0a06)}
  .ovPanel h2{margin:2px 0 16px;font:800 24px 'Cinzel',Georgia,serif;color:#ffe1a0;letter-spacing:1px}
  .ovBox{width:min(94vw,440px);display:flex;flex-direction:column;gap:14px}
  .setRow{border:1px solid #5a4626;border-radius:12px;padding:13px 15px;background:linear-gradient(180deg,rgba(74,54,28,0.6),rgba(30,22,12,0.7))}
  .setRow .lbl{font:700 14px 'Cinzel',Georgia,serif;color:#ffe6a6;margin-bottom:9px}
  .setRow input[type=range]{width:100%;accent-color:#e7b64c}
  .diffPick{display:flex;gap:8px}
  .diffPick .dchip{flex:1;border:1px solid #5a4626;background:#1a120a;color:#cbb488;border-radius:9px;padding:9px 4px;cursor:pointer;text-align:center;font:700 13px 'Cinzel',Georgia,serif}
  .diffPick .dchip.on{border-color:#e7b64c;background:#3a2a12;color:#ffe0a0}
  .setRow .dblurb{font-size:11.5px;font-style:italic;color:#b6a079;margin-top:8px;min-height:16px}
  .toggle{display:flex;align-items:center;justify-content:space-between}
  .toggle .sw{width:52px;height:30px;border-radius:16px;background:#2a2013;border:1px solid #5a4626;position:relative;cursor:pointer}
  .toggle .sw.on{background:#3f7a37}
  .toggle .sw i{position:absolute;top:2px;left:2px;width:24px;height:24px;border-radius:50%;background:#e9d9b8;transition:left .15s}
  .toggle .sw.on i{left:24px}
  .achGrid{width:min(94vw,440px);display:flex;flex-direction:column;gap:9px}
  .achCard{display:flex;align-items:center;gap:12px;border:1px solid #4a3a1e;border-radius:11px;padding:11px 13px;background:rgba(30,22,12,0.6)}
  .achCard.got{border-color:#7a5e2e;background:linear-gradient(180deg,rgba(74,54,28,0.55),rgba(30,22,12,0.6))}
  .achCard .amark{flex:0 0 30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;
    background:#241a0f;border:1px solid #4a3a1e;color:#5d4e30}
  .achCard.got .amark{background:radial-gradient(circle at 40% 32%,#ffe27a,#c8901f);color:#3a2708;border-color:#e7b64c}
  .achCard .an{font:700 14px 'Cinzel',Georgia,serif;color:#e9d9b8}
  .achCard.got .an{color:#ffe6a6}
  .achCard .ad{font-size:12px;color:#b6a079}
  .ovClose{width:min(94vw,440px);margin-top:18px;border:1px solid #6a4f28;border-radius:11px;min-height:46px;padding:12px;cursor:pointer;
    font:700 15px 'Cinzel',Georgia,serif;color:#ffe0a4;background:linear-gradient(180deg,rgba(64,46,24,0.95),rgba(30,21,11,0.95))}`;
  document.head.appendChild(s);
}

export function openMainMenu(opts: {
  castles: CampaignCastle[]; profile: Profile;
  onPlay: (slot: number, isNew: boolean) => void; onSettings: () => void; onAchievements: () => void;
}) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'menuScreen';
  const render = () => {
    const slots = Array.from({ length: NUM_SLOTS }, (_, n) => slotSummary(n, opts.castles));
    const L = opts.profile.lifetime;
    root.innerHTML = `<img class="menuLogo" src="${LOGO}" alt="Castle Hassle"><div class="msub">Choose your crusade</div><div class="menuWrap">`
      + slots.map((s, n) => {
        if (!s) return `<div class="slotCard empty"><div class="st"><span class="sn">Campaign ${n + 1}</span></div>`
          + `<div class="sd">An empty banner, awaiting a lord.</div>`
          + `<div class="srow"><button class="mbtn play" data-new="${n}">Begin New Crusade</button></div></div>`;
        return `<div class="slotCard"><div class="st"><span class="sn">Campaign ${n + 1}</span></div>`
          + `<div class="sd"><b>${s.realm}</b> · ${s.taken}/${s.total} castles taken · <b>${s.gold.toLocaleString()}</b> gold · ${s.men.toLocaleString()} men</div>`
          + `<div class="srow"><button class="mbtn play" data-cont="${n}">Continue</button><button class="mbtn danger" data-del="${n}">Erase</button></div></div>`;
      }).join('')
      + `</div><div class="menuFoot"><button class="mbtn" id="mnSettings">Settings</button><button class="mbtn" id="mnAch">Honours</button></div>`
      + `<div class="menuStats"><span>Castles taken: <b>${L.castlesTaken}</b></span><span>Foes slain: <b>${L.kills.toLocaleString()}</b></span><span>Battles won: <b>${L.battlesWon}</b></span><span>Crusades: <b>${L.campaignsWon}</b></span></div>`;
    root.querySelectorAll<HTMLButtonElement>('[data-new]').forEach(b => b.addEventListener('click', () => { root.remove(); opts.onPlay(+b.dataset.new!, true); }));
    root.querySelectorAll<HTMLButtonElement>('[data-cont]').forEach(b => b.addEventListener('click', () => { root.remove(); opts.onPlay(+b.dataset.cont!, false); }));
    root.querySelectorAll<HTMLButtonElement>('[data-del]').forEach(b => b.addEventListener('click', () => { if (confirm(`Erase Campaign ${+b.dataset.del! + 1}? This cannot be undone.`)) { deleteSlot(+b.dataset.del!); render(); } }));
    root.querySelector('#mnSettings')!.addEventListener('click', () => opts.onSettings());
    root.querySelector('#mnAch')!.addEventListener('click', () => opts.onAchievements());
  };
  render();
  document.body.appendChild(root);
  return { close: () => root.remove() };
}

export function openSettings(profile: Profile, onChange: () => void, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'ovPanel';
  const S = profile.settings;
  const diffChips = (Object.keys(DIFFICULTY) as Difficulty[]).map(k => `<div class="dchip${S.difficulty === k ? ' on' : ''}" data-d="${k}">${DIFFICULTY[k].label}</div>`).join('');
  root.innerHTML = `<h2>Settings</h2><div class="ovBox">`
    + `<div class="setRow"><div class="lbl">Master Volume</div><input type="range" id="stVol" min="0" max="100" value="${Math.round(S.volume * 100)}"></div>`
    + `<div class="setRow"><div class="toggle"><span class="lbl" style="margin:0">Sound</span><div class="sw${S.muted ? '' : ' on'}" id="stMute"><i></i></div></div></div>`
    + `<div class="setRow"><div class="lbl">Difficulty</div><div class="diffPick">${diffChips}</div><div class="dblurb" id="stDiffBlurb">${DIFFICULTY[S.difficulty].blurb}</div></div>`
    + `<div class="setRow"><div class="toggle"><span class="lbl" style="margin:0">Director Mode</span><div class="sw${isDirectorEnabled() ? ' on' : ''}" id="stDirector"><i></i></div></div><div class="dblurb">A 🎬 chip for filming promos: orbit, auto-cine, hide the HUD.</div></div>`
    + `</div><button class="ovClose" id="stDone">Done</button>`;
  document.body.appendChild(root);
  const vol = root.querySelector('#stVol') as HTMLInputElement;
  vol.addEventListener('input', () => { S.volume = vol.valueAsNumber / 100; onChange(); });
  root.querySelector('#stMute')!.addEventListener('click', () => { S.muted = !S.muted; (root.querySelector('#stMute') as HTMLElement).classList.toggle('on', !S.muted); onChange(); });
  root.querySelector('#stDirector')!.addEventListener('click', () => { const on = !isDirectorEnabled(); setDirectorEnabled(on); (root.querySelector('#stDirector') as HTMLElement).classList.toggle('on', on); });
  root.querySelectorAll<HTMLElement>('.dchip').forEach(c => c.addEventListener('click', () => {
    S.difficulty = c.dataset.d as Difficulty;
    root.querySelectorAll('.dchip').forEach(x => x.classList.toggle('on', x === c));
    (root.querySelector('#stDiffBlurb') as HTMLElement).textContent = DIFFICULTY[S.difficulty].blurb;
    onChange();
  }));
  root.querySelector('#stDone')!.addEventListener('click', () => { root.remove(); onClose(); });
}

export function openAchievements(profile: Profile, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'ovPanel';
  const L = profile.lifetime;
  root.innerHTML = `<h2>Honours</h2>`
    + `<div class="menuStats" style="margin-bottom:16px"><span>Castles: <b>${L.castlesTaken}</b></span><span>Slain: <b>${L.kills.toLocaleString()}</b></span><span>Raids: <b>${L.raidsWon}</b></span><span>Spoils: <b>${L.goldEarned.toLocaleString()}</b>g</span><span>Lost: <b>${L.menLost.toLocaleString()}</b></span></div>`
    + `<div class="achGrid">${ACHIEVEMENTS.map(a => { const got = profile.achievements.includes(a.id); return `<div class="achCard${got ? ' got' : ''}"><div class="amark">${got ? '★' : '·'}</div><div><div class="an">${a.name}</div><div class="ad">${a.desc}</div></div></div>`; }).join('')}</div>`
    + `<button class="ovClose" id="achDone">Done</button>`;
  document.body.appendChild(root);
  root.querySelector('#achDone')!.addEventListener('click', () => { root.remove(); onClose(); });
}
