// Hidden developer panel. Reached from the campaign map (the ⚙ chip) or by
// secret-tapping the in-battle perf bar 5×. Three decks:
//   • Live Telemetry  — fps, sim/gfx ms, draw calls, heap, unit/assault counts.
//   • Campaign god-tools — gold, castle unlocks, per-arm veterancy ranks, save
//     reset, jump-to-castle, and a conquest-flourish preview.
//   • Battle Lab      — stage any scenario on-device (army, difficulty, seed,
//     every castle-style knob) and optionally fold in your real campaign
//     progression (War Council buffs + veterancy).
// Pure DOM; all stateful actions are delegated to main.ts through hooks, so the
// panel stays decoupled from the sim/renderer/campaign save.
import type { CastleStyle } from './sim';

export interface DevConfig {
  army: { heavy: number; light: number; archer: number; cavalry: number; siege: number };
  difficulty: number;
  seed: number;
  style: CastleStyle;
  autoBegin: boolean;
  progression: boolean; // apply the player's real War Council buffs + arm veterancy
}

// A snapshot of campaign state the panel renders, and the levers it can pull.
export interface DevCampaignState {
  gold: number;
  unlocked: number;
  completed: number;
  totalCastles: number;
  realm: string;
  vet: { key: string; name: string; rank: number; title: string; kills: number }[];
  castles: { id: number; name: string; done: boolean; locked: boolean }[];
}
export interface DevCampaign {
  state: () => DevCampaignState;
  setGold: (g: number) => void;
  addGold: (d: number) => void;
  unlockAll: () => void;
  completeRealm: () => void;
  resetProgress: () => void;
  bumpVet: (key: string, dir: number) => void;
  maxVet: () => void;
  resetVet: () => void;
  enterCastle: (id: number) => void;
  previewConquest: () => void;
}

export interface DevBalance {
  host: () => { men: number; engines: number; note: string };
  rows: () => { id: number; name: string; garrison: number; ratio: number; band: string; done: boolean; unlocked: boolean }[];
}
export interface DevHooks {
  // returns ordered [label, value] telemetry rows, refreshed ~5x/sec while open
  getTelemetry: () => [string, string][];
  launch: (cfg: DevConfig) => void;
  // full diagnostic text for the Copy/Export button (shared with the dev)
  exportText: () => string;
  campaign?: DevCampaign; // optional — present when the campaign save is available
  balance?: DevBalance;   // optional — the force-ratio curve across the campaign
}

const css = `
#devPanel{position:fixed;inset:0;z-index:200;display:none;flex-direction:column;
  background:linear-gradient(180deg,#0c0f16,#05070b);color:#d8e0ea;
  font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-y:auto;
  padding:calc(var(--safe-top,0px) + 12px) 14px calc(var(--safe-bottom,0px) + 20px)}
#devPanel.show{display:flex}
#devPanel h2{font:700 17px 'Cinzel',Georgia,serif;color:#7fe0a0;letter-spacing:.5px;margin:0}
#devPanel .dpHead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
#devPanel .dpClose{border:1px solid #3a4456;background:#161c27;color:#cdd6e2;border-radius:8px;
  padding:8px 16px;font:700 14px 'Cinzel',serif;cursor:pointer}
#devPanel .dpSec{border:1px solid #232c3a;border-radius:10px;padding:11px 12px;margin-bottom:12px;background:#0e131c}
#devPanel .dpSec h3{margin:0 0 8px;font:700 12px ui-monospace,monospace;letter-spacing:1.5px;color:#6f8aa8;text-transform:uppercase}
#devPanel .dpSec h3.mt{margin-top:13px}
#devTel{display:grid;grid-template-columns:1fr 1fr;gap:3px 16px}
#devTel .k{color:#7f93ab}#devTel .v{color:#bfe9c8;text-align:right;font-weight:700}
#devTel .v.warn{color:#ffd24a}#devTel .v.bad{color:#ff7a5c}
#devPanel .row{display:flex;align-items:center;gap:9px;margin:7px 0}
#devPanel .row label{flex:0 0 116px;color:#9fb0c6}
#devPanel .row input[type=number]{width:84px}
#devPanel input[type=number],#devPanel select{background:#070a0f;color:#e6edf5;border:1px solid #2c3647;
  border-radius:7px;padding:8px 9px;font:600 14px ui-monospace,monospace}
#devPanel select{flex:1;min-width:0}
#devPanel input[type=range]{flex:1;accent-color:#7fe0a0}
#devPanel .rngv{flex:0 0 52px;text-align:right;color:#bfe9c8;font-weight:700}
#devPanel .chips{display:flex;flex-wrap:wrap;gap:7px}
#devPanel .chip{border:1px solid #2c3647;background:#0a0e15;color:#9fb0c6;border-radius:18px;
  padding:7px 13px;cursor:pointer;font-weight:700;user-select:none}
#devPanel .chip.on{border-color:#7fe0a0;background:#13301f;color:#9ff0bb}
#devPanel .presets{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:4px}
#devPanel .preset{border:1px solid #3a4456;background:#161c27;color:#cdd6e2;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:700}
#devPanel .preset.danger{border-color:#7a3030;color:#ffb0a0;background:#241314}
#devPanel .preset.gold{border-color:#7a5e22;color:#ffd98a;background:#241d0e}
#devPanel .dpGo{width:100%;margin-top:6px;border:none;border-radius:11px;padding:15px;cursor:pointer;
  font:800 17px 'Cinzel',serif;color:#06210f;background:linear-gradient(180deg,#9ff0a8,#3fbf63);box-shadow:0 4px 0 #2a8044}
#devPanel .dpGo:active{transform:translateY(2px);box-shadow:0 2px 0 #2a8044}
#devPanel .dice{border:1px solid #2c3647;background:#0a0e15;color:#bfe9c8;border-radius:7px;padding:8px 11px;cursor:pointer;font-weight:700}
#devPanel .hint{color:#5d6e84;font-size:11px;margin-top:3px}
#devPanel .dpInfo{color:#9fb0c6;font-size:12px;margin:4px 0 9px;line-height:1.5}
#devPanel .dpInfo b{color:#bfe9c8}
#devPanel .dpBtns{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:6px}
#devPanel .vetRow{display:flex;align-items:center;gap:9px;margin:6px 0;padding:5px 8px;border:1px solid #1d2530;border-radius:8px;background:#0a0e15}
#devPanel .vetRow .vn{flex:0 0 84px;color:#cdd6e2;font-weight:700}
#devPanel .vetRow .vt{flex:1;color:#ffd98a;font-size:12px}
#devPanel .vetRow .vt .st{color:#c8901f;letter-spacing:1px;margin-right:3px}
#devPanel .vetRow .vk{flex:0 0 auto;color:#7f93ab;font-size:11px}
#devPanel .vbtn{border:1px solid #2c3647;background:#11161f;color:#9ff0bb;border-radius:6px;width:30px;height:30px;cursor:pointer;font-weight:800;font-size:16px;line-height:1}
  #devPanel .balRows{display:flex;flex-direction:column;gap:2px;margin-top:8px}
  #devPanel .balRow{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:2px 1px}
  #devPanel .balRow.done{opacity:.45}
  #devPanel .balRow .bi{flex:0 0 20px;color:#5d6e84;text-align:right;font-variant-numeric:tabular-nums}
  #devPanel .balRow .bn{flex:1;min-width:0;color:#cdd6e2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #devPanel .balRow .bg{flex:0 0 42px;text-align:right;color:#9fb0c6;font-variant-numeric:tabular-nums}
  #devPanel .balRow .bbar{flex:0 0 56px;height:7px;border-radius:4px;background:#0a0e15;overflow:hidden}
  #devPanel .balRow .bbar>i{display:block;height:100%;border-radius:4px}
  #devPanel .balRow .bv{flex:0 0 92px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}`;

const PRESETS: { name: string; army: DevConfig['army']; diff: number }[] = [
  { name: 'Standard 2k', army: { heavy: 600, light: 480, archer: 460, cavalry: 220, siege: 8 }, diff: 1.6 },
  { name: 'Big 5k', army: { heavy: 1500, light: 1200, archer: 1000, cavalry: 700, siege: 12 }, diff: 2.5 },
  { name: 'Massive 10k', army: { heavy: 3000, light: 2600, archer: 2200, cavalry: 1500, siege: 16 }, diff: 3.5 },
  { name: 'Insane 18k', army: { heavy: 5200, light: 4600, archer: 4000, cavalry: 3000, siege: 24 }, diff: 5 },
];

export function initDevPanel(hooks: DevHooks) {
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  const el = document.createElement('div'); el.id = 'devPanel';

  const arm = (id: string, label: string, val: number) =>
    `<div class="row"><label>${label}</label><input type="number" id="dp_${id}" value="${val}" min="0" max="40000" step="10"></div>`;
  const rng = (id: string, label: string, min: number, max: number, step: number, val: number) =>
    `<div class="row"><label>${label}</label><input type="range" id="dp_${id}" min="${min}" max="${max}" step="${step}" value="${val}"><span class="rngv" id="dpv_${id}">${val}</span></div>`;
  const chip = (id: string, label: string, on: boolean) => `<div class="chip${on ? ' on' : ''}" id="dp_${id}" data-on="${on}">${label}</div>`;

  el.innerHTML = `
    <div class="dpHead"><h2>DEV — Battle Lab</h2><div style="display:flex;gap:8px"><button class="dpClose" id="dpCopy" style="border-color:#7fe0a0;color:#9ff0bb">Copy</button><button class="dpClose" id="dpClose">Close</button></div></div>
    <div class="dpSec"><h3>Live Telemetry <span id="dpCopied" style="color:#7fe0a0;font-weight:400;font-size:11px"></span></h3><div id="devTel"></div></div>
    <div class="dpSec" id="dpCampaign" style="display:none"></div>
    <div class="dpSec" id="dpBalance" style="display:none"></div>
    <div class="dpSec"><h3>Presets</h3><div class="presets" id="dpPresets">${PRESETS.map((p, i) => `<div class="preset" data-i="${i}">${p.name}</div>`).join('')}</div></div>
    <div class="dpSec"><h3>Army</h3>
      ${arm('heavy', 'Heavy Inf', 1500)}${arm('light', 'Light Inf', 1200)}${arm('archer', 'Archers', 1000)}
      ${arm('cavalry', 'Cavalry', 700)}${arm('siege', 'Trebuchets', 12)}
    </div>
    <div class="dpSec"><h3>Battle</h3>
      ${rng('diff', 'Difficulty', 0.5, 6, 0.1, 2.5)}
      <div class="row"><label>Seed</label><input type="number" id="dp_seed" value="777" min="0" max="999999"><button class="dice" id="dpDice">roll</button></div>
      <div class="hint">Difficulty drives garrison size, archer damage and keep guard.</div>
    </div>
    <div class="dpSec"><h3>Castle Style</h3>
      ${rng('scale', 'Footprint', 0.6, 1.6, 0.05, 1.1)}
      ${rng('aspect', 'Aspect W/D', 0.7, 2.2, 0.05, 1.1)}
      ${rng('town', 'Bailey density', 0, 1, 0.05, 0.6)}
      <div class="row"><label>Outer shape</label><select id="dp_shape"><option value="rect">Rect</option><option value="barbican">Barbican</option><option value="twin">Twin bailey</option></select></div>
      <div class="chips" style="margin-top:8px">
        ${chip('concentric', 'Concentric walls', false)}${chip('round', 'Round towers', false)}
        ${chip('strongKeep', 'Strong citadel', true)}${chip('palisade', 'Palisade (raid)', false)}
      </div>
    </div>
    <div class="dpSec"><h3>Launch</h3>
      <div class="chips">
        ${chip('autoBegin', 'Auto-begin assault', true)}
        ${chip('progression', 'Use my buffs + veterancy', false)}
      </div>
      <button class="dpGo" id="dpLaunch">Launch Battle</button>
      <div class="hint">Builds a fresh Sim with these exact variables and drops you into it.</div>
    </div>`;
  document.body.appendChild(el);

  const $ = (id: string) => el.querySelector('#' + id) as HTMLElement;
  const num = (id: string) => parseFloat(($('dp_' + id) as HTMLInputElement).value) || 0;
  const chipOn = (id: string) => ($('dp_' + id) as HTMLElement).dataset.on === 'true';
  const setChip = (id: string, on: boolean) => { const c = $('dp_' + id); c.dataset.on = String(on); c.classList.toggle('on', on); };

  // range value labels
  for (const id of ['diff', 'scale', 'aspect', 'town']) {
    const inp = $('dp_' + id) as HTMLInputElement;
    inp.addEventListener('input', () => { ($('dpv_' + id) as HTMLElement).textContent = inp.value; });
  }
  // chip toggles
  for (const id of ['concentric', 'round', 'strongKeep', 'palisade', 'autoBegin', 'progression'])
    $('dp_' + id).addEventListener('click', () => setChip(id, !chipOn(id)));
  $('dpDice').addEventListener('click', () => { ($('dp_seed') as HTMLInputElement).value = String((Math.random() * 999999) | 0); });
  // presets
  el.querySelectorAll('#dpPresets .preset').forEach(p => p.addEventListener('click', () => {
    const pr = PRESETS[Number((p as HTMLElement).dataset.i)];
    for (const k of ['heavy', 'light', 'archer', 'cavalry', 'siege'] as const) ($('dp_' + k) as HTMLInputElement).value = String(pr.army[k]);
    const d = $('dp_diff') as HTMLInputElement; d.value = String(pr.diff); ($('dpv_diff') as HTMLElement).textContent = String(pr.diff);
  }));

  const close = () => { el.classList.remove('show'); if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  $('dpClose').addEventListener('click', close);
  $('dpCopy').addEventListener('click', async () => {
    const txt = hooks.exportText();
    const note = $('dpCopied'); const done = () => { note.textContent = 'copied!'; setTimeout(() => (note.textContent = ''), 2500); };
    try { await navigator.clipboard.writeText(txt); done(); }
    catch { // clipboard blocked — fall back to a selectable prompt
      const ta = document.createElement('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;inset:10% 5%;width:90%;height:70%;z-index:300';
      el.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch { note.textContent = 'select + copy manually'; }
      setTimeout(() => ta.remove(), 6000);
    }
  });
  $('dpLaunch').addEventListener('click', () => {
    hooks.launch({
      army: { heavy: num('heavy'), light: num('light'), archer: num('archer'), cavalry: num('cavalry'), siege: num('siege') },
      difficulty: num('diff'), seed: num('seed') | 0,
      style: {
        scale: num('scale'), aspect: num('aspect'), town: num('town'),
        concentric: chipOn('concentric'), round: chipOn('round'), strongKeep: chipOn('strongKeep'),
        palisade: chipOn('palisade'), shape: ($('dp_shape') as HTMLSelectElement).value as CastleStyle['shape'],
      },
      autoBegin: chipOn('autoBegin'), progression: chipOn('progression'),
    });
    close();
  });

  // ---- Campaign god-tools (rendered only when the save is reachable) ----
  const renderCampaign = () => {
    const cp = hooks.campaign; if (!cp) return;
    const s = cp.state();
    const sec = $('dpCampaign'); sec.style.display = 'block';
    sec.innerHTML = `<h3>Campaign — God Tools</h3>
      <div class="row"><label>Gold</label><input type="number" id="dp_gold" value="${s.gold}" min="0" max="9999999">
        <button class="dice" id="dpGoldSet">set</button><button class="dice" id="dpGold500">+500</button><button class="dice" id="dpGold2k">+2k</button></div>
      <div class="dpInfo">Realm: <b>${s.realm}</b> · <b>${s.completed}/${s.totalCastles}</b> castles taken · next unlocked <b>#${s.unlocked}</b></div>
      <div class="dpBtns">
        <button class="preset gold" id="dpUnlockAll">Unlock all</button>
        <button class="preset gold" id="dpCompleteRealm">Complete realm</button>
        <button class="preset gold" id="dpPreviewConq">Preview conquest</button>
        <button class="preset danger" id="dpResetProg">Reset save</button>
      </div>
      <div class="row"><label>Jump to siege</label><select id="dp_jump">${s.castles.map(c => `<option value="${c.id}">${c.done ? '✓ ' : c.locked ? '· ' : '» '}${c.name}</option>`).join('')}</select><button class="dice" id="dpJumpGo">go</button></div>
      <h3 class="mt">Veterancy</h3>
      <div class="dpBtns"><button class="preset gold" id="dpMaxVet">Max all</button><button class="preset danger" id="dpResetVet">Reset all</button></div>
      ${s.vet.map(v => `<div class="vetRow"><span class="vn">${v.name}</span><span class="vt">${v.rank > 0 ? `<span class="st">${'★'.repeat(v.rank)}</span>` : ''}${v.title}</span><span class="vk">${v.kills.toLocaleString()} kills</span><button class="vbtn" data-k="${v.key}" data-d="-1">−</button><button class="vbtn" data-k="${v.key}" data-d="1">+</button></div>`).join('')}`;

    const gold = () => parseInt(($('dp_gold') as HTMLInputElement).value, 10) || 0;
    $('dpGoldSet').addEventListener('click', () => { cp.setGold(gold()); renderCampaign(); });
    $('dpGold500').addEventListener('click', () => { cp.addGold(500); renderCampaign(); });
    $('dpGold2k').addEventListener('click', () => { cp.addGold(2000); renderCampaign(); });
    $('dpUnlockAll').addEventListener('click', () => { cp.unlockAll(); renderCampaign(); });
    $('dpCompleteRealm').addEventListener('click', () => { cp.completeRealm(); renderCampaign(); });
    $('dpResetProg').addEventListener('click', () => { if (confirm('Reset all campaign progress?')) { cp.resetProgress(); renderCampaign(); } });
    $('dpPreviewConq').addEventListener('click', () => { close(); cp.previewConquest(); });
    $('dpJumpGo').addEventListener('click', () => { close(); cp.enterCastle(parseInt(($('dp_jump') as HTMLSelectElement).value, 10) || 0); });
    $('dpMaxVet').addEventListener('click', () => { cp.maxVet(); renderCampaign(); });
    $('dpResetVet').addEventListener('click', () => { cp.resetVet(); renderCampaign(); });
    sec.querySelectorAll<HTMLButtonElement>('.vbtn').forEach(b => b.addEventListener('click', () => { cp.bumpVet(b.dataset.k!, parseInt(b.dataset.d!, 10)); renderCampaign(); }));
  };

  // ---- Balance readout: the force-ratio curve across the whole campaign ----
  const BAND_COLOR: Record<string, string> = { Rout: '#7fe0a0', Strong: '#8fd0c0', Even: '#e6c84a', Costly: '#e89a4a', Grim: '#ff7a5c' };
  const renderBalance = () => {
    const b = hooks.balance; if (!b) return;
    const rows = b.rows(), h = b.host(), sec = $('dpBalance'); sec.style.display = 'block';
    const tally: Record<string, number> = {}; for (const r of rows) tally[r.band] = (tally[r.band] || 0) + 1;
    const sum = ['Grim', 'Costly', 'Even', 'Strong', 'Rout'].filter(k => tally[k]).map(k => `<b style="color:${BAND_COLOR[k]}">${tally[k]} ${k}</b>`).join(' · ');
    sec.innerHTML = `<h3>Balance Readout <span style="color:#5d6e84;font-weight:400;font-size:10px;letter-spacing:0">your host vs each castle</span></h3>`
      + `<div class="dpInfo">${h.note}</div><div class="dpInfo">${sum}</div>`
      + `<div class="balRows">${rows.map(r => {
        const pct = Math.max(4, Math.min(100, r.ratio / 3 * 100)), col = BAND_COLOR[r.band] || '#8899aa';
        return `<div class="balRow${r.done ? ' done' : ''}"><span class="bi">${r.id}</span><span class="bn">${r.name}</span>`
          + `<span class="bg">${r.garrison.toLocaleString()}</span><span class="bbar"><i style="width:${pct.toFixed(0)}%;background:${col}"></i></span>`
          + `<span class="bv" style="color:${col}">${r.ratio.toFixed(2)}× ${r.band}</span></div>`;
      }).join('')}</div>`;
  };

  const tel = $('devTel');
  let raf = 0;
  const tick = () => {
    const rows = hooks.getTelemetry();
    tel.innerHTML = rows.map(([k, v]) => {
      let cls = 'v';
      if (k === 'fps') { const n = parseFloat(v); if (n < 20) cls = 'v bad'; else if (n < 40) cls = 'v warn'; }
      return `<div class="k">${k}</div><div class="${cls}">${v}</div>`;
    }).join('');
    raf = requestAnimationFrame(tick);
  };

  const open = () => { el.classList.add('show'); if (hooks.campaign) renderCampaign(); if (hooks.balance) renderBalance(); if (!raf) tick(); };
  return { open, close, toggle: () => (el.classList.contains('show') ? close() : open()) };
}
