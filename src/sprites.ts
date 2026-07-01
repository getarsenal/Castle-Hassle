import * as THREE from 'three';
import { SOLDIER_SPRITE } from './spritedata';

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

// Palette. The team SURCOAT/SHIELD is drawn in a pure GREEN KEY that the soldier
// fragment shader swaps for the faction colour — so the body stays detailed
// (steel / leather / skin) and only the heraldry carries red-vs-blue.
const C = { OUT: '#241a10', STEEL: '#868d99', STEELD: '#565c67', SKIN: '#c89a6c', LEA: '#6e4a28', LEAD: '#48301a', WOOD: '#5a3f22', KEY: '#16b416', BOSS: '#caa84e' };

function drawSoldier(ctx: CanvasRenderingContext2D, kind: SpriteKind) {
  const cx = S / 2;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // outline = true: one dark, inflated silhouette pass. outline = false: colour the
  // parts on top, leaving the inflated edge as a baked dark outline.
  const draw = (g: number, outline: boolean) => {
    const fill = (c: string) => { const col = outline ? C.OUT : c; ctx.fillStyle = col; ctx.strokeStyle = col; };

    if (kind === 'cavalry') {
      fill(C.LEA); rr(ctx, cx - 26 - g, 50 - g, 46 + g * 2, 17 + g * 2, 8); ctx.fill();              // barding/body
      rr(ctx, cx + 8 - g, 34 - g, 14 + g * 2, 20 + g * 2, 6); ctx.fill();                            // neck
      fill(C.LEAD); rr(ctx, cx + 16 - g, 30 - g, 12 + g * 2, 10 + g * 2, 4); ctx.fill();             // head
      rr(ctx, cx - 20 - g, 64 - g, 7 + g * 2, 14 + g * 2, 3); ctx.fill();                            // legs
      rr(ctx, cx + 12 - g, 64 - g, 7 + g * 2, 14 + g * 2, 3); ctx.fill();
      fill(C.KEY); rr(ctx, cx - 10 - g, 24 - g, 18 + g * 2, 22 + g * 2, 7); ctx.fill();              // rider surcoat (team)
      fill(C.STEEL); rr(ctx, cx - 6 - g, 10 - g, 14 + g * 2, 14 + g * 2, 6); ctx.fill();             // helm
      fill(C.WOOD); ctx.lineWidth = 4 + g; ctx.beginPath(); ctx.moveTo(cx + 16, 8); ctx.lineTo(cx + 26, 60); ctx.stroke(); // lance
      return;
    }
    if (kind === 'siege') {
      fill(C.WOOD); rr(ctx, cx - 30 - g, 66 - g, 60 + g * 2, 9 + g * 2, 3); ctx.fill();
      ctx.lineWidth = 6 + g;
      ctx.beginPath(); ctx.moveTo(cx - 14, 70); ctx.lineTo(cx, 30); ctx.lineTo(cx + 14, 70); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 22, 18); ctx.lineTo(cx + 20, 44); ctx.stroke();
      fill(C.STEELD); rr(ctx, cx + 14 - g, 44 - g, 14 + g * 2, 14 + g * 2, 4); ctx.fill();
      return;
    }

    // foot soldiers — legs, body, head
    fill(C.LEAD); rr(ctx, cx - 10 - g, 52 - g, 8 + g * 2, 20 + g * 2, 3); ctx.fill();
    rr(ctx, cx + 2 - g, 52 - g, 8 + g * 2, 20 + g * 2, 3); ctx.fill();

    if (kind === 'heavy') {
      fill(C.KEY); rr(ctx, cx - 13 - g, 26 - g, 26 + g * 2, 30 + g * 2, 9); ctx.fill();              // surcoat over mail (team)
      if (!outline) { fill(C.STEELD); rr(ctx, cx - 13, 47, 26, 9, 4); ctx.fill(); }                   // mail skirt below the surcoat
      fill(C.STEEL); rr(ctx, cx - 8 - g, 8 - g, 16 + g * 2, 16 + g * 2, 7); ctx.fill();              // great helm
      if (!outline) { fill(C.SKIN); rr(ctx, cx - 4, 16, 8, 4, 2); ctx.fill(); }                       // visor slit
      fill(C.KEY); rr(ctx, cx - 23 - g, 27 - g, 14 + g * 2, 28 + g * 2, 5); ctx.fill();              // tall shield (team)
      if (!outline) { fill(C.BOSS); ctx.beginPath(); ctx.arc(cx - 16, 41, 3.6, 0, 7); ctx.fill();     // boss
        fill(C.STEEL); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx - 16, 29); ctx.lineTo(cx - 16, 53); ctx.moveTo(cx - 22, 41); ctx.lineTo(cx - 10, 41); ctx.stroke(); } // cross
      fill(C.WOOD); ctx.lineWidth = 3.5 + g; ctx.beginPath(); ctx.moveTo(cx + 14, 4); ctx.lineTo(cx + 14, 58); ctx.stroke(); // spear shaft
      if (!outline) { fill(C.STEEL); ctx.beginPath(); ctx.moveTo(cx + 14, 2); ctx.lineTo(cx + 18, 12); ctx.lineTo(cx + 10, 12); ctx.fill(); } // spearhead
    } else if (kind === 'light') {
      fill(C.KEY); rr(ctx, cx - 13 - g, 26 - g, 26 + g * 2, 30 + g * 2, 9); ctx.fill();              // tabard (team)
      if (!outline) { fill(C.LEA); rr(ctx, cx - 13, 47, 26, 9, 4); ctx.fill(); }                      // leather skirt
      fill(C.LEAD); rr(ctx, cx - 8 - g, 8 - g, 16 + g * 2, 16 + g * 2, 7); ctx.fill();               // cap
      if (!outline) { fill(C.SKIN); rr(ctx, cx - 5, 14, 10, 8, 4); ctx.fill(); }                      // face
      fill(C.KEY); rr(ctx, cx - 20 - g, 32 - g, 11 + g * 2, 14 + g * 2, 5); ctx.fill();              // buckler (team)
      if (!outline) { fill(C.BOSS); ctx.beginPath(); ctx.arc(cx - 14, 39, 3, 0, 7); ctx.fill(); }
      fill(C.WOOD); ctx.lineWidth = 3.5 + g; ctx.beginPath(); ctx.moveTo(cx + 11, 30); ctx.lineTo(cx + 23, 10); ctx.stroke(); // sword
      if (!outline) { fill(C.STEEL); ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(cx + 11, 30); ctx.lineTo(cx + 23, 10); ctx.stroke(); }
    } else if (kind === 'archer') {
      fill(C.KEY); rr(ctx, cx - 12 - g, 26 - g, 24 + g * 2, 30 + g * 2, 9); ctx.fill();              // tunic (team)
      if (!outline) { fill(C.LEA); rr(ctx, cx - 12, 47, 24, 9, 4); ctx.fill(); fill(C.LEAD); rr(ctx, cx - 12, 30, 5, 22, 3); ctx.fill(); } // skirt + quiver baldric
      fill(C.LEAD); rr(ctx, cx - 7 - g, 9 - g, 15 + g * 2, 15 + g * 2, 7); ctx.fill();               // hood
      if (!outline) { fill(C.SKIN); rr(ctx, cx - 4, 15, 9, 8, 4); ctx.fill(); }                       // face
      fill(C.WOOD); ctx.lineWidth = 4 + g; ctx.beginPath(); ctx.arc(cx + 13, 34, 18, -1.15, 1.15); ctx.stroke(); // bow
      if (!outline) { ctx.strokeStyle = '#d9cdb0'; ctx.lineWidth = 1.4; ctx.beginPath();
        ctx.moveTo(cx + 13 + 18 * Math.cos(-1.15), 34 + 18 * Math.sin(-1.15)); ctx.lineTo(cx + 13 + 18 * Math.cos(1.15), 34 + 18 * Math.sin(1.15)); ctx.stroke(); } // string
    }
  };
  draw(3.0, true);   // dark outline
  draw(0, false);    // coloured detail

  // ---- baked shading (survives the per-instance tint multiply) ----
  ctx.globalCompositeOperation = 'source-atop';
  // vertical: bright top highlight -> neutral -> deep bottom shadow (grounds it)
  const vg = ctx.createLinearGradient(0, 0, 0, S);
  vg.addColorStop(0, 'rgba(255,255,255,0.34)');
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

// The commissioned sepia sprites (inlined, background already removed). Loaded from a
// data URI — near-instant — and the green heraldry is colour-keyed to the faction
// in the soldier fragment shader. spriteAspect() drives the billboard's width:height.
export function makeSoldierTexture(kind: SpriteKind): THREE.Texture {
  const tex = new THREE.TextureLoader().load(SOLDIER_SPRITE[kind].png);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4; tex.needsUpdate = true;
  return tex;
}
export const spriteAspect = (kind: SpriteKind): number => SOLDIER_SPRITE[kind].aspect;

// (The old procedural toy-soldier drawing is kept below but unused now that we ship
// real art; makeArrowTexture still uses the canvas helpers.)

export function makeArrowTexture(): THREE.CanvasTexture {
  const [c, ctx] = newCanvas();
  ctx.strokeStyle = '#3a2c1a'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(S / 2, 14); ctx.lineTo(S / 2, S - 18); ctx.stroke();
  ctx.fillStyle = '#d8d8d8';
  ctx.beginPath(); ctx.moveTo(S / 2, 4); ctx.lineTo(S / 2 + 9, 20); ctx.lineTo(S / 2 - 9, 20); ctx.closePath(); ctx.fill();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
