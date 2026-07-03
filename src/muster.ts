// "Your Host": the standing army on a parchment muster roll. Recruit companies
// with gold (carried over between sieges), and see each arm drawn out in ink as
// a rank of little figures so the size of your host reads at a glance. A styled
// DOM screen reached from the world map.
import { Progress, ArmyKey, recruitPrice, saveProgress, vetProgress, vetMultiplier, RANK_TITLES } from './campaign';
import { AtkBuff } from './sim';
import { UNIT_ART } from './uniticons';

// ---- The muster roll's stat-block, in the chronicler's tongue. Base numbers come
// straight from the sim; the player's war-buffs (War Council upgrades + the boons of
// conquered realms) are folded in so the roll shows what each company will ACTUALLY
// field. ----
const pctUp = (m: number) => Math.round((m - 1) * 100);
function statRow(desc: string, val: string): string {
  return `<div class="srow"><span class="d">${desc}</span>${val ? `<b class="v">${val}</b>` : ''}</div>`;
}
const KEY2T: Record<string, number> = { heavy: 0, light: 1, archer: 2, cavalry: 3, siege: 4 };
function boonLine(key: ArmyKey, b: AtkBuff): string {
  const p: string[] = [];
  const t = KEY2T[key];
  // the arm's chosen DOCTRINE (branching War Council paths) reads on the roll too
  if ((b.hpA?.[t] ?? 1) > 1.005) p.push(`+${pctUp(b.hpA![t])}% doctrine hardiness`);
  if ((b.dmgA?.[t] ?? 1) > 1.005) p.push(`+${pctUp(b.dmgA![t])}% doctrine bite`);
  if ((b.spdA?.[t] ?? 1) > 1.005) p.push(`+${pctUp(b.spdA![t])}% marching pace`);
  if ((b.cdA?.[t] ?? 1) < 0.995) p.push(`${Math.round((1 / b.cdA![t] - 1) * 100)}% swifter loosing`);
  if ((b.rngA?.[t] ?? 1) > 1.005) p.push(`+${pctUp(b.rngA![t])}% reach`);
  if ((b.ammoA?.[t] ?? 1) > 1.005) p.push(`+${pctUp(b.ammoA![t])}% quivers`);
  if (key === 'cavalry' && b.chargeMul) p.push('couched lances');
  if (key === 'heavy' && b.braceMul) p.push('tower shields');
  if (key === 'light' && b.lightFlank) p.push('flanking doctrine');
  if (key === 'siege' && b.firepot) p.push('firepot ammunition');
  if (b.hp > 1.005) p.push(`+${pctUp(b.hp)}% hardiness`);
  if ((key === 'heavy' || key === 'light' || key === 'cavalry') && b.melee > 1.005) p.push(`+${pctUp(b.melee)}% bite`);
  if (key === 'archer' && b.archer > 1.005) p.push(`+${pctUp(b.archer)}% arrow-sting`);
  if (key === 'archer' && b.fire) p.push('shafts wreathed in fire');
  if (key === 'siege' && b.siege > 1.005) p.push(`+${pctUp(b.siege)}% stone-force`);
  if (key === 'siege' && b.reload < 0.995) p.push(`${Math.round((1 / b.reload - 1) * 100)}% swifter winding`);
  return p.length ? `<div class="boon">⚜ The War Council’s blessing — ${p.join(' · ')}</div>` : '';
}
function statsHTML(key: ArmyKey, b: AtkBuff, vm: number): string {
  // vm = the arm's veterancy multiplier, folded in alongside the War Council buffs so
  // the roll shows what a seasoned company ACTUALLY fields.
  const hp = (base: number) => Math.round(base * b.hp * vm);
  const mel = (base: number) => Math.round(base * b.melee * vm);
  let rows = '';
  if (key === 'heavy') rows = statRow('Harnessed in mail and plate', `${hp(120)} vigour`)
    + statRow('The weight of a knight’s blade', `${mel(9)} might`)
    + statRow('Holds the shield-wall — slow, unyielding', '')
    + statRow('Spears set against horse; a braced wall breaks a charge', '');
  else if (key === 'light') rows = statRow('Lightly girt, swift afoot', `${hp(70)} vigour`)
    + statRow('Darting spear-thrusts, oft renewed', `${mel(7)} might`)
    + statRow('May break into a sprint to close the field', '')
    + statRow('Cuts cruellest from flank and rear', '');
  else if (key === 'archer') rows = statRow('Scarce armoured — frail in the press', `${hp(55)} vigour`)
    + statRow('Bodkin shafts loosed from afar', `${Math.round(12 * b.archer * vm)} sting`)
    + statRow('Reach of forty paces · a quiver of sixteen', '')
    + statRow('May loose a massed volley — farther, harder, slower', '');
  else if (key === 'cavalry') rows = statRow('Barded destriers, proud and stout', `${hp(95)} vigour`)
    + statRow('Lance and longsword both', `${mel(15)} might`)
    + statRow('The thundering charge strikes near threefold', '')
    + statRow('Hurls men from their feet — but balks at braced spears', '');
  else if (key === 'siege') rows = statRow('Great engines of oak and iron', `${hp(260)} vigour`)
    + statRow('Hurls stone to shatter wall and gate', `${Math.round(200 * b.siege * vm)} ruin`)
    + statRow('Reach of one hundred paces · sixteen stones', '')
    + statRow('Worked by engineer crews — guard them or the engine falls silent', '');
  return rows + boonLine(key, b);
}

// The arm's veterancy: a star-rank with its honour-name, a tally of the slain, and a
// bar creeping toward the next grade — so the player watches a corps grow legendary.
function vetHTML(key: ArmyKey, prog: Progress): string {
  const v = prog.vet[key], { rank, frac, next } = vetProgress(v.xp);
  const stars = rank > 0 ? `<span class="vstars">${'★'.repeat(rank)}</span>` : '';
  const edge = rank > 0 ? ` · +${Math.round((vetMultiplier(rank) - 1) * 100)}% mettle` : '';
  const tally = v.kills > 0 ? `<span class="vkills">${v.kills.toLocaleString()} felled</span>` : '';
  const nextLine = next === null
    ? `<div class="vnext">The highest honour — none stand above them.</div>`
    : `<div class="vnext">${(next - v.xp).toLocaleString()} more deeds to ${RANK_TITLES[rank + 1]}</div>`;
  return `<div class="hostVet"><div class="vrow"><span class="vrank">${stars}${RANK_TITLES[rank]}${edge}</span>${tally}</div>`
    + `<div class="vbar"><i style="width:${Math.round(frac * 100)}%"></i></div>${nextLine}</div>`;
}

// hand-inked soldier silhouettes (currentColor = ink), one per arm
export const ICONS: Record<ArmyKey, string> = {
  light: `<svg viewBox="0 0 28 36" fill="currentColor"><circle cx="10" cy="6" r="3.6"/><rect x="6.3" y="9.4" width="7.4" height="11" rx="2.6"/><rect x="6.9" y="19" width="2.7" height="13" rx="1.3"/><rect x="10.4" y="19" width="2.7" height="13" rx="1.3"/><rect x="12.4" y="11.6" width="7.5" height="2" rx="1" transform="rotate(-10 12.4 11.6)"/><rect x="18.6" y="2" width="1.9" height="31" rx="0.8"/><polygon points="19.55,-0.4 22.6,5 16.5,5"/></svg>`,
  heavy: `<svg viewBox="0 0 28 36" fill="currentColor"><circle cx="11.5" cy="6" r="3.6"/><rect x="7.8" y="9.4" width="7.4" height="11" rx="2.6"/><rect x="8.4" y="19" width="2.7" height="13" rx="1.3"/><rect x="11.9" y="19" width="2.7" height="13" rx="1.3"/><path d="M2.4 9.6 H9.2 V18 Q9.2 24.4 5.8 27.4 Q2.4 24.4 2.4 18 Z"/><rect x="19.2" y="4.4" width="1.8" height="20.5" rx="0.6"/><rect x="16.5" y="8.6" width="7.2" height="2" rx="0.6"/><rect x="19.4" y="2.6" width="1.4" height="2.4" rx="0.5"/></svg>`,
  archer: `<svg viewBox="0 0 28 36" fill="currentColor"><circle cx="11" cy="6" r="3.6"/><rect x="7.3" y="9.4" width="7.4" height="11" rx="2.6"/><rect x="7.9" y="19" width="2.7" height="13" rx="1.3"/><rect x="11.4" y="19" width="2.7" height="13" rx="1.3"/><path d="M19 3.6 Q25.4 16 19 28.4" fill="none" stroke="currentColor" stroke-width="1.7"/><line x1="19" y1="3.6" x2="19" y2="28.4" stroke="currentColor" stroke-width="1"/><rect x="8.6" y="15" width="12.4" height="1.6" rx="0.6"/><polygon points="22.8,15.8 19,13.9 19,17.7"/></svg>`,
  cavalry: `<svg viewBox="0 0 42 36" fill="currentColor"><ellipse cx="19" cy="21" rx="11.5" ry="5.6"/><path d="M28 18 Q32 9 35.5 6.6 L38.5 7.6 Q35.4 9.6 34.2 14.6 Q32.6 19 29 20 Z"/><polygon points="37.6,6 39.4,3 38.6,7.4"/><path d="M8 16 Q3.6 18 4.8 26.5 Q7 22.5 10 21.5 Z"/><rect x="10.6" y="25" width="2.5" height="10.5" rx="1.1"/><rect x="14.6" y="25.5" width="2.5" height="10.5" rx="1.1"/><rect x="22" y="25.5" width="2.5" height="10.5" rx="1.1"/><rect x="26" y="25" width="2.5" height="10.5" rx="1.1"/><circle cx="18" cy="7.4" r="3"/><rect x="14.4" y="10.4" width="7.2" height="7.4" rx="2.3"/><rect x="20.4" y="0.6" width="1.7" height="20" rx="0.6" transform="rotate(20 21 11)"/></svg>`,
  siege: `<svg viewBox="0 0 42 34" fill="currentColor"><rect x="3.5" y="27.5" width="31" height="2.7" rx="1.2"/><polygon points="12.5,28 16.8,12.5 18.8,12.5 15.4,28"/><polygon points="25.5,28 19.2,12.5 21.2,12.5 28.6,28"/><rect x="4.5" y="6" width="31" height="2.5" rx="1.2" transform="rotate(25 19 13)"/><rect x="5" y="13.5" width="6.4" height="6.4" rx="1"/><circle cx="33.5" cy="5.4" r="2.6"/><circle cx="11" cy="31.4" r="2.6"/><circle cx="28" cy="31.4" r="2.6"/></svg>`,
};

const ROSTER: { key: ArmyKey; name: string; sub: string; step: number; per: number }[] = [
  { key: 'heavy', name: 'Heavy Infantry', sub: 'Men-at-arms in mail', step: 50, per: 60 },
  { key: 'light', name: 'Light Infantry', sub: 'Levy spearmen', step: 50, per: 60 },
  { key: 'archer', name: 'Archers', sub: 'Bowmen and crossbows', step: 50, per: 60 },
  { key: 'cavalry', name: 'Cavalry', sub: 'Mounted knights', step: 25, per: 30 },
  { key: 'siege', name: 'Trebuchets', sub: 'Siege engines', step: 1, per: 1 },
];

// a drawn rank: one inked figure per `per` souls, so a big host shows a long row
function rankFigures(key: ArmyKey, count: number, per: number): string {
  if (count <= 0) return '<span class="empty">— none mustered —</span>';
  const n = Math.max(1, Math.min(24, Math.round(count / per)));
  return Array.from({ length: n }, () => `<span class="rfig">${ICONS[key]}</span>`).join('');
}

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement('style'); s.id = 'mus-styles';
  s.textContent = `
  .musScreen{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;overflow:hidden;
    color:#3a2913;font-family:'EB Garamond',Georgia,serif;background-color:#e7d5ac;
    background-image:
      radial-gradient(135% 80% at 50% -12%, rgba(255,249,229,0.72), rgba(255,249,229,0) 55%),
      radial-gradient(120% 95% at 50% 114%, rgba(110,80,40,0.5), rgba(110,80,40,0) 52%),
      radial-gradient(60% 55% at 6% 22%, rgba(110,80,40,0.22), transparent 60%),
      radial-gradient(60% 55% at 96% 64%, rgba(110,80,40,0.2), transparent 60%),
      repeating-linear-gradient(91deg, rgba(150,118,72,0.055) 0 3px, transparent 3px 7px)}
  .musTop{display:flex;flex-direction:column;align-items:center;gap:9px;padding:calc(var(--safe-top) + 12px) 16px 4px}
  .musBar{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding-right:48px}
  .musTop h2{margin:0;font-size:25px;color:#48330f;letter-spacing:1px;font-family:'Cinzel',Georgia,serif;text-shadow:0 1px 0 rgba(255,250,235,0.4)}
  .musGold{font-size:15px;color:#7a571c;font-weight:700;white-space:nowrap}
  .musGold b{font-size:19px;color:#8a5410}
  .musClose{border:1px solid #76551f;border-radius:8px;padding:8px 16px;background:rgba(120,88,45,0.14);color:#48330f;
    font:600 14px 'Cinzel',Georgia,serif;cursor:pointer}
  .musSub{padding:2px 18px 6px;font-size:13px;color:#6a4c20;font-style:italic}
  .musRule{height:0;margin:2px 18px 10px;border-top:2px solid rgba(90,64,28,0.55);box-shadow:0 3px 0 -2px rgba(90,64,28,0.3)}
  .musBody{flex:1;overflow-y:auto;padding:0 14px 26px}
  .hostCard{margin-bottom:12px;padding:10px 12px 11px;border:1px solid rgba(92,66,30,0.42);border-radius:8px;
    background:linear-gradient(180deg,rgba(255,250,234,0.42),rgba(150,116,70,0.12))}
  .hostTop{display:flex;align-items:center;gap:12px}
  .bigic{flex:0 0 auto;line-height:0}
  .bigic img{width:52px;height:52px;border-radius:13px;display:block;border:1px solid rgba(90,64,28,0.55);box-shadow:0 2px 7px rgba(60,40,16,0.4)}
  .hostMeta{flex:1;min-width:0}
  .hostName{font-family:'Cinzel',Georgia,serif;font-size:15.5px;font-weight:700;color:#3a2710;line-height:1.1}
  .hostNum{font-size:12.5px;color:#6a4c20}
  .hostNum b{color:#3a2710;font-size:14px}
  .recruit{flex:0 0 auto;border:none;cursor:pointer;border-radius:9px;padding:7px 12px;line-height:1.1;text-align:center;
    font:700 14px 'Cinzel',Georgia,serif;color:#f4e6c6;background:radial-gradient(circle at 40% 32%, #a23e30, #6f261c);
    box-shadow:0 2px 5px rgba(40,16,8,0.35),inset 0 1px 0 rgba(255,210,180,0.25)}
  .recruit span{display:block;font:600 10.5px 'EB Garamond',Georgia,serif;color:#f0d4ab;margin-top:1px}
  .recruit:active{transform:translateY(1px)}
  .recruit:disabled{background:radial-gradient(circle at 40% 32%,#8a7a66,#5d5044);opacity:.6;cursor:default}
  .rank{display:flex;flex-wrap:wrap;align-items:flex-end;gap:1px 2px;margin-top:9px;padding-top:8px;
    border-top:1px dashed rgba(92,66,30,0.4);min-height:24px}
  .rfig{line-height:0;color:#43301a}
  .rfig svg{width:14px;height:18px;display:block}
  .rank .empty{font-style:italic;font-size:12px;color:#8a6c3e;padding:2px}
  .hostStats{margin-top:9px;padding-top:8px;border-top:1px dashed rgba(92,66,30,0.4)}
  .hostStats .srow{display:flex;justify-content:space-between;align-items:baseline;gap:14px;line-height:1.55}
  .hostStats .srow .d{font-size:12.5px;font-style:italic;color:#5c441f}
  .hostStats .srow .v{flex:0 0 auto;font-family:'Cinzel',Georgia,serif;font-size:11.5px;font-weight:700;color:#43300f;white-space:nowrap}
  .hostStats .boon{margin-top:6px;font-size:11.5px;font-weight:600;color:#7a5410;line-height:1.4;font-style:italic}
  .hostVet{margin-top:9px;padding-top:8px;border-top:1px dashed rgba(92,66,30,0.4)}
  .hostVet .vrow{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
  .hostVet .vrank{font-family:'Cinzel',Georgia,serif;font-size:12px;font-weight:700;color:#7a5410}
  .hostVet .vstars{color:#c8901f;margin-right:4px;letter-spacing:1px}
  .hostVet .vkills{font-size:11.5px;font-style:italic;color:#6a4c20;white-space:nowrap}
  .hostVet .vbar{margin:5px 0 3px;height:5px;border-radius:999px;background:rgba(90,64,28,0.22);box-shadow:inset 0 1px 1px rgba(60,40,16,0.3);overflow:hidden}
  .hostVet .vbar>i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#b9802a,#e7b64c);box-shadow:0 0 5px rgba(220,160,60,0.5)}
  .hostVet .vnext{font-size:10.5px;color:#8a6c3e;font-style:italic}`;
  document.head.appendChild(s);
}

// Show the "Your Host" overlay. `discount` is the Quartermaster recruitment
// multiplier (1 = full price). onClose fires when the player returns to the map.
export function openMuster(prog: Progress, discount: number, buff: AtkBuff, onClose: () => void) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'musScreen';
  const render = () => {
    // keep the roll where the player left it — recruiting re-renders the list, and
    // without this the scroll snaps back to the top after every purchase
    const keepScroll = (root.querySelector('.musBody') as HTMLElement | null)?.scrollTop ?? 0;
    const a = prog.army;
    const men = a.heavy + a.light + a.archer + a.cavalry;
    const sub = `${men.toLocaleString()} fighting men${a.siege > 0 ? ` and ${a.siege} engine${a.siege === 1 ? '' : 's'}` : ''} under your banner`;
    root.innerHTML = `<div class="musTop"><div class="musBar"><button class="musClose">Done</button><div class="musGold"><b>${prog.gold}</b> gold</div></div><h2>Your Host</h2></div>`
      + `<div class="musSub">${sub}</div><div class="musRule"></div>`
      + `<div class="musBody">${ROSTER.map(r => {
        const price = recruitPrice(r.key, r.step, discount);
        const num = prog.army[r.key];
        return `<div class="hostCard"><div class="hostTop"><span class="bigic"><img src="${UNIT_ART[r.key]}" alt=""></span>`
          + `<div class="hostMeta"><div class="hostName">${r.name}</div><div class="hostNum"><b>${num}</b> · ${r.sub}</div></div>`
          + `<button class="recruit" data-k="${r.key}" ${prog.gold < price ? 'disabled' : ''}>Recruit +${r.step}<span>${price} gold</span></button></div>`
          + `<div class="rank">${rankFigures(r.key, num, r.per)}</div>`
          + `<div class="hostStats">${statsHTML(r.key, buff, vetMultiplier(vetProgress(prog.vet[r.key].xp).rank))}</div>`
          + vetHTML(r.key, prog) + `</div>`;
      }).join('')}</div>`;
    const body = root.querySelector('.musBody') as HTMLElement | null;
    if (body) body.scrollTop = keepScroll; // restore the reading position after the rebuild
    root.querySelector('.musClose')!.addEventListener('click', () => { root.remove(); onClose(); });
    root.querySelectorAll<HTMLButtonElement>('.recruit').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.k as ArmyKey; const r = ROSTER.find(x => x.key === k)!; const price = recruitPrice(k, r.step, discount);
      if (prog.gold < price) return;
      prog.gold -= price; prog.army[k] += r.step; saveProgress(prog); render();
    }));
  };
  render();
  document.body.appendChild(root);
}
