// ===== THE CASTLE WORKSHOP =====
// A phone-first, top-down castle editor: draw curtain walls as polylines at ANY
// angle, place gates/towers/keep/houses/trees, redraw the earthworks ring —
// complete control over the plan. Layouts save on-device (up to 30), export/
// import as JSON text, and playtest straight into a live siege. The engine
// stair-steps diagonal curtains for now; the saved docs keep true angles for
// the coming angled-wall renderer, so nothing authored here ever needs redoing.
import { CastleDoc } from './sim';

// the Custom Castle Siege setup: your host, their strength — saved between tests
export interface TestCfg { heavy: number; light: number; archer: number; cavalry: number; siege: number; garrison: number }
const CFG_KEY = 'castlehassle.workshop.testcfg.v1';
const defaultCfg = (): TestCfg => ({ heavy: 600, light: 480, archer: 460, cavalry: 220, siege: 8, garrison: 1 });
function loadCfg(): TestCfg { try { return { ...defaultCfg(), ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; } catch { return defaultCfg(); } }
function saveCfg(c: TestCfg) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* private mode */ } }

const LS_KEY = 'castlehassle.layouts.v1';
type Tool = 'select' | 'wall' | 'gate' | 'tower' | 'keep' | 'house' | 'tree' | 'works' | 'erase';

export function loadDocs(): CastleDoc[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function saveDocs(docs: CastleDoc[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(docs)); } catch { /* full/private */ }
}
const blank = (): CastleDoc => ({ v: 1, name: 'New Castle', walls: [], gates: [], towers: [], keep: null, houses: [], trees: [], works: null });

export function openEditor(onTest: (doc: CastleDoc, cfg: TestCfg) => void) {
  if (document.getElementById('cwShell')) return;
  const css = document.createElement('style'); css.id = 'cwCss';
  css.textContent = `
  #cwShell{position:fixed;inset:0;z-index:120;background:#151009;display:flex;flex-direction:column;font-family:'EB Garamond',Georgia,serif}
  #cwTop{display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top,0px) + 8px) 10px 8px;background:#221809;border-bottom:1px solid #6b532b}
  #cwTop input{flex:1;min-width:60px;background:#2e2311;border:1px solid #6b532b;border-radius:8px;color:#f3e6cf;font:600 15px 'EB Garamond',Georgia,serif;padding:7px 10px}
  #cwTop button,#cwBar button{border:1px solid #7a5e2e;background:linear-gradient(180deg,#4a361e,#221809);color:#e8dcc2;border-radius:9px;font:700 12.5px 'EB Garamond',Georgia,serif;padding:8px 10px;cursor:pointer;white-space:nowrap}
  #cwTop button.go{background:linear-gradient(180deg,#7a9a3e,#4a6a22);color:#fff}
  #cwCanvasWrap{flex:1;position:relative;overflow:hidden;touch-action:none}
  #cwCanvas{position:absolute;inset:0;width:100%;height:100%}
  #cwBar{display:flex;gap:6px;overflow-x:auto;padding:8px 10px calc(env(safe-area-inset-bottom,0px) + 8px);background:#221809;border-top:1px solid #6b532b;scrollbar-width:none}
  #cwBar::-webkit-scrollbar{display:none}
  #cwBar button{min-width:58px;min-height:46px;flex:0 0 auto}
  #cwBar button.on{border-color:#ffe27a;color:#ffe27a;box-shadow:0 0 10px rgba(255,210,74,.35)}
  #cwHint{position:absolute;top:8px;left:50%;transform:translateX(-50%);background:#000b;color:#e8dcc2;font:600 12px 'EB Garamond',Georgia,serif;padding:6px 12px;border-radius:14px;pointer-events:none;max-width:86%;text-align:center}
  #cwCtx{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);display:none;gap:6px}
  #cwCtx.show{display:flex}
  #cwCtx button{border:1px solid #7a5e2e;background:#2e2311ee;color:#e8dcc2;border-radius:9px;font:700 12px 'EB Garamond',Georgia,serif;padding:9px 12px}
  #cwIO{position:fixed;inset:0;z-index:130;background:#000c;display:none;align-items:center;justify-content:center;padding:18px}
  #cwIO.show{display:flex}
  #cwIO .card{background:#221809;border:1px solid #7a5e2e;border-radius:14px;padding:14px;width:min(94vw,480px);display:flex;flex-direction:column;gap:10px;max-height:86vh}
  #cwIO textarea{flex:1;min-height:180px;background:#151009;color:#cfe0c0;border:1px solid #5a4626;border-radius:8px;font:12px ui-monospace,monospace;padding:8px}
  #cwIO .row{display:flex;gap:8px}
  #cwIO button{flex:1;border:1px solid #7a5e2e;background:#4a361e;color:#e8dcc2;border-radius:9px;font:700 13px 'EB Garamond',Georgia,serif;padding:10px}
  #cwFight{position:fixed;inset:0;z-index:130;background:#000c;display:none;align-items:flex-end;justify-content:center}
  #cwFight.show{display:flex}
  #cwFight .card{background:#221809;border:1px solid #7a5e2e;border-radius:16px 16px 0 0;padding:14px 16px calc(env(safe-area-inset-bottom,0px) + 14px);width:min(100vw,480px);max-height:82vh;overflow-y:auto}
  #cwFight h3{margin:0 0 10px;font:800 17px 'Cinzel',Georgia,serif;color:#ffe1a0;text-align:center;letter-spacing:.5px}
  #cwFight .frow{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  #cwFight .frow label{flex:1;color:#e8dcc2;font:600 14px 'EB Garamond',Georgia,serif}
  #cwFight .frow output{width:52px;text-align:right;color:#ffd98a;font:700 15px 'EB Garamond',Georgia,serif}
  #cwFight input[type=range]{flex:2.2;accent-color:#e7b64c}
  #cwFight .fbtns{display:flex;gap:9px;margin-top:12px}
  #cwFight .fbtns button{flex:1;border:1px solid #7a5e2e;border-radius:10px;padding:12px;font:700 15px 'EB Garamond',Georgia,serif;cursor:pointer;background:#3a2c18;color:#e8dcc2}
  #cwFight .fbtns .go{background:linear-gradient(180deg,#b5402f,#8c2b20);color:#fff;border-color:#8c2b20}
  #cwFight .sub{font-size:11.5px;color:#b6a079;font-style:italic;text-align:center;margin:2px 0 10px}
  #cwList{position:fixed;inset:0;z-index:130;background:#000c;display:none;align-items:center;justify-content:center;padding:18px}
  #cwList.show{display:flex}
  #cwList .card{background:#221809;border:1px solid #7a5e2e;border-radius:14px;padding:14px;width:min(94vw,440px);max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
  #cwList .it{display:flex;gap:8px;align-items:center}
  #cwList .it span{flex:1;color:#f3e6cf;font:600 15px 'EB Garamond',Georgia,serif}
  #cwList .it button{border:1px solid #7a5e2e;background:#4a361e;color:#e8dcc2;border-radius:8px;font:700 12px 'EB Garamond',Georgia,serif;padding:7px 10px}`;
  document.head.appendChild(css);

  const shell = document.createElement('div'); shell.id = 'cwShell';
  shell.innerHTML = `
    <div id="cwTop">
      <button id="cwBack">‹ Back</button>
      <input id="cwName" value="New Castle" maxlength="28">
      <button id="cwOpen">Layouts</button>
      <button id="cwSave">Save</button>
      <button id="cwTest" class="go">⚔ Test</button>
    </div>
    <div id="cwCanvasWrap">
      <canvas id="cwCanvas"></canvas>
      <div id="cwHint"></div>
      <div id="cwCtx">
        <button id="cwDone">✓ Finish wall</button>
        <button id="cwClose2">◌ Close ring</button>
        <button id="cwBig">⬤ Big</button>
        <button id="cwDel">🗑 Delete</button>
      </div>
    </div>
    <div id="cwBar">
      <button data-t="select" class="on">✥<br>Move</button>
      <button data-t="wall">▭<br>Wall</button>
      <button data-t="gate">🚪<br>Gate</button>
      <button data-t="tower">🛡<br>Tower</button>
      <button data-t="keep">🏰<br>Keep</button>
      <button data-t="house">🏠<br>House</button>
      <button data-t="tree">🌲<br>Tree</button>
      <button data-t="works">⛏<br>Earthwork</button>
      <button data-t="erase">✕<br>Erase</button>
      <button id="cwClear">🧹<br>Clear</button>
      <button id="cwUndo">↶<br>Undo</button>
      <button id="cwGrid" class="on">#<br>Snap</button>
      <button id="cwIOBtn">⇅<br>Export</button>
    </div>
    <div id="cwIO"><div class="card">
      <textarea id="cwText" spellcheck="false"></textarea>
      <div class="row"><button id="cwCopy">Copy all layouts</button><button id="cwImport">Import (replace)</button><button id="cwIOX">Close</button></div>
    </div></div>
    <div id="cwList"><div class="card" id="cwListBody"></div></div>
    <div id="cwFight"><div class="card">
      <h3>⚔ CUSTOM CASTLE SIEGE</h3>
      <div class="sub">Your host against this castle — the garrison mans whatever you drew.</div>
      <div class="frow"><label>Heavy Infantry</label><input type="range" id="cfH" min="0" max="1500" step="50"><output id="cfHv"></output></div>
      <div class="frow"><label>Light Infantry</label><input type="range" id="cfL" min="0" max="1500" step="50"><output id="cfLv"></output></div>
      <div class="frow"><label>Archers</label><input type="range" id="cfA" min="0" max="1200" step="50"><output id="cfAv"></output></div>
      <div class="frow"><label>Cavalry</label><input type="range" id="cfC" min="0" max="800" step="25"><output id="cfCv"></output></div>
      <div class="frow"><label>Trebuchets</label><input type="range" id="cfS" min="0" max="16" step="1"><output id="cfSv"></output></div>
      <div class="frow"><label>Garrison strength</label><input type="range" id="cfG" min="50" max="200" step="10"><output id="cfGv"></output></div>
      <div class="fbtns"><button id="cfCancel">Back</button><button class="go" id="cfGo">Sound the Attack</button></div>
    </div></div>`;
  document.body.appendChild(shell);
  const $ = (id: string) => document.getElementById(id)!;
  const canvas = $('cwCanvas') as HTMLCanvasElement, ctx2 = canvas.getContext('2d')!;

  // ---- state ----
  let doc = blank();
  let tool: Tool = 'select';
  let cam = { x: 0, z: 0, s: 3 };                 // world→screen: (w - cam) * s + centre
  let snap = true;
  let drawingWall: { pts: [number, number][] } | null = null;
  let sel: { kind: string; i: number; vi?: number } | null = null;
  const undo: string[] = [];
  const push = () => { undo.push(JSON.stringify(doc)); if (undo.length > 50) undo.shift(); };
  const hint = (t: string) => { $('cwHint').textContent = t; };

  const HINTS: Record<Tool, string> = {
    select: 'Tap to select · drag to move · drag a wall dot to bend it',
    wall: 'Tap to lay wall points · ✓ finishes · ◌ closes the ring',
    gate: 'Tap ON a wall to set the gate (attackers come from the south/bottom)',
    tower: 'Tap to place a tower · select one and toggle ⬤ Big',
    keep: 'Tap to place the keep (one per castle)',
    house: 'Tap to scatter houses',
    tree: 'Tap to plant trees (outside the walls looks best)',
    works: 'Tap points to draw the siege earthworks ring · ✓ finishes',
    erase: 'Tap anything to remove it',
  };

  // ---- geometry helpers ----
  const rect = () => canvas.getBoundingClientRect();
  const toW = (sx: number, sy: number): [number, number] => {
    const r = rect();
    return [(sx - r.left - r.width / 2) / cam.s + cam.x, (sy - r.top - r.height / 2) / cam.s + cam.z];
  };
  const S = (p: [number, number]): [number, number] => {
    const r = rect();
    return [(p[0] - cam.x) * cam.s + r.width / 2, (p[1] - cam.z) * cam.s + r.height / 2];
  };
  const snapP = (p: [number, number]): [number, number] => snap ? [Math.round(p[0] / 4) * 4, Math.round(p[1] / 4) * 4] : [Math.round(p[0]), Math.round(p[1])];

  // nearest point ON a wall edge — gates and towers belong to the curtain
  function nearestOnWall(w: [number, number]): { x: number; z: number; d: number } | null {
    let best: { x: number; z: number; d: number } | null = null;
    for (const wl of doc.walls) {
      const n = wl.closed ? wl.pts.length : wl.pts.length - 1;
      for (let e = 0; e < n; e++) {
        const a = wl.pts[e], b = wl.pts[(e + 1) % wl.pts.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((w[0] - a[0]) * dx + (w[1] - a[1]) * dz) / L));
        const px = a[0] + dx * t, pz = a[1] + dz * t, d = Math.hypot(w[0] - px, w[1] - pz);
        if (!best || d < best.d) best = { x: px, z: pz, d };
      }
    }
    return best;
  }

  // nearest element to a world point (for select/erase); returns dist too
  function pick(w: [number, number]): { kind: string; i: number; vi?: number; d: number } | null {
    let best: { kind: string; i: number; vi?: number; d: number } | null = null;
    const cand = (kind: string, i: number, d: number, vi?: number) => { if (d < (best?.d ?? 12)) best = { kind, i, vi, d }; };
    doc.walls.forEach((wl, i) => {
      wl.pts.forEach((p, vi) => cand('wallpt', i, Math.hypot(p[0] - w[0], p[1] - w[1]) * 0.8, vi)); // vertices grab first
      const n = wl.closed ? wl.pts.length : wl.pts.length - 1;
      for (let e = 0; e < n; e++) {
        const a = wl.pts[e], b = wl.pts[(e + 1) % wl.pts.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((w[0] - a[0]) * dx + (w[1] - a[1]) * dz) / L));
        cand('wall', i, Math.hypot(w[0] - a[0] - dx * t, w[1] - a[1] - dz * t));
      }
    });
    doc.towers.forEach((t, i) => cand('tower', i, Math.hypot(t.x - w[0], t.z - w[1])));
    doc.gates.forEach((g, i) => cand('gate', i, Math.hypot(g.x - w[0], g.z - w[1])));
    doc.houses.forEach((h, i) => cand('house', i, Math.hypot(h.x - w[0], h.z - w[1])));
    doc.trees.forEach((t, i) => cand('tree', i, Math.hypot(t[0] - w[0], t[1] - w[1])));
    if (doc.keep) cand('keep', 0, Math.hypot(doc.keep.x - w[0], doc.keep.z - w[1]));
    if (doc.works) doc.works.forEach((p, i) => cand('workspt', i, Math.hypot(p[0] - w[0], p[1] - w[1])));
    return best;
  }

  // ---- drawing ----
  function draw() {
    const r = rect(); const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== r.width * dpr) { canvas.width = r.width * dpr; canvas.height = r.height * dpr; }
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.fillStyle = '#1d1710'; ctx2.fillRect(0, 0, r.width, r.height);
    // ground + grid
    ctx2.strokeStyle = 'rgba(255,225,160,0.05)'; ctx2.lineWidth = 1;
    const g0 = toW(r.left, r.top), g1 = toW(r.left + r.width, r.top + r.height);
    for (let x = Math.floor(g0[0] / 20) * 20; x < g1[0]; x += 20) { const [sx] = S([x, 0]); ctx2.beginPath(); ctx2.moveTo(sx, 0); ctx2.lineTo(sx, r.height); ctx2.stroke(); }
    for (let z = Math.floor(g0[1] / 20) * 20; z < g1[1]; z += 20) { const [, sz] = S([0, z]); ctx2.beginPath(); ctx2.moveTo(0, sz); ctx2.lineTo(r.width, sz); ctx2.stroke(); }
    // south marker — attackers come from here
    ctx2.fillStyle = 'rgba(200,90,60,0.5)'; ctx2.font = '600 12px Georgia';
    ctx2.fillText('⚔ attackers march from the BOTTOM ⚔', r.width / 2 - 105, r.height - 8);
    // ---- scale reference: the actual battle theatre + a typical stronghold ----
    // The sim recentres a design on its wall-bbox centre, so both frames follow
    // the drawing — judge your castle against the ground it will really defend.
    {
      let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
      for (const wl of doc.walls) for (const p of wl.pts) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mnz = Math.min(mnz, p[1]); mxz = Math.max(mxz, p[1]); }
      const cx = mxx > mnx ? (mnx + mxx) / 2 : 0, cz = mxz > mnz ? (mnz + mxz) / 2 : 0;
      // the battlefield (WORLD in sim.ts): x ±224, z -160..+296 around the castle
      const [bx0, bz0] = S([cx - 224, cz - 160]), [bx1, bz1] = S([cx + 224, cz + 296]);
      ctx2.strokeStyle = 'rgba(205,95,60,0.45)'; ctx2.lineWidth = 2; ctx2.setLineDash([10, 7]);
      ctx2.strokeRect(bx0, bz0, bx1 - bx0, bz1 - bz0); ctx2.setLineDash([]);
      ctx2.fillStyle = 'rgba(205,95,60,0.6)'; ctx2.font = '600 11px Georgia';
      ctx2.fillText('battlefield edge', bx0 + 8, bz0 + 16);
      // a mid-sized campaign stronghold (~160×140 paces) for proportion
      const [tx0, tz0] = S([cx - 80, cz - 70]), [tx1, tz1] = S([cx + 80, cz + 70]);
      ctx2.strokeStyle = 'rgba(130,200,130,0.32)'; ctx2.lineWidth = 1.5; ctx2.setLineDash([5, 6]);
      ctx2.strokeRect(tx0, tz0, tx1 - tx0, tz1 - tz0); ctx2.setLineDash([]);
      ctx2.fillStyle = 'rgba(130,200,130,0.5)';
      ctx2.fillText('typical stronghold', tx0 + 6, tz1 - 6);
    }
    // earthworks
    const works = doc.works;
    if (works && works.length > 1) {
      ctx2.strokeStyle = '#6b4a2a'; ctx2.lineWidth = 5; ctx2.setLineDash([8, 6]); ctx2.beginPath();
      works.forEach((p, i) => { const [sx, sz] = S(p); if (i) ctx2.lineTo(sx, sz); else ctx2.moveTo(sx, sz); });
      ctx2.closePath(); ctx2.stroke(); ctx2.setLineDash([]);
    }
    // walls
    doc.walls.forEach((wl, i) => {
      ctx2.strokeStyle = sel?.kind.startsWith('wall') && sel.i === i ? '#ffe27a' : '#d9c8a0';
      ctx2.lineWidth = Math.max(3, 4 * cam.s / 3); ctx2.lineJoin = 'round'; ctx2.beginPath();
      wl.pts.forEach((p, k) => { const [sx, sz] = S(p); if (k) ctx2.lineTo(sx, sz); else ctx2.moveTo(sx, sz); });
      if (wl.closed) ctx2.closePath();
      ctx2.stroke();
      if (sel?.kind.startsWith('wall') && sel.i === i) {
        wl.pts.forEach((p, vi) => { const [sx, sz] = S(p); ctx2.fillStyle = sel!.vi === vi ? '#ff9a4a' : '#ffe27a'; ctx2.beginPath(); ctx2.arc(sx, sz, 6, 0, 7); ctx2.fill(); });
      }
    });
    // wall being drawn
    if (drawingWall) {
      ctx2.strokeStyle = '#9ad06a'; ctx2.lineWidth = 3; ctx2.beginPath();
      drawingWall.pts.forEach((p, k) => { const [sx, sz] = S(p); if (k) ctx2.lineTo(sx, sz); else ctx2.moveTo(sx, sz); });
      ctx2.stroke();
      drawingWall.pts.forEach(p => { const [sx, sz] = S(p); ctx2.fillStyle = '#9ad06a'; ctx2.beginPath(); ctx2.arc(sx, sz, 5, 0, 7); ctx2.fill(); });
    }
    // gates / towers / keep / houses / trees
    for (const [i, g] of doc.gates.entries()) {
      const [sx, sz] = S([g.x, g.z]); ctx2.fillStyle = sel?.kind === 'gate' && sel.i === i ? '#ffe27a' : '#c8763a';
      ctx2.fillRect(sx - 7, sz - 5, 14, 10); ctx2.fillStyle = '#221809'; ctx2.fillRect(sx - 4, sz - 3, 8, 6);
    }
    for (const [i, t] of doc.towers.entries()) {
      const [sx, sz] = S([t.x, t.z]); const rr2 = (t.big ? 5 : 4) * cam.s / 2 + 4;
      ctx2.fillStyle = sel?.kind === 'tower' && sel.i === i ? '#ffe27a' : '#b8a478';
      ctx2.beginPath(); ctx2.arc(sx, sz, rr2, 0, 7); ctx2.fill();
      ctx2.fillStyle = '#221809'; ctx2.beginPath(); ctx2.arc(sx, sz, rr2 * 0.45, 0, 7); ctx2.fill();
    }
    if (doc.keep) {
      const [sx, sz] = S([doc.keep.x, doc.keep.z]); const kw = doc.keep.w * cam.s / 2, kd = doc.keep.d * cam.s / 2;
      ctx2.fillStyle = sel?.kind === 'keep' ? '#ffe27a' : '#e0c98e'; ctx2.fillRect(sx - kw, sz - kd, kw * 2, kd * 2);
      ctx2.strokeStyle = '#221809'; ctx2.strokeRect(sx - kw, sz - kd, kw * 2, kd * 2);
    }
    for (const [i, h] of doc.houses.entries()) {
      const [sx, sz] = S([h.x, h.z]); const hw = h.w * cam.s / 2, hd = h.d * cam.s / 2;
      ctx2.fillStyle = sel?.kind === 'house' && sel.i === i ? '#ffe27a' : '#9a5a40'; ctx2.fillRect(sx - hw, sz - hd, hw * 2, hd * 2);
    }
    for (const [i, t] of doc.trees.entries()) {
      const [sx, sz] = S(t); ctx2.fillStyle = sel?.kind === 'tree' && sel.i === i ? '#ffe27a' : '#5d7842';
      ctx2.beginPath(); ctx2.arc(sx, sz, 4 + cam.s * 0.7, 0, 7); ctx2.fill();
    }
    // scale bar — world units read as paces
    {
      const nice = [10, 20, 40, 80, 160];
      let len = nice[0]; for (const n of nice) if (n * cam.s <= 130) len = n;
      const px = len * cam.s, x0 = 12, y0 = r.height - 28;
      ctx2.strokeStyle = 'rgba(232,216,180,0.85)'; ctx2.lineWidth = 2;
      ctx2.beginPath(); ctx2.moveTo(x0, y0); ctx2.lineTo(x0 + px, y0);
      ctx2.moveTo(x0, y0 - 4); ctx2.lineTo(x0, y0 + 4); ctx2.moveTo(x0 + px, y0 - 4); ctx2.lineTo(x0 + px, y0 + 4); ctx2.stroke();
      ctx2.fillStyle = 'rgba(232,216,180,0.85)'; ctx2.font = '600 11px Georgia';
      ctx2.fillText(`${len} paces`, x0 + 4, y0 - 7);
    }
    updateCtx();
  }
  function updateCtx() {
    const box = $('cwCtx');
    const showFinish = !!drawingWall && drawingWall.pts.length >= 2;
    ($('cwDone') as HTMLElement).style.display = showFinish ? '' : 'none';
    ($('cwClose2') as HTMLElement).style.display = showFinish && tool === 'wall' && drawingWall!.pts.length >= 3 ? '' : 'none';
    ($('cwBig') as HTMLElement).style.display = sel?.kind === 'tower' ? '' : 'none';
    ($('cwDel') as HTMLElement).style.display = sel ? '' : 'none';
    box.classList.toggle('show', showFinish || !!sel);
  }

  // ---- input: 1-finger acts by tool, 2-finger always pan/zoom ----
  const ptrs = new Map<number, { x: number; y: number }>();
  let dragT: number | null = null; let moved = 0; let pinchD = 0; let grabbing = false;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0; dragT = e.pointerId;
    // touch-and-drag works in EVERY tool: touching a placed thing grabs it
    // (while actively laying a wall, taps stay reserved for laying points)
    if (ptrs.size === 1 && !drawingWall) {
      const p = pick(toW(e.clientX, e.clientY));
      // each placement tool grabs only its OWN kind (in gate mode a tap on the
      // wall must PLACE a gate there, not pick the wall up); Move grabs anything
      const GRABS: Record<string, string[]> = {
        select: ['wall', 'wallpt', 'gate', 'tower', 'keep', 'house', 'tree', 'workspt'],
        wall: ['wall', 'wallpt'], gate: ['gate'], tower: ['tower'], keep: ['keep'],
        house: ['house'], tree: ['tree'], works: ['workspt'], erase: [],
      };
      const pk = p ? (p.kind === 'wallpt' ? 'wallpt' : p.kind) : '';
      if (p && GRABS[tool]?.includes(pk)) {
        sel = { kind: pk, i: p.i, vi: p.vi };
        grabbing = true; push();
        draw();
      } else if (tool === 'select') { sel = null; draw(); }
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (ptrs.size >= 2) { // pinch zoom + pan
      const a = [...ptrs.values()];
      const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      if (pinchD) { const k = d / pinchD; cam.s = Math.max(0.8, Math.min(12, cam.s * k)); }
      pinchD = d;
      cam.x -= dx / cam.s / 2; cam.z -= dy / cam.s / 2;
      draw(); return;
    }
    if (grabbing && sel) { // drag the selection (any tool)
      const wdx = dx / cam.s, wdz = dy / cam.s;
      const mv = (o: { x?: number; z?: number } | [number, number]) => {
        if (Array.isArray(o)) { o[0] += wdx; o[1] += wdz; } else { o.x! += wdx; o.z! += wdz; }
      };
      if (sel.kind === 'wallpt' && sel.vi !== undefined) mv(doc.walls[sel.i].pts[sel.vi]);
      else if (sel.kind === 'wall') doc.walls[sel.i].pts.forEach(mv);
      else if (sel.kind === 'tower') mv(doc.towers[sel.i]);
      else if (sel.kind === 'gate') mv(doc.gates[sel.i]);
      else if (sel.kind === 'house') mv(doc.houses[sel.i]);
      else if (sel.kind === 'tree') mv(doc.trees[sel.i]);
      else if (sel.kind === 'keep' && doc.keep) mv(doc.keep);
      else if (sel.kind === 'workspt' && doc.works) mv(doc.works[sel.i]);
      draw(); return;
    }
    if (tool !== 'select' || !grabbing) { cam.x -= dx / cam.s; cam.z -= dy / cam.s; draw(); } // pan
  });
  const up = (e: PointerEvent) => {
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinchD = 0;
    const tap = dragT === e.pointerId && moved < 9;
    dragT = null;
    if (grabbing) { // finish a move: snap it
      grabbing = false;
      if (sel?.kind === 'wallpt' && sel.vi !== undefined) doc.walls[sel.i].pts[sel.vi] = snapP(doc.walls[sel.i].pts[sel.vi]);
      if (sel?.kind === 'gate') { // a gate lives ON the curtain, wherever it lands
        const g = doc.gates[sel.i], on = nearestOnWall([g.x, g.z]);
        if (on) { g.x = on.x; g.z = on.z; } else { hint('Gates need a wall — draw the curtain first'); }
      }
      if (sel?.kind === 'tower') { // towers hug the curtain too
        const t = doc.towers[sel.i], on = nearestOnWall([t.x, t.z]);
        if (on && on.d < 26) { t.x = on.x; t.z = on.z; }
        else if (on) { t.x = on.x; t.z = on.z; hint('Towers stand on the walls — snapped to the nearest curtain'); }
      }
      if (tap && moved < 9 && tool === 'select') { /* keep selection for the context buttons */ }
      draw(); return;
    }
    if (!tap) return;
    const w = snapP(toW(e.clientX, e.clientY));
    if (tool === 'wall' || tool === 'works') {
      if (!drawingWall) { push(); drawingWall = { pts: [w] }; }
      else {
        const first = drawingWall.pts[0];
        if (tool === 'wall' && drawingWall.pts.length >= 3 && Math.hypot(w[0] - first[0], w[1] - first[1]) < 10 / cam.s * 3) { finishWall(true); }
        else drawingWall.pts.push(w);
      }
    } else if (tool === 'tower') {
      const on = nearestOnWall(w);
      if (!on) { hint('Draw a wall first — towers stand on the curtain'); }
      else if (on.d > 22) { hint('Towers stand ON the walls — tap along the curtain'); }
      else { push(); doc.towers.push({ x: on.x, z: on.z, big: false }); }
    } else if (tool === 'gate') {
      const on = nearestOnWall(w);
      if (!on) { hint('Draw a wall first — the gate pierces the curtain'); }
      else if (on.d > 22) { hint('Gates pierce the walls — tap along the curtain'); }
      else { push(); doc.gates.push({ x: on.x, z: on.z }); }
    }
    else if (tool === 'keep') { push(); doc.keep = { x: w[0], z: w[1], w: 16, d: 14 }; }
    else if (tool === 'house') { push(); doc.houses.push({ x: w[0], z: w[1], w: 8 + Math.random() * 4, d: 7 + Math.random() * 3 }); }
    else if (tool === 'tree') { push(); doc.trees.push(w); }
    else if (tool === 'erase') {
      const p = pick(toW(e.clientX, e.clientY));
      if (p) {
        push();
        if (p.kind === 'wall' || p.kind === 'wallpt') doc.walls.splice(p.i, 1);
        else if (p.kind === 'tower') doc.towers.splice(p.i, 1);
        else if (p.kind === 'gate') doc.gates.splice(p.i, 1);
        else if (p.kind === 'house') doc.houses.splice(p.i, 1);
        else if (p.kind === 'tree') doc.trees.splice(p.i, 1);
        else if (p.kind === 'keep') doc.keep = null;
        else if (p.kind === 'workspt') doc.works = null;
        sel = null;
      }
    }
    draw();
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.s = Math.max(0.8, Math.min(12, cam.s * Math.exp(-e.deltaY * 0.0012))); draw(); }, { passive: false });

  function finishWall(close: boolean) {
    if (!drawingWall) return;
    if (tool === 'works') { if (drawingWall.pts.length >= 3) doc.works = drawingWall.pts; }
    else if (drawingWall.pts.length >= 2) doc.walls.push({ pts: drawingWall.pts, closed: close && drawingWall.pts.length >= 3 });
    drawingWall = null; draw();
  }

  // ---- toolbar ----
  shell.querySelectorAll('#cwBar button[data-t]').forEach(b => b.addEventListener('click', () => {
    if (drawingWall) finishWall(false);
    tool = (b as HTMLElement).dataset.t as Tool; sel = null;
    shell.querySelectorAll('#cwBar button[data-t]').forEach(x => x.classList.toggle('on', x === b));
    hint(HINTS[tool]); draw();
  }));
  $('cwDone').addEventListener('click', () => finishWall(false));
  $('cwClose2').addEventListener('click', () => finishWall(true));
  $('cwBig').addEventListener('click', () => { if (sel?.kind === 'tower') { push(); doc.towers[sel.i].big = !doc.towers[sel.i].big; draw(); } });
  $('cwDel').addEventListener('click', () => {
    if (!sel) return; push();
    if (sel.kind === 'wall' || sel.kind === 'wallpt') doc.walls.splice(sel.i, 1);
    else if (sel.kind === 'tower') doc.towers.splice(sel.i, 1);
    else if (sel.kind === 'gate') doc.gates.splice(sel.i, 1);
    else if (sel.kind === 'house') doc.houses.splice(sel.i, 1);
    else if (sel.kind === 'tree') doc.trees.splice(sel.i, 1);
    else if (sel.kind === 'keep') doc.keep = null;
    else if (sel.kind === 'workspt') doc.works = null;
    sel = null; draw();
  });
  let clearArm = 0;
  $('cwClear').addEventListener('click', () => {
    const now = performance.now();
    if (now - clearArm < 2600) { push(); doc = { ...blank(), name: doc.name }; sel = null; drawingWall = null; clearArm = 0; hint('Cleared — Undo brings it back'); draw(); }
    else { clearArm = now; hint('Tap Clear again to raze EVERYTHING (Undo can restore it)'); }
  });
  $('cwUndo').addEventListener('click', () => { const u = undo.pop(); if (u) { doc = JSON.parse(u); sel = null; drawingWall = null; draw(); } });
  $('cwGrid').addEventListener('click', () => { snap = !snap; $('cwGrid').classList.toggle('on', snap); });

  // ---- save / layouts / export ----
  $('cwSave').addEventListener('click', () => {
    doc.name = ($('cwName') as HTMLInputElement).value.trim() || 'Untitled';
    const docs = loadDocs();
    const i = docs.findIndex(d => d.name === doc.name);
    if (i >= 0) docs[i] = doc; else { if (docs.length >= 30) { hint('30 layouts max — delete one first'); return; } docs.push(doc); }
    saveDocs(docs); hint(`Saved “${doc.name}” (${docs.length} layout${docs.length === 1 ? '' : 's'})`);
  });
  $('cwOpen').addEventListener('click', () => {
    const body = $('cwListBody'); const docs = loadDocs();
    body.innerHTML = `<div class="it"><span style="color:#ffe6a6">Your layouts (${docs.length})</span><button id="cwNew2">+ New</button><button id="cwListX">Close</button></div>`
      + docs.map((d, i) => `<div class="it"><span>${d.name}</span><button data-load="${i}">Open</button><button data-kill="${i}">✕</button></div>`).join('');
    $('cwList').classList.add('show');
    $('cwListX').addEventListener('click', () => $('cwList').classList.remove('show'));
    $('cwNew2').addEventListener('click', () => { push(); doc = blank(); ($('cwName') as HTMLInputElement).value = doc.name; sel = null; $('cwList').classList.remove('show'); draw(); });
    body.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => {
      push(); doc = JSON.parse(JSON.stringify(docs[+(b as HTMLElement).dataset.load!]));
      ($('cwName') as HTMLInputElement).value = doc.name; sel = null; $('cwList').classList.remove('show'); draw();
    }));
    body.querySelectorAll('[data-kill]').forEach(b => b.addEventListener('click', () => {
      docs.splice(+(b as HTMLElement).dataset.kill!, 1); saveDocs(docs); $('cwList').classList.remove('show'); ($('cwOpen') as HTMLElement).click();
    }));
  });
  $('cwIOBtn').addEventListener('click', () => {
    ($('cwText') as HTMLTextAreaElement).value = JSON.stringify(loadDocs());
    $('cwIO').classList.add('show');
  });
  $('cwCopy').addEventListener('click', () => {
    const t = $('cwText') as HTMLTextAreaElement; t.select();
    navigator.clipboard?.writeText(t.value).then(() => hint('Copied — paste it to Claude to bake into the game')).catch(() => document.execCommand('copy'));
    $('cwIO').classList.remove('show');
  });
  $('cwImport').addEventListener('click', () => {
    try {
      const v = JSON.parse(($('cwText') as HTMLTextAreaElement).value);
      if (Array.isArray(v)) { saveDocs(v); hint(`Imported ${v.length} layouts`); }
    } catch { hint('That JSON did not parse'); }
    $('cwIO').classList.remove('show');
  });
  $('cwIOX').addEventListener('click', () => $('cwIO').classList.remove('show'));
  const cfg = loadCfg();
  const cfgSliders: [string, keyof TestCfg, (v: number) => string][] = [
    ['cfH', 'heavy', String], ['cfL', 'light', String], ['cfA', 'archer', String],
    ['cfC', 'cavalry', String], ['cfS', 'siege', String], ['cfG', 'garrison', v => `${Math.round(v * 100)}%`],
  ];
  const syncCfg = () => {
    for (const [id, key, fmt] of cfgSliders) {
      const el = $(id) as HTMLInputElement;
      el.value = String(key === 'garrison' ? cfg.garrison * 100 : cfg[key]);
      ($(id + 'v') as HTMLOutputElement).value = fmt(cfg[key]);
      el.oninput = () => { (cfg as any)[key] = key === 'garrison' ? el.valueAsNumber / 100 : el.valueAsNumber; ($(id + 'v') as HTMLOutputElement).value = fmt(cfg[key]); };
    }
  };
  $('cwTest').addEventListener('click', () => {
    if (!doc.walls.some(w => w.closed && w.pts.length >= 3)) { hint('Draw at least one CLOSED wall ring first (◌ Close ring)'); return; }
    if (!doc.gates.length) { hint('Place a Gate on the south wall so the attack has a way in'); return; }
    syncCfg(); $('cwFight').classList.add('show');
  });
  $('cfCancel').addEventListener('click', () => $('cwFight').classList.remove('show'));
  $('cfGo').addEventListener('click', () => {
    saveCfg(cfg);
    doc.name = ($('cwName') as HTMLInputElement).value.trim() || 'Untitled';
    destroy(); onTest(JSON.parse(JSON.stringify(doc)), { ...cfg });
  });
  $('cwBack').addEventListener('click', destroy);
  function destroy() { shell.remove(); css.remove(); window.removeEventListener('resize', onRs); }
  const onRs = () => draw();
  window.addEventListener('resize', onRs);

  // a friendly starter so the canvas is never intimidating-blank
  if (!loadDocs().length) {
    doc.walls.push({ pts: [[-50, -35], [50, -35], [60, 0], [50, 35], [-50, 35], [-60, 0]], closed: true });
    doc.gates.push({ x: 0, z: 35 });
    doc.towers.push({ x: -50, z: -35, big: false }, { x: 50, z: -35, big: false }, { x: -50, z: 35, big: true }, { x: 50, z: 35, big: true });
    doc.keep = { x: 0, z: -12, w: 16, d: 14 };
  }
  hint(HINTS.select);
  draw();
  (window as any).__editor = { get doc() { return doc; }, setDoc: (d: CastleDoc) => { doc = d; draw(); }, draw };
}
