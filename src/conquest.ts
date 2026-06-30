// The conquest flourish: when a castle falls, the campaign map celebrates. A heraldic
// "CASTLE TAKEN" banner sweeps in, and a fistful of gold coins bursts from the captured
// keep and arcs up into your coffer, ticking the war-chest higher as each one lands.
// Pure DOM/CSS over the map — no asset deps, no 3D coupling beyond a screen position.

export interface ConquestOpts {
  name: string;                              // the castle just taken
  realm: string | null;                      // set if this take also conquered a whole realm
  from: { x: number; y: number } | null;     // page-px launch point (the castle); null → top-centre
  goldBefore: number;                         // war-chest before spoils (the counter starts here)
  goldGained: number;                         // spoils to pour in as coins land
  goldEl: HTMLElement | null;                 // the gold number to tick up
  coffer: HTMLElement | null;                 // the gold chip the coins fly into
  onCoin?: () => void;                        // a chink as each coin lands
  onLand?: () => void;                        // a flourish as the hoard settles
}

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement('style'); s.id = 'cq-styles';
  s.textContent = `
  .cqRoot{position:fixed;inset:0;z-index:40;pointer-events:none;overflow:hidden}
  .cqBanner{position:absolute;left:50%;top:34%;transform:translate(-50%,-50%) scale(.7);opacity:0;
    display:flex;flex-direction:column;align-items:center;gap:7px;text-align:center;
    padding:18px 34px;border-radius:16px;
    background:radial-gradient(130% 90% at 50% -10%,rgba(255,224,150,0.22),transparent 60%),linear-gradient(180deg,#3a2a14,#241809);
    border:1px solid rgba(255,225,160,0.45);box-shadow:0 14px 40px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,235,190,0.2),0 0 40px rgba(255,200,90,0.25)}
  .cqBanner.in{animation:cqIn .5s cubic-bezier(.18,.9,.24,1) forwards}
  .cqBanner.out{animation:cqOut .5s ease-in forwards}
  .cqKicker{font:700 11px 'Cinzel',Georgia,serif;letter-spacing:3px;color:#e9c879;text-transform:uppercase}
  .cqTitle{font:800 30px 'Cinzel',Georgia,serif;letter-spacing:1px;line-height:1.05;
    background:linear-gradient(180deg,#fff1c6,#f0bf52 62%,#d79a2c);-webkit-background-clip:text;background-clip:text;color:transparent;
    text-shadow:0 2px 10px rgba(180,120,30,0.35)}
  .cqRealm{font:600 13px 'EB Garamond',Georgia,serif;font-style:italic;color:#ecd49a;margin-top:1px}
  .cqLaurel{font-size:17px;color:#f0c860;letter-spacing:2px}
  .cqCoin{position:fixed;width:20px;height:20px;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.45));z-index:41}
  .cqCoin svg{width:100%;height:100%;display:block}
  .cqPulse{animation:cqPulse .42s ease-out}
  @keyframes cqIn{from{opacity:0;transform:translate(-50%,-50%) scale(.7)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
  @keyframes cqOut{from{opacity:1;transform:translate(-50%,-50%) scale(1)}to{opacity:0;transform:translate(-50%,-58%) scale(.96)}}
  @keyframes cqPulse{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}`;
  document.head.appendChild(s);
}

const COIN_SVG = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#e9b94e"/><circle cx="12" cy="12" r="8.4" fill="none" stroke="#b9802a" stroke-width="1.4"/><path d="M12 6v12" stroke="#7a5410" stroke-width="1.6" stroke-linecap="round"/><path d="M9.3 8.6h4.1a2 2 0 0 1 0 4h-2.8a2 2 0 0 0 0 4h3.1" fill="none" stroke="#7a5410" stroke-width="1.5" stroke-linecap="round"/></svg>`;

export function playConquest(o: ConquestOpts) {
  injectStyles();
  const root = document.createElement('div'); root.className = 'cqRoot';
  document.body.appendChild(root);

  // ---- the heraldic banner ----
  const banner = document.createElement('div'); banner.className = 'cqBanner in';
  banner.innerHTML = `<div class="cqLaurel">⚜ ❧ ⚜</div>`
    + `<div class="cqKicker">${o.realm ? 'Realm Conquered' : 'Castle Taken'}</div>`
    + `<div class="cqTitle">${(o.realm || o.name).toUpperCase()}</div>`
    + (o.realm ? `<div class="cqRealm">${o.name} falls — the realm is yours.</div>`
               : `<div class="cqRealm">Your banner flies over the keep.</div>`);
  root.appendChild(banner);
  setTimeout(() => { banner.classList.remove('in'); banner.classList.add('out'); }, o.realm ? 2600 : 2000);

  // ---- the spilling hoard ----
  const vw = window.innerWidth, vh = window.innerHeight;
  const start = o.from && o.from.x > -50 && o.from.x < vw + 50 ? o.from : { x: vw * 0.5, y: vh * 0.32 };
  const cr = o.coffer?.getBoundingClientRect();
  const target = cr ? { x: cr.left + cr.width * 0.5, y: cr.top + cr.height * 0.5 } : { x: 56, y: 48 };

  const N = Math.min(18, Math.max(8, Math.round(6 + o.goldGained / 60)));
  const per = o.goldGained / N;
  let landed = 0;
  const finalGold = o.goldBefore + o.goldGained;
  if (o.goldEl) o.goldEl.textContent = String(o.goldBefore);

  for (let i = 0; i < N; i++) {
    const coin = document.createElement('div'); coin.className = 'cqCoin'; coin.innerHTML = COIN_SVG;
    coin.style.opacity = '0';
    root.appendChild(coin);
    // a little scatter at the launch so they don't fly as one rigid clump
    const jx = (Math.random() - 0.5) * 46, jy = (Math.random() - 0.5) * 30;
    const p0 = { x: start.x + jx, y: start.y + jy };
    // arc control point: up and biased toward the coffer, varied per coin
    const ctrl = { x: (p0.x + target.x) / 2 + (Math.random() - 0.5) * 120, y: Math.min(p0.y, target.y) - 90 - Math.random() * 70 };
    const delay = i * 46, dur = 660 + Math.random() * 160;
    const spin = (Math.random() - 0.5) * 720;
    const t0 = performance.now() + delay;
    const step = (now: number) => {
      const t = (now - t0) / dur;
      if (t < 0) { requestAnimationFrame(step); return; }
      if (t >= 1) {
        coin.remove();
        landed++;
        // each coin pours its share into the chest; the last one squares the total exactly
        if (o.goldEl) o.goldEl.textContent = String(landed >= N ? finalGold : Math.round(o.goldBefore + per * landed));
        if (o.coffer) { o.coffer.classList.remove('cqPulse'); void o.coffer.offsetWidth; o.coffer.classList.add('cqPulse'); }
        o.onCoin?.();
        if (landed >= N) { o.onLand?.(); setTimeout(() => root.remove(), 700); }
        return;
      }
      const mt = 1 - t;
      const x = mt * mt * p0.x + 2 * mt * t * ctrl.x + t * t * target.x;
      const y = mt * mt * p0.y + 2 * mt * t * ctrl.y + t * t * target.y;
      const sc = 1 - 0.45 * t; // shrink as it flies into the chip
      coin.style.opacity = t < 0.12 ? String(t / 0.12) : '1';
      coin.style.transform = `translate3d(${x - 10}px,${y - 10}px,0) rotate(${spin * t}deg) scale(${sc})`;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // safety net: never leave the overlay lingering if something interrupts the coins
  setTimeout(() => { if (o.goldEl) o.goldEl.textContent = String(finalGold); root.remove(); }, 4200);
}
