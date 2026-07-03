import * as THREE from 'three';

// Procedural, tileable canvas textures so the world reads as stone/tile/grass
// without shipping any image assets. Each returns a THREE.Texture set to repeat;
// callers clone() and set .repeat per mesh to keep a consistent world scale.

function tex(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function noise(ctx: CanvasRenderingContext2D, S: number, amt: number, alpha: number) {
  for (let i = 0; i < S * S * 0.5; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const d = (Math.random() - 0.5) * amt;
    ctx.fillStyle = `rgba(${d > 0 ? 255 : 0},${d > 0 ? 255 : 0},${d > 0 ? 255 : 0},${Math.abs(d) / 255 * alpha})`;
    ctx.fillRect(x, y, 1.4, 1.4);
  }
}

// Shared ashlar layout so the albedo and the normal map line up joint-for-joint.
const STONE_S = 256, STONE_COURSES = 5, STONE_BRICKS = 4, STONE_JOINT = 5;

// ---- ashlar stone: weathered courses of blocks with mortar joints (tileable) ----
export function stoneTexture(base = '#dccaa0'): THREE.CanvasTexture {
  const S = STONE_S, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  // mortar (darker, cool) shows through the joints
  ctx.fillStyle = '#8b7c5e'; ctx.fillRect(0, 0, S, S);
  const ch = S / STONE_COURSES, joint = STONE_JOINT, bw = S / STONE_BRICKS;
  const bc = new THREE.Color(base);
  for (let r = 0; r < STONE_COURSES; r++) {
    const off = (r % 2) * bw / 2; // running bond
    for (let k = -1; k <= STONE_BRICKS; k++) {
      const x = k * bw + off, y = r * ch;
      const bx = x + joint / 2, by = y + joint / 2, bwi = bw - joint, bhi = ch - joint;
      // per-block tone variation — some blocks noticeably paler / darker (patched masonry)
      const v = 0.78 + Math.random() * 0.36;
      const col = bc.clone().multiplyScalar(v);
      ctx.fillStyle = `#${col.getHexString()}`;
      ctx.fillRect(bx, by, bwi, bhi);
      // chiselled bevel: top/left catch light, bottom/right fall to shade
      ctx.fillStyle = 'rgba(255,248,232,0.14)'; ctx.fillRect(bx, by, bwi, 2); ctx.fillRect(bx, by, 2, bhi);
      ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(bx, by + bhi - 2, bwi, 2); ctx.fillRect(bx + bwi - 2, by, 2, bhi);
      // occasional spalled corner — a chip knocked off, mortar-coloured
      if (Math.random() < 0.22) {
        const cs = 3 + Math.random() * 5, cx = bx + (Math.random() < 0.5 ? 0 : bwi - cs), cy = by + (Math.random() < 0.5 ? 0 : bhi - cs);
        ctx.fillStyle = 'rgba(120,106,80,0.75)'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + cs, cy); ctx.lineTo(cx, cy + cs); ctx.closePath(); ctx.fill();
      }
      // a hairline crack across some blocks
      if (Math.random() < 0.14) {
        ctx.strokeStyle = 'rgba(40,34,24,0.4)'; ctx.lineWidth = 1;
        let px = bx + Math.random() * bwi, py = by + 2; ctx.beginPath(); ctx.moveTo(px, py);
        for (let s = 0; s < 4; s++) { px += (Math.random() - 0.5) * 6; py += bhi / 4; ctx.lineTo(px, py); } ctx.stroke();
      }
    }
  }
  // WEATHERING overlays (don't need to match the normal map):
  // dark grime streaks bleeding downward from random joints (rain-washed lime)
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S, y = Math.random() * S, h = 14 + Math.random() * 46, w = 2 + Math.random() * 5;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(48,40,28,0.32)'); g.addColorStop(1, 'rgba(48,40,28,0)');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  }
  // moss / lichen creeping in the crevices — soft grey-green blotches
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S, y = Math.random() * S, rad = 2 + Math.random() * 6;
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(96,104,64,0.22)' : 'rgba(120,120,96,0.18)';
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
  }
  noise(ctx, S, 84, 0.5);
  return tex(c);
}

// ---- matching tangent-space normal map: mortar joints recess, blocks stand proud
// so real sunlight rakes across the coursing. Built by drawing a height field with
// the SAME running-bond layout, softening the joints, then Sobel → normals. ----
export function stoneNormalTexture(): THREE.CanvasTexture {
  const S = STONE_S;
  // 1) height canvas: blocks bright (proud), mortar dark (recessed), soft edges
  const hc = document.createElement('canvas'); hc.width = hc.height = S; const hx = hc.getContext('2d')!;
  hx.fillStyle = '#2c2c2c'; hx.fillRect(0, 0, S, S); // mortar = low
  const ch = S / STONE_COURSES, joint = STONE_JOINT, bw = S / STONE_BRICKS;
  for (let r = 0; r < STONE_COURSES; r++) {
    const off = (r % 2) * bw / 2, y = r * ch;
    for (let k = -1; k <= STONE_BRICKS; k++) {
      const x = k * bw + off;
      // block face high; a faint per-block height wobble so faces aren't dead flat
      const v = 205 + Math.floor(Math.random() * 40);
      hx.fillStyle = `rgb(${v},${v},${v})`;
      hx.fillRect(x + joint / 2, y + joint / 2, bw - joint, ch - joint);
    }
  }
  // soften joint edges into ramps (bevel) — this is what makes the light roll, not clip
  hx.filter = 'blur(1.6px)'; hx.drawImage(hc, 0, 0); hx.filter = 'none';
  const hd = hx.getImageData(0, 0, S, S).data;
  const H = (x: number, y: number) => hd[(((y % S) + S) % S) * S * 4 + (((x % S) + S) % S) * 4] / 255;
  // 2) Sobel → normal
  const nc = document.createElement('canvas'); nc.width = nc.height = S; const nx = nc.getContext('2d')!;
  const img = nx.createImageData(S, S), STR = 2.6;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * STR, dy = (H(x, y + 1) - H(x, y - 1)) * STR;
    let vx = -dx, vy = -dy, vz = 1; const il = 1 / Math.hypot(vx, vy, vz); vx *= il; vy *= il; vz *= il;
    const i = (y * S + x) * 4;
    img.data[i] = (vx * 0.5 + 0.5) * 255; img.data[i + 1] = (vy * 0.5 + 0.5) * 255; img.data[i + 2] = (vz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  nx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(nc);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

// ---- terracotta roof tiles: scalloped rows (tileable) ----
export function roofTexture(base = '#b9532d'): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const bc = new THREE.Color(base);
  ctx.fillStyle = `#${bc.clone().multiplyScalar(0.7).getHexString()}`; ctx.fillRect(0, 0, S, S);
  const rows = 6, rh = S / rows, cols = 7, cw = S / cols;
  for (let r = 0; r < rows; r++) {
    const y = r * rh, off = (r % 2) * cw / 2;
    for (let k = -1; k <= cols; k++) {
      const x = k * cw + off;
      const v = 0.85 + Math.random() * 0.3;
      const col = bc.clone().multiplyScalar(v);
      // a rounded "pan tile": rectangle with a semicircle bottom
      ctx.fillStyle = `#${col.getHexString()}`;
      ctx.beginPath();
      ctx.moveTo(x + 1, y);
      ctx.lineTo(x + cw - 1, y);
      ctx.lineTo(x + cw - 1, y + rh * 0.55);
      ctx.arc(x + cw / 2, y + rh * 0.55, cw / 2 - 1, 0, Math.PI);
      ctx.lineTo(x + 1, y);
      ctx.closePath(); ctx.fill();
      // highlight ridge down the centre of each tile
      ctx.fillStyle = 'rgba(255,235,200,0.18)';
      ctx.fillRect(x + cw / 2 - 1, y + 1, 2, rh * 0.7);
    }
    // shadow line under each course
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, y + rh - 2, S, 2);
  }
  noise(ctx, S, 60, 0.35);
  return tex(c);
}

// ---- grass: speckled green with faint blades (tileable) ----
export function grassTexture(base = '#9ec25c'): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const bc = new THREE.Color(base);
  ctx.fillStyle = `#${bc.getHexString()}`; ctx.fillRect(0, 0, S, S);
  // soft, low-contrast meadow mottling — big gentle clumps with a warm sun-bias, so
  // it reads like a summer lawn rather than a noisy dark carpet
  for (let i = 0; i < 620; i++) {
    const x = Math.random() * S, y = Math.random() * S, rad = 10 + Math.random() * 34;
    const v = 0.92 + Math.random() * 0.2, warm = Math.random() > 0.5;
    const r = bc.r * 255 * v * (warm ? 1.05 : 0.98), g = bc.g * 255 * v, b = bc.b * 255 * v * (warm ? 0.88 : 1.0);
    ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},0.3)`;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
  }
  // fine blades — mostly light/mid, only a few dark, so the carpet stays bright
  ctx.lineWidth = 1;
  for (let i = 0; i < 1000; i++) {
    const x = Math.random() * S, y = Math.random() * S, h = 2 + Math.random() * 4, t = Math.random();
    ctx.strokeStyle = t < 0.16 ? 'rgba(78,108,46,0.34)' : t < 0.68 ? 'rgba(156,190,100,0.4)' : 'rgba(210,232,158,0.46)';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (Math.random() - 0.5) * 2, y - h); ctx.stroke();
  }
  // a sprinkle of tiny wildflowers — white daisies & soft-yellow buttercups (cozy)
  for (let i = 0; i < 24; i++) {
    const x = Math.random() * S, y = Math.random() * S, yellow = Math.random() > 0.5;
    ctx.fillStyle = yellow ? 'rgba(246,222,118,0.85)' : 'rgba(240,242,230,0.85)';
    ctx.beginPath(); ctx.arc(x, y, 1.0 + Math.random() * 0.8, 0, 7); ctx.fill();
  }
  return tex(c);
}

// ---- packed earth / trodden dirt for roads and courtyards (tileable) ----
export function dirtTexture(base = '#9c7f55'): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const bc = new THREE.Color(base);
  ctx.fillStyle = `#${bc.getHexString()}`; ctx.fillRect(0, 0, S, S);
  // earthy mottling — broad damp/dry patches
  for (let i = 0; i < 640; i++) {
    const x = Math.random() * S, y = Math.random() * S, rad = 6 + Math.random() * 24;
    const v = 0.7 + Math.random() * 0.52;
    ctx.fillStyle = `rgba(${Math.round(bc.r * 255 * v)},${Math.round(bc.g * 255 * v * 0.96)},${Math.round(bc.b * 255 * v * 0.88)},0.42)`;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
  }
  // scattered pebbles + trodden stones
  for (let i = 0; i < 240; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 1.1 + Math.random() * 2.8;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(184,164,132,0.5)' : 'rgba(68,52,34,0.5)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  noise(ctx, S, 60, 0.4);
  return tex(c);
}

// ---- plaster + timber framing for town houses (tileable) ----
export function plasterTexture(base = '#d8c39a'): THREE.CanvasTexture {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const bc = new THREE.Color(base);
  ctx.fillStyle = `#${bc.getHexString()}`; ctx.fillRect(0, 0, S, S);
  // timber frame: dark beams around the edge + a cross brace
  ctx.strokeStyle = '#5a3d22'; ctx.lineWidth = 7;
  ctx.strokeRect(3, 3, S - 6, S - 6);
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(3, S - 3); ctx.lineTo(S - 3, 3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(S / 2, 3); ctx.lineTo(S / 2, S - 3); ctx.stroke();
  noise(ctx, S, 70, 0.4);
  return tex(c);
}
