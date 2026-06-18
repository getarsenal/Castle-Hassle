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

// ---- ashlar stone: courses of blocks with mortar joints (tileable) ----
export function stoneTexture(base = '#dccaa0'): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  // mortar (darker) shows through the joints
  ctx.fillStyle = '#9c8a66'; ctx.fillRect(0, 0, S, S);
  const courses = 4, ch = S / courses, joint = 3;
  const bc = new THREE.Color(base);
  for (let r = 0; r < courses; r++) {
    const bricks = 4, bw = S / bricks;
    const off = (r % 2) * bw / 2; // running bond
    for (let k = -1; k <= bricks; k++) {
      const x = k * bw + off, y = r * ch;
      // per-block tone variation
      const v = 0.82 + Math.random() * 0.3;
      const col = bc.clone().multiplyScalar(v);
      ctx.fillStyle = `#${col.getHexString()}`;
      ctx.fillRect(x + joint / 2, y + joint / 2, bw - joint, ch - joint);
      // top-left highlight + bottom-right shade for a chiselled feel
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x + joint / 2, y + joint / 2, bw - joint, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(x + joint / 2, y + ch - joint / 2 - 2, bw - joint, 2);
    }
  }
  noise(ctx, S, 90, 0.5);
  return tex(c);
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
export function grassTexture(base = '#86ab4d'): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const bc = new THREE.Color(base);
  ctx.fillStyle = `#${bc.getHexString()}`; ctx.fillRect(0, 0, S, S);
  // mottled patches
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * S, y = Math.random() * S, rad = 4 + Math.random() * 16;
    const v = 0.78 + Math.random() * 0.4;
    ctx.fillStyle = `rgba(${Math.round(bc.r * 255 * v)},${Math.round(bc.g * 255 * v)},${Math.round(bc.b * 255 * v * 0.95)},0.5)`;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
  }
  // tiny blades
  ctx.lineWidth = 1;
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * S, y = Math.random() * S, h = 2 + Math.random() * 4;
    const dark = Math.random() > 0.5;
    ctx.strokeStyle = dark ? 'rgba(40,70,25,0.5)' : 'rgba(190,220,150,0.5)';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (Math.random() - 0.5) * 2, y - h); ctx.stroke();
  }
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
