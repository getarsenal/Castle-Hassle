import * as THREE from 'three';

// Procedurally drawn soldier sprites in the house style: chunky, rounded,
// flat-shaded silhouettes. Drawn in near-white so a per-instance faction tint
// (InstancedMesh.setColorAt) multiplies cleanly into a solid colored figure
// with darker edges. One texture per unit type; shape conveys the role.

export type SpriteKind = 'heavy' | 'light' | 'archer' | 'cavalry';

const S = 64; // texture size (px) — small & cheap, looks chunky on purpose

function newCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

// Rounded blob helper
function blob(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function draw(kind: SpriteKind): HTMLCanvasElement {
  const [c, ctx] = newCanvas();
  // We draw a darker "outline" layer first (slightly larger), then a bright
  // body on top. After faction tint multiply: outline = darker faction color,
  // body = faction color. Reads as a flat-shaded little trooper.
  const OUT = '#8a8a8a';   // becomes darker tint
  const BODY = '#ffffff';  // becomes full faction color
  const DARK = '#b9b9b9';  // mid detail (helmet band etc.)

  const cx = S / 2;

  const figure = (color: string, grow: number) => {
    ctx.fillStyle = color;
    if (kind === 'cavalry') {
      // horse body
      blob(ctx, cx - 20 - grow, 40 - grow, 40 + grow * 2, 16 + grow * 2, 7);
      // horse neck/head
      blob(ctx, cx + 8 - grow, 26 - grow, 12 + grow * 2, 16 + grow * 2, 5);
      // legs
      blob(ctx, cx - 16 - grow, 52 - grow, 6 + grow * 2, 10 + grow * 2, 2);
      blob(ctx, cx + 10 - grow, 52 - grow, 6 + grow * 2, 10 + grow * 2, 2);
      // rider torso + head
      blob(ctx, cx - 9 - grow, 18 - grow, 16 + grow * 2, 18 + grow * 2, 6);
      blob(ctx, cx - 6 - grow, 6 - grow, 12 + grow * 2, 12 + grow * 2, 5);
      // lance
      ctx.save(); ctx.fillRect(cx + 12 - grow, 8 - grow, 3 + grow, 34 + grow * 2); ctx.restore();
      return;
    }
    // foot soldier: legs, torso, head
    blob(ctx, cx - 9 - grow, 40 - grow, 7 + grow * 2, 16 + grow * 2, 3);
    blob(ctx, cx + 2 - grow, 40 - grow, 7 + grow * 2, 16 + grow * 2, 3);
    blob(ctx, cx - 11 - grow, 20 - grow, 22 + grow * 2, 24 + grow * 2, 8); // torso
    blob(ctx, cx - 7 - grow, 6 - grow, 14 + grow * 2, 14 + grow * 2, 6);   // head/helmet

    if (kind === 'heavy') {
      // shield slab
      blob(ctx, cx - 18 - grow, 22 - grow, 11 + grow * 2, 20 + grow * 2, 4);
      // spear
      ctx.fillRect(cx + 10 - grow, 2 - grow, 3 + grow, 46 + grow * 2);
    } else if (kind === 'light') {
      // sword arm
      blob(ctx, cx + 8 - grow, 22 - grow, 7 + grow * 2, 9 + grow * 2, 3);
      ctx.fillRect(cx + 12 - grow, 8 - grow, 3 + grow, 20 + grow);
    } else if (kind === 'archer') {
      // bow (arc)
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 + grow;
      ctx.beginPath();
      ctx.arc(cx + 12, 28, 16 + grow, -1.1, 1.1);
      ctx.stroke();
      ctx.restore();
    }
  };

  figure(OUT, 1.6);   // outline pass
  figure(BODY, 0);    // body pass
  // a touch of mid-tone on the head for a flat-shaded helmet look
  ctx.fillStyle = DARK;
  if (kind !== 'cavalry') blob(ctx, cx - 7, 6, 14, 5, 3);

  return c;
}

export function makeSoldierTexture(kind: SpriteKind): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(draw(kind));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// A small arrow texture for projectiles.
export function makeArrowTexture(): THREE.CanvasTexture {
  const [c, ctx] = newCanvas();
  ctx.fillStyle = '#3a2c1a';
  ctx.fillRect(28, 6, 8, 52);
  ctx.fillStyle = '#d8d8d8';
  ctx.beginPath(); ctx.moveTo(32, 0); ctx.lineTo(40, 14); ctx.lineTo(24, 14); ctx.closePath(); ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
