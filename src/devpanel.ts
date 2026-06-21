// Hidden developer panel: secret-tap the perf bar 5x to open. Gives a live
// telemetry readout (fps, sim/gfx ms, draw calls, heap, unit counts, …) and a
// full battle builder so any scenario can be staged on-device — army make-up,
// difficulty, seed, and every castle-style knob. Pure DOM, no game imports
// beyond the CastleStyle type, so it stays decoupled from the sim/renderer.
import type { CastleStyle } from './sim';

export interface DevConfig {
  army: { heavy: number; light: number; archer: number; cavalry: number; siege: number };
  difficulty: number;
  seed: number;
  style: CastleStyle;
  autoBegin: boolean;
}
export interface DevHooks {
  // returns ordered [label, value] telemetry rows, refreshed ~5x/sec while open
  getTelemetry: () => [string, string][];
  launch: (cfg: DevConfig) => void;
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
#devTel{display:grid;grid-template-columns:1fr 1fr;gap:3px 16px}
#devTel .k{color:#7f93ab}#devTel .v{color:#bfe9c8;text-align:right;font-weight:700}
#devTel .v.warn{color:#ffd24a}#devTel .v.bad{color:#ff7a5c}
#devPanel .row{display:flex;align-items:center;gap:9px;margin:7px 0}
#devPanel .row label{flex:0 0 116px;color:#9fb0c6}
#devPanel .row input[type=number]{width:84px}
#devPanel input[type=number],#devPanel select{background:#070a0f;color:#e6edf5;border:1px solid #2c3647;
  border-radius:7px;padding:8px 9px;font:600 14px ui-monospace,monospace}
#devPanel input[type=range]{flex:1;accent-color:#7fe0a0}
#devPanel .rngv{flex:0 0 52px;text-align:right;color:#bfe9c8;font-weight:700}
#devPanel .chips{display:flex;flex-wrap:wrap;gap:7px}
#devPanel .chip{border:1px solid #2c3647;background:#0a0e15;color:#9fb0c6;border-radius:18px;
  padding:7px 13px;cursor:pointer;font-weight:700;user-select:none}
#devPanel .chip.on{border-color:#7fe0a0;background:#13301f;color:#9ff0bb}
#devPanel .presets{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:4px}
#devPanel .preset{border:1px solid #3a4456;background:#161c27;color:#cdd6e2;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:700}
#devPanel .dpGo{width:100%;margin-top:6px;border:none;border-radius:11px;padding:15px;cursor:pointer;
  font:800 17px 'Cinzel',serif;color:#06210f;background:linear-gradient(180deg,#9ff0a8,#3fbf63);box-shadow:0 4px 0 #2a8044}
#devPanel .dpGo:active{transform:translateY(2px);box-shadow:0 2px 0 #2a8044}
#devPanel .dice{border:1px solid #2c3647;background:#0a0e15;color:#bfe9c8;border-radius:7px;padding:8px 11px;cursor:pointer;font-weight:700}
#devPanel .hint{color:#5d6e84;font-size:11px;margin-top:3px}`;

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
    <div class="dpHead"><h2>DEV — Battle Lab</h2><button class="dpClose" id="dpClose">Close</button></div>
    <div class="dpSec"><h3>Live Telemetry</h3><div id="devTel"></div></div>
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
      <div class="chips"><div class="chip on" id="dp_autoBegin" data-on="true">Auto-begin assault</div></div>
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
  for (const id of ['concentric', 'round', 'strongKeep', 'palisade', 'autoBegin'])
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
  $('dpLaunch').addEventListener('click', () => {
    hooks.launch({
      army: { heavy: num('heavy'), light: num('light'), archer: num('archer'), cavalry: num('cavalry'), siege: num('siege') },
      difficulty: num('diff'), seed: num('seed') | 0,
      style: {
        scale: num('scale'), aspect: num('aspect'), town: num('town'),
        concentric: chipOn('concentric'), round: chipOn('round'), strongKeep: chipOn('strongKeep'),
        palisade: chipOn('palisade'), shape: ($('dp_shape') as HTMLSelectElement).value as CastleStyle['shape'],
      },
      autoBegin: chipOn('autoBegin'),
    });
    close();
  });

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

  const open = () => { el.classList.add('show'); if (!raf) tick(); };
  return { open, close, toggle: () => (el.classList.contains('show') ? close() : open()) };
}
