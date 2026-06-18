import * as THREE from 'three';

// Procedurally drawn, chunky "toy-soldier" sprites in the house style. Each is
// drawn mostly in white (so a per-instance faction tint multiplies into a solid
// coloured figure) with a baked dark outline + soft top-highlight / bottom-shade
// so they read as shaded figures, not flat blobs. Silhouette conveys the role.

export type SpriteKind = 'heavy' | 'light' | 'archer' | 'cavalry' | 'siege';

const S = 96;

function newCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSoldier(ctx: CanvasRenderingContext2D, kind: SpriteKind) {
  const cx = S / 2;
  // ---- outline pass (dark, slightly inflated) then body pass (white) ----
  const passes: [string, number][] = [['#2b2b2b', 3.2], ['#ffffff', 0]];

  for (const [color, g] of passes) {
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    if (kind === 'cavalry') {
      // horse body + neck + head
      rr(ctx, cx - 26 - g, 50 - g, 46 + g * 2, 17 + g * 2, 8); ctx.fill();
      rr(ctx, cx + 8 - g, 34 - g, 14 + g * 2, 20 + g * 2, 6); ctx.fill();
      rr(ctx, cx + 16 - g, 30 - g, 12 + g * 2, 10 + g * 2, 4); ctx.fill();
      // legs
      rr(ctx, cx - 20 - g, 64 - g, 7 + g * 2, 14 + g * 2, 3); ctx.fill();
      rr(ctx, cx + 12 - g, 64 - g, 7 + g * 2, 14 + g * 2, 3); ctx.fill();
      // rider torso + head
      rr(ctx, cx - 10 - g, 24 - g, 18 + g * 2, 22 + g * 2, 7); ctx.fill();
      rr(ctx, cx - 6 - g, 10 - g, 14 + g * 2, 14 + g * 2, 6); ctx.fill();
      // lance
      ctx.lineWidth = 4 + g; ctx.beginPath(); ctx.moveTo(cx + 16, 8); ctx.lineTo(cx + 26, 60); ctx.stroke();
      continue;
    }
    if (kind === 'siege') {
      // trebuchet: base, A-frame, throwing arm + counterweight
      rr(ctx, cx - 30 - g, 66 - g, 60 + g * 2, 9 + g * 2, 3); ctx.fill();        // base beam
      ctx.lineWidth = 6 + g;
      ctx.beginPath(); ctx.moveTo(cx - 14, 70); ctx.lineTo(cx, 30); ctx.lineTo(cx + 14, 70); ctx.stroke(); // A-frame
      ctx.beginPath(); ctx.moveTo(cx - 22, 18); ctx.lineTo(cx + 20, 44); ctx.stroke();                      // arm
      rr(ctx, cx + 14 - g, 44 - g, 14 + g * 2, 14 + g * 2, 4); ctx.fill();        // counterweight
      continue;
    }

    // foot soldiers: legs, torso, head/helmet
    rr(ctx, cx - 10 - g, 52 - g, 8 + g * 2, 20 + g * 2, 3); ctx.fill();
    rr(ctx, cx + 2 - g, 52 - g, 8 + g * 2, 20 + g * 2, 3); ctx.fill();
    rr(ctx, cx - 13 - g, 26 - g, 26 + g * 2, 30 + g * 2, 9); ctx.fill();  // torso
    rr(ctx, cx - 8 - g, 8 - g, 16 + g * 2, 16 + g * 2, 7); ctx.fill();    // head

    if (kind === 'heavy') {
      rr(ctx, cx - 22 - g, 28 - g, 13 + g * 2, 26 + g * 2, 4); ctx.fill();          // tall shield
      ctx.lineWidth = 4 + g; ctx.beginPath(); ctx.moveTo(cx + 13, 4); ctx.lineTo(cx + 13, 58); ctx.stroke(); // spear
    } else if (kind === 'light') {
      ctx.lineWidth = 4 + g; ctx.beginPath(); ctx.moveTo(cx + 12, 30); ctx.lineTo(cx + 22, 12); ctx.stroke(); // raised sword
      rr(ctx, cx - 19 - g, 32 - g, 9 + g * 2, 16 + g * 2, 3); ctx.fill();           // small buckler
    } else if (kind === 'archer') {
      ctx.lineWidth = 4 + g; ctx.beginPath(); ctx.arc(cx + 13, 34, 18, -1.15, 1.15); ctx.stroke();           // bow
      ctx.lineWidth = 1.5 + g; ctx.beginPath(); ctx.moveTo(cx + 13 + 18 * Math.cos(-1.15), 34 + 18 * Math.sin(-1.15)); ctx.lineTo(cx + 13 + 18 * Math.cos(1.15), 34 + 18 * Math.sin(1.15)); ctx.stroke(); // string
    }
  }

  // ---- baked shading (survives the per-instance tint multiply) ----
  ctx.globalCompositeOperation = 'source-atop';
  // vertical: bright top highlight -> neutral -> deep bottom shadow (grounds it)
  const vg = ctx.createLinearGradient(0, 0, 0, S);
  vg.addColorStop(0, 'rgba(255,255,255,0.46)');
  vg.addColorStop(0.4, 'rgba(255,255,255,0)');
  vg.addColorStop(0.78, 'rgba(0,0,0,0.12)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, S, S);
  // horizontal form light: lit on the sun side (left), shaded on the right
  const hg = ctx.createLinearGradient(0, 0, S, 0);
  hg.addColorStop(0, 'rgba(255,250,235,0.22)');
  hg.addColorStop(0.5, 'rgba(255,255,255,0)');
  hg.addColorStop(1, 'rgba(0,0,0,0.26)');
  ctx.fillStyle = hg; ctx.fillRect(0, 0, S, S);
  // metal sheen: a small bright spot on the helmet/head
  const sh = ctx.createRadialGradient(S / 2 - 3, 13, 1, S / 2 - 3, 13, 9);
  sh.addColorStop(0, 'rgba(255,255,255,0.5)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sh; ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
}

export function makeSoldierTexture(kind: SpriteKind): THREE.CanvasTexture {
  const [c, ctx] = newCanvas();
  drawSoldier(ctx, kind);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}

export function makeArrowTexture(): THREE.CanvasTexture {
  const [c, ctx] = newCanvas();
  ctx.strokeStyle = '#3a2c1a'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(S / 2, 14); ctx.lineTo(S / 2, S - 18); ctx.stroke();
  ctx.fillStyle = '#d8d8d8';
  ctx.beginPath(); ctx.moveTo(S / 2, 4); ctx.lineTo(S / 2 + 9, 20); ctx.lineTo(S / 2 - 9, 20); ctx.closePath(); ctx.fill();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
