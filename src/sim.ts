// Castle Hassle — battle simulation.
// Data-oriented: all soldiers live in flat typed arrays (Struct-of-Arrays) so
// we can push ~2000 agents with no per-entity GC churn. Movement uses a shared
// flow field per destination (no per-agent A*). Fixed-timestep & seeded so it's
// deterministic (replays / future PvP come cheap).

export const WORLD = { minX: -148, maxX: 148, minZ: -120, maxZ: 215 };
export const CELL = 2;
export const COLS = Math.round((WORLD.maxX - WORLD.minX) / CELL); // 100
export const ROWS = Math.round((WORLD.maxZ - WORLD.minZ) / CELL); // 90
export const NCELLS = COLS * ROWS;

export const enum Faction { Attacker = 0, Defender = 1 }
export const enum UType { Heavy = 0, Light = 1, Archer = 2, Cavalry = 3, Siege = 4 }

export const TYPE_NAME = ['Heavy Inf', 'Light Inf', 'Archers', 'Cavalry', 'Trebuchets'];

// ---- army composition (chosen on the muster screen before battle) ----
export interface ArmyComp { heavy: number; light: number; archer: number; cavalry: number; siege: number; }
// Persistent attacker upgrades (multipliers applied only to the player's army).
export interface AtkBuff { hp: number; melee: number; archer: number; fire: boolean; siege: number; reload: number; }
export const NO_BUFF: AtkBuff = { hp: 1, melee: 1, archer: 1, fire: false, siege: 1, reload: 1 };
export const COST = { heavy: 1.5, light: 1.0, archer: 1.3, cavalry: 2.0, siege: 70 };
export const BUDGET = 3200; // bigger castles + garrisons → a bigger assault army
export const DEFAULT_COMP: ArmyComp = { heavy: 600, light: 480, archer: 460, cavalry: 220, siege: 8 }; // ~3066 / 3200
export function compCost(c: ArmyComp): number { return c.heavy * COST.heavy + c.light * COST.light + c.archer * COST.archer + c.cavalry * COST.cavalry + c.siege * COST.siege; }
const AMMO = [0, 0, 16, 0, 16]; // arrows per archer / boulders per trebuchet

// Per-type stats, indexed by UType. (index 4 = siege engine / trebuchet)
const HP = [120, 70, 55, 95, 260];
const SPEED = [7, 11, 8, 17, 3.2];
const MELEE = [9, 7, 5, 15, 0];
const ATKCD = [0.8, 0.55, 1.3, 0.75, 6.5]; // trebuchets reload slowly
const RANGE = [1.8, 1.7, 40, 2.0, 110];   // siege = bombardment range
const SENSE = [16, 16, 46, 20, 110];
const SRAD = SENSE.map((s) => Math.max(1, Math.ceil(s / 6))); // hash search radius in buckets (hCell=6)
const RADIUS = [0.7, 0.6, 0.6, 0.95, 2.0];
const ARCHER_PROJ_DMG = 12;
const ARCHER_PROJ_SPEED = 32;
const BOULDER_DMG = 200;       // damage a trebuchet boulder does to a wall section
const BOULDER_SPEED = 30;
const BALLISTA_RANGE = 78;     // defensive ballista reach
const BALLISTA_DMG = 260;      // a bolt kills any infantryman it strikes
const BALLISTA_CD = 3.4;       // reload time
const BOLT_SPEED = 52;
const ARTY_SPLASH = 2.6;       // anti-personnel blast radius (very little spill)
const PROJ_G = 28; // projectile gravity (higher = more pronounced arc)
const ROUT_FRAC = 0.3;
const CAPTURE_TIME = 11;   // seconds holding the keep to raise your banner
const OBST_DIR: [number, number][] = Array.from({ length: 8 }, (_, a) => [Math.cos(a * Math.PI / 4), Math.sin(a * Math.PI / 4)]);

export function maxHp(t: UType) { return HP[t]; }

// ---- Procedural castle. A destructible AABB segment list (so all collision &
// siege mechanics work unchanged) plus a structured LAYOUT used for rendering
// and defender deployment. Bigger than before, varied per seed, with a town of
// buildings inside and (on larger ones) an inner CITADEL that must be taken. ----
export type SegKind = 'wall' | 'gate' | 'tower' | 'keep' | 'building';
export interface Seg { x0: number; x1: number; z0: number; z1: number; h: number; kind: SegKind; hp: number; maxhp: number; dead: boolean; }
export interface WallLine { x0: number; z0: number; x1: number; z1: number; horiz: boolean; outer: number; gapC: number; gapH: number; }
export interface Citadel { x0: number; x1: number; z0: number; z1: number; cx: number; cz: number; gate: { x: number; z: number }; wallLines: WallLine[]; }
// A scaling ladder raised against a wall section. Attackers queue at the foot
// and climb it single-file; `raise` animates it swinging up (0..1).
export interface Ladder { seg: number; along: number; bx: number; bz: number; horiz: boolean; outer: number; raise: number; }
// A defensive ballista emplacement on a stretch of wall: it shoots bolts at the
// attackers and is knocked out when the wall section under it (`seg`) is destroyed.
export interface Ballista { x: number; z: number; y: number; seg: number; horiz: boolean; outer: number; }
export interface CastleLayout {
  W: number; D: number; front: number; gate: { x: number; z: number };
  wallLines: WallLine[]; towers: { x: number; z: number; big: boolean }[];
  buildings: { x: number; z: number; w: number; d: number }[]; citadel: Citadel | null;
  round: boolean; concentric: boolean; ballistae: Ballista[]; palisade: boolean;
}
// Per-castle architectural style. Drives generateCastle so each real castle in
// the campaign has a distinguishable shape/silhouette (concentric double walls,
// round drum towers, wide walled town, lone keep, …) rather than one stamp.
export interface CastleStyle {
  scale: number;       // overall footprint multiplier (~0.8..1.4)
  aspect: number;      // W/D ratio (1 = square, >1 = wide town)
  concentric: boolean; // second, taller inner curtain wall that must also fall
  round: boolean;      // round drum towers instead of square ones
  strongKeep: boolean; // force a substantial inner citadel/keep
  town: number;        // building density 0..1 (higher = denser bailey)
  shape?: 'rect' | 'barbican' | 'twin';  // outer footprint: plain, fronted by a barbican bailey, or a flanking twin bailey (non-square)
  palisade?: boolean;  // a town behind low WOODEN walls: no towers, no stone, no engines — a soft raid target
}

export const T = 4, WH = 9, SEG = 8;
export const TOWERS: { x: number; z: number; big: boolean }[] = [];
export let CASTLE: Seg[] = [];
export let LAYOUT: CastleLayout = null as any;

function genRng(seed: number) { let s = (seed >>> 0) || 1; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function generateCastle(seed: number, style?: CastleStyle) {
  CASTLE = []; TOWERS.length = 0;
  const segs = CASTLE;
  const R = genRng(Math.imul(seed >>> 0, 2654435761) >>> 0);
  const rr = (a: number, b: number) => a + R() * (b - a);
  // Without an explicit campaign style (e.g. the menu backdrop), roll a random
  // one so the placeholder still varies seed-to-seed.
  const st: CastleStyle = style || {
    scale: rr(0.85, 1.25), aspect: rr(0.9, 1.5), concentric: R() < 0.4,
    round: R() < 0.5, strongKeep: R() < 0.6, town: rr(0.45, 0.75),
  };
  const pal = !!st.palisade; // a wooden-palisade town: no towers, weaker walls
  const wall = (x0: number, x1: number, z0: number, z1: number, kind: SegKind = 'wall', h = WH) => {
    if (x1 - x0 < 0.3 || z1 - z0 < 0.3) return;
    const hp = kind === 'gate' ? (pal ? 500 : 1100) : kind === 'building' ? 1e9 : (pal ? 650 : 1700);
    segs.push({ x0, x1, z0, z1, h: kind === 'gate' ? Math.max(5, h - 1) : h, kind, hp, maxhp: hp, dead: false });
  };
  const tower = (x: number, z: number, big: boolean, list?: { x: number; z: number; big: boolean }[]) => {
    if (pal) return; // a palisade town has no towers
    const r = big ? 5 : 4.2, hp = big ? 3200 : 2600;
    segs.push({ x0: x - r, x1: x + r, z0: z - r, z1: z + r, h: big ? WH + 6 : WH + 4, kind: 'tower', hp, maxhp: hp, dead: false });
    TOWERS.push({ x, z, big }); if (list) list.push({ x, z, big });
  };
  // a four-walled compound with a south gate; returns its wall-lines + towers
  const compound = (x0: number, x1: number, z0: number, z1: number, gateX: number, gh: number, gateOnSouth: boolean, tw?: { x: number; z: number; big: boolean }[], wh = WH) => {
    const lines: WallLine[] = [];
    for (let x = x0; x < x1 - 0.1; x += SEG) { const e = Math.min(x + SEG, x1), c = (x + e) / 2; wall(x, e, z1 - T, z1, gateOnSouth && Math.abs(c - gateX) < gh ? 'gate' : 'wall', wh); } // south
    for (let x = x0; x < x1 - 0.1; x += SEG) wall(x, Math.min(x + SEG, x1), z0, z0 + T, 'wall', wh); // north
    for (let z = z0; z < z1 - 0.1; z += SEG) { const e = Math.min(z + SEG, z1); wall(x0, x0 + T, z, e, 'wall', wh); wall(x1 - T, x1, z, e, 'wall', wh); } // w/e
    lines.push({ x0, z0: z1 - T / 2, x1, z1: z1 - T / 2, horiz: true, outer: 1, gapC: gateOnSouth ? gateX : 1e9, gapH: gh });
    lines.push({ x0, z0: z0 + T / 2, x1, z1: z0 + T / 2, horiz: true, outer: -1, gapC: 1e9, gapH: 0 });
    lines.push({ x0: x0 + T / 2, z0, x1: x0 + T / 2, z1, horiz: false, outer: -1, gapC: 1e9, gapH: 0 });
    lines.push({ x0: x1 - T / 2, z0, x1: x1 - T / 2, z1, horiz: false, outer: 1, gapC: 1e9, gapH: 0 });
    tower(x0, z0, false, tw); tower(x1, z0, false, tw); tower(x0, z1, false, tw); tower(x1, z1, false, tw);
    return lines;
  };

  // ----- outer compound (size & shape from the style; bigger later castles) -----
  const W = Math.max(40, Math.min(106, Math.round(rr(54, 64) * st.scale * Math.sqrt(st.aspect) / 2) * 2));
  const D = Math.max(36, Math.min(88, Math.round(rr(48, 56) * st.scale / Math.sqrt(st.aspect) / 2) * 2));
  const GH = 9, gateX = Math.round(rr(-W * 0.22, W * 0.22) / SEG) * SEG;
  // Concentric castles get a lower outer curtain (the inner ring towers over it);
  // a palisade town has only low wooden walls.
  const outerWH = pal ? 5 : st.concentric ? WH - 2 : WH;
  const wallLines = compound(-W, W, -D, D, gateX, GH, true, undefined, outerWH);
  // mid-wall towers
  const tSpace = st.round ? 26 : 28;
  for (let x = -W + tSpace; x < W - 18; x += tSpace) { tower(x, -D, false); if (Math.abs(x - gateX) > GH + 7) tower(x, D, false); }
  for (let z = -D + tSpace; z < D - 18; z += tSpace) { tower(-W, z, false); tower(W, z, false); }
  tower(gateX - GH - 3, D, true); tower(gateX + GH + 3, D, true); // gatehouse

  // ----- non-square footprint: a walled barbican bailey thrust out in front of
  // the gate (the attacker must storm it, cross the killing-ground, then the main
  // gate). 'twin' makes it broad like a second forebailey. -----
  let front = D, outerGateX = gateX;
  if (st.shape === 'barbican' || st.shape === 'twin') {
    const bhw = Math.min(W - 6, Math.round((st.shape === 'twin' ? rr(0.5, 0.66) : rr(0.32, 0.44)) * W));
    const bd = Math.round(st.shape === 'twin' ? rr(28, 40) : rr(20, 30));
    const bx0 = Math.max(-W, gateX - bhw), bx1 = Math.min(W, gateX + bhw), bz1 = D + bd;
    for (let x = bx0; x < bx1 - 0.1; x += SEG) { const e = Math.min(x + SEG, bx1), c = (x + e) / 2; wall(x, e, bz1 - T, bz1, Math.abs(c - gateX) < GH ? 'gate' : 'wall'); } // south face + outer gate
    for (let z = D; z < bz1 - 0.1; z += SEG) { const e = Math.min(z + SEG, bz1); wall(bx0, bx0 + T, z, e, 'wall'); wall(bx1 - T, bx1, z, e, 'wall'); } // flanks (north side stays open to the main gate)
    wallLines.push({ x0: bx0, z0: bz1 - T / 2, x1: bx1, z1: bz1 - T / 2, horiz: true, outer: 1, gapC: gateX, gapH: GH });
    wallLines.push({ x0: bx0 + T / 2, z0: D, x1: bx0 + T / 2, z1: bz1, horiz: false, outer: -1, gapC: 1e9, gapH: 0 });
    wallLines.push({ x0: bx1 - T / 2, z0: D, x1: bx1 - T / 2, z1: bz1, horiz: false, outer: 1, gapC: 1e9, gapH: 0 });
    tower(bx0, bz1, false); tower(bx1, bz1, false); tower(gateX - GH - 3, bz1, true); tower(gateX + GH + 3, bz1, true);
    front = bz1; outerGateX = gateX;
  }

  // ----- inner stronghold -----
  let citadel: Citadel | null = null;
  const cTowers: { x: number; z: number; big: boolean }[] = [];
  if (st.concentric) {
    // A full, taller inner ward concentric with the outer curtain — the attacker
    // must breach two rings (Krak des Chevaliers, Dover, Caerphilly, Harlech).
    const cw = Math.round(W * 0.52 / SEG) * SEG, cd = Math.round(D * 0.52 / SEG) * SEG;
    const ccx = 0, ccz = -Math.round(D * 0.1);
    const igX = Math.round(rr(-cw * 0.35, cw * 0.35) / SEG) * SEG; // inner gate offset from outer (bent entry)
    const cLines = compound(ccx - cw, ccx + cw, ccz - cd, ccz + cd, ccx + igX, 6, true, cTowers, WH + 4);
    tower(ccx, ccz, true, cTowers); // corner drums on the inner ward
    segs.push({ x0: ccx - 8, x1: ccx + 8, z0: ccz - 7, z1: ccz + 7, h: 24, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
    citadel = { x0: ccx - cw, x1: ccx + cw, z0: ccz - cd, z1: ccz + cd, cx: ccx, cz: ccz, gate: { x: ccx + igX, z: ccz + cd }, wallLines: cLines };
  } else if (!pal && (st.strongKeep || W * D > 3200 || R() < 0.45)) {
    // an offset inner bailey + keep
    const cw = 19, cd = 15, ccx = Math.round(rr(-W * 0.18, W * 0.18)), ccz = -Math.round(D * 0.34);
    const cLines = compound(ccx - cw, ccx + cw, ccz - cd, ccz + cd, ccx, 6, true, cTowers);
    segs.push({ x0: ccx - 7, x1: ccx + 7, z0: ccz - 6, z1: ccz + 6, h: st.strongKeep ? 24 : 21, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
    citadel = { x0: ccx - cw, x1: ccx + cw, z0: ccz - cd, z1: ccz + cd, cx: ccx, cz: ccz, gate: { x: ccx, z: ccz + cd }, wallLines: cLines };
  } else {
    // a lone keep dominating an open bailey — a lord's manor in a palisade town
    const kh = pal ? 13 : 20, kr = pal ? 7 : 9;
    segs.push({ x0: -kr, x1: kr, z0: -kr, z1: kr, h: kh, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
  }

  // ----- town buildings in the bailey (avoid walls, the gate avenue & citadel) -----
  const keepProb = 1 - st.town; // chance a slot is left empty
  const buildings: { x: number; z: number; w: number; d: number }[] = [];
  for (let bx = -W + 14; bx < W - 14; bx += rr(13, 18)) {
    for (let bz = -D + 14; bz < D - 14; bz += rr(12, 17)) {
      if (R() < keepProb) continue;
      const bw = rr(3.5, 6.5), bd = rr(3.5, 5.5), x = bx + rr(0, 4), z = bz + rr(0, 4);
      if (Math.abs(x - gateX) < 9 && z > -D * 0.1) continue;                 // keep the gate avenue clear
      if (citadel && x > citadel.x0 - 7 && x < citadel.x1 + 7 && z > citadel.z0 - 7 && z < citadel.z1 + 7) continue;
      if (!citadel && x * x + z * z < 18 * 18) continue;                      // open plaza around the lone keep/manor so it can be stormed and held
      if (x - bw < -W + T + 3 || x + bw > W - T - 3 || z - bd < -D + T + 3 || z + bd > D - T - 3) continue;
      wall(x - bw, x + bw, z - bd, z + bd, 'building', rr(5, 9)); buildings.push({ x, z, w: bw, d: bd });
    }
  }

  // ----- wall-mounted ballistae: spaced along the curtain (and citadel), each
  // tied to the wall segment beneath it so a breach knocks it out -----
  const segAt = (x: number, z: number): number => {
    for (let i = 0; i < segs.length; i++) { const b = segs[i]; if ((b.kind === 'wall' || b.kind === 'gate') && x >= b.x0 - 0.6 && x <= b.x1 + 0.6 && z >= b.z0 - 0.6 && z <= b.z1 + 0.6) return i; }
    return -1;
  };
  const ballistae: Ballista[] = [];
  const placeBallistae = (lines: WallLine[], step: number, cap: number) => {
    for (const ln of lines) {
      const a0 = (ln.horiz ? ln.x0 : ln.z0), a1 = (ln.horiz ? ln.x1 : ln.z1);
      for (let a = a0 + step * 0.6; a < a1 - step * 0.4 && ballistae.length < cap; a += step) {
        if (Math.abs(a - ln.gapC) < ln.gapH + 4) continue;            // not over the gate
        const x = ln.horiz ? a : ln.x0, z = ln.horiz ? ln.z0 : a;
        const seg = segAt(x, z); if (seg < 0) continue;
        // widen that wall section into a firing platform so the engine fits
        const b = segs[seg]; if (ln.horiz) { b.x0 -= 1.6; b.x1 += 1.6; } else { b.z0 -= 1.6; b.z1 += 1.6; }
        ballistae.push({ x, z: z - ln.outer * 0.6, y: WH, seg, horiz: ln.horiz, outer: ln.outer });
      }
    }
  };
  if (!pal) { // a town has no wall engines either
    const outerCap = Math.round(rr(3, 5) + W * D / 1700); // more on bigger castles
    placeBallistae(wallLines, 30, outerCap);
    if (citadel) placeBallistae(citadel.wallLines, 22, ballistae.length + 3);
  }

  LAYOUT = { W, D, front, gate: { x: outerGateX, z: front }, wallLines, towers: [...TOWERS], buildings, citadel, round: st.round, concentric: st.concentric, ballistae, palisade: pal };
  rebuildBlocked();
}

function blockedAt(x: number, z: number): boolean {
  for (let i = 0; i < CASTLE.length; i++) {
    const b = CASTLE[i];
    if (!b.dead && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
  }
  return false;
}
// The standing castle section a point falls inside, or -1 for open ground. Towers
// win ties over the walls they abut (they're the solid mass actually in the way),
// so a boulder coming down on a tower hits the tower, not a wall behind it. The
// keep is never returned (it's the prize, not a bombardment target).
function structureAt(x: number, z: number): number {
  let hit = -1, towerHit = -1;
  for (let i = 0; i < CASTLE.length; i++) {
    const b = CASTLE[i];
    if (b.dead || b.kind === 'keep') continue;
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) { if (b.kind === 'tower') towerHit = i; else if (hit < 0) hit = i; }
  }
  return towerHit >= 0 ? towerHit : hit;
}
// Height of the tallest standing structure covering a point (0 if open ground).
function heightAt(x: number, z: number): number {
  let h = 0;
  for (let i = 0; i < CASTLE.length; i++) {
    const b = CASTLE[i];
    if (!b.dead && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.h > h) h = b.h;
  }
  return h;
}

export function cellOf(x: number, z: number): number {
  let c = Math.floor((x - WORLD.minX) / CELL);
  let r = Math.floor((z - WORLD.minZ) / CELL);
  if (c < 0) c = 0; else if (c >= COLS) c = COLS - 1;
  if (r < 0) r = 0; else if (r >= ROWS) r = ROWS - 1;
  return r * COLS + c;
}
function cellCenter(idx: number): [number, number] {
  const c = idx % COLS, r = (idx - c) / COLS;
  return [WORLD.minX + (c + 0.5) * CELL, WORLD.minZ + (r + 0.5) * CELL];
}

// Which cells are blocked — recomputed whenever a wall section is destroyed.
const BLOCKED = new Uint8Array(NCELLS);
function rebuildBlocked() {
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const [x, z] = cellCenter(r * COLS + c);
    BLOCKED[r * COLS + c] = blockedAt(x, z) ? 1 : 0;
  }
}
// Build a default castle at module load so CASTLE/LAYOUT are never null. (Now
// that BLOCKED + rebuildBlocked exist, generateCastle's rebuild call is safe.)
generateCastle(1);

// Is the straight segment a->b obstructed by a (live) wall? Used so troops only
// fall back to flow-field routing when a wall is actually in the way — otherwise
// they steer straight to their formation slot (no clumping at a single cell).
function pathBlocked(x0: number, z0: number, x1: number, z1: number): boolean {
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 3));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (blockedAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return true;
  }
  return false;
}

// ---- Flow field via Dijkstra (8-neighbour) ----
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]] as const;

function computeField(goal: number): Float32Array {
  // cost MUST be float64: storing path costs in a Float32Array rounds them, so
  // the stale-node check `co > cost[cell]` (co is full-precision) spuriously
  // skips valid expansions and the field only partially fills.
  const cost = new Float64Array(NCELLS).fill(Infinity);
  const dir = new Float32Array(NCELLS * 2); // (dx,dz) toward goal
  // simple binary heap
  const heap: number[] = []; const hcost: number[] = [];
  const push = (cell: number, co: number) => {
    heap.push(cell); hcost.push(co);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (hcost[p] <= hcost[i]) break;
      [hcost[p], hcost[i]] = [hcost[i], hcost[p]]; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], tc = hcost[0]; const last = heap.length - 1;
    heap[0] = heap[last]; hcost[0] = hcost[last]; heap.pop(); hcost.pop();
    let i = 0; const n = heap.length;
    while (true) { let l = i * 2 + 1, r = l + 1, m = i;
      if (l < n && hcost[l] < hcost[m]) m = l; if (r < n && hcost[r] < hcost[m]) m = r;
      if (m === i) break; [hcost[m], hcost[i]] = [hcost[i], hcost[m]]; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; }
    return [top, tc] as const;
  };
  cost[goal] = 0; push(goal, 0);
  while (heap.length) {
    const [cell, co] = pop();
    if (co > cost[cell]) continue;
    const cc = cell % COLS, cr = (cell - cc) / COLS;
    for (let k = 0; k < 8; k++) {
      const nc = cc + NB[k][0], nr = cr + NB[k][1];
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      const ni = nr * COLS + nc;
      if (BLOCKED[ni]) continue;
      // no diagonal corner-cutting: both orthogonal cells must be open
      if (k >= 4 && (BLOCKED[cr * COLS + nc] || BLOCKED[nr * COLS + cc])) continue;
      const ncost = co + NB[k][2];
      if (ncost < cost[ni]) { cost[ni] = ncost; push(ni, ncost); }
    }
  }
  // gradient: each cell points to lowest-cost neighbour
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    if (BLOCKED[i] || cost[i] === Infinity) continue;
    let best = cost[i], bx = 0, bz = 0;
    for (let k = 0; k < 8; k++) {
      const nc = c + NB[k][0], nr = r + NB[k][1];
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      const ni = nr * COLS + nc;
      if (k >= 4 && (BLOCKED[r * COLS + nc] || BLOCKED[nr * COLS + c])) continue; // no corner-cut
      if (cost[ni] < best) { best = cost[ni]; bx = NB[k][0]; bz = NB[k][1]; }
    }
    const len = Math.hypot(bx, bz) || 1;
    dir[i * 2] = bx / len; dir[i * 2 + 1] = bz / len;
  }
  return dir;
}

export interface Unit {
  id: number; faction: Faction; type: UType;
  div: number;             // player division this company belongs to (UType for the player, -1 for defenders)
  s0: number; count: number; alive: number;
  morale: number; routing: boolean; hold: boolean;
  goal: number;            // flow-field goal cell (for long-range routing to the anchor)
  ax: number; az: number;  // formation anchor (centre)
  facing: number;          // direction the unit faces (forward = (sin f, cos f))
  cols: number;            // formation width in soldiers
  cx: number; cz: number;  // live centroid
  siegeTargetSeg: number;  // wall section a trebuchet battery is ordered to hit (-1 = auto)
  ammo: number; ammoMax: number; // live + starting ammunition (ranged units)
  focusX: number; focusZ: number; hasFocus: boolean; // archer aim point (focus fire)
  fireArrows: boolean; // tower archers loose flaming arrows
  holdFire: boolean;   // ceasefire — ranged unit won't auto-loose (saves ammo)
  assault: boolean;    // committed to storm the keep (vs holding its deployed line)
  name: string;
}

// per-type formation spacing
const SPACING = [1.5, 1.3, 1.4, 2.1, 10];
const ENGAGE = 9; // range at which troops break formation to fight
// How close a company's body must be to its ordered ground before its men will
// peel off to chase a nearby enemy. While still marching to an objective they
// hold course (and only trade blows with whatever they make actual contact with),
// so an ordered move isn't derailed by every skirmisher along the way.
const CHASE_LEASH = 22;

export interface Projectile {
  active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  tx: number; tz: number; ty: number; dmg: number; fac: Faction;
  wall: number;   // target wall-segment index for boulders, else -1
  big: boolean;   // boulder vs arrow (render size)
  fire: boolean;  // flaming arrow (tower archers)
  splash: number; // anti-personnel blast radius on impact (0 = single arrow)
  bolt: boolean;  // ballista bolt (render as a big bolt, not an arrow)
}
// A defensive ballista on the wall: fires bolts at the attackers; dead once the
// wall segment beneath it is breached.
export interface Emplacement { x: number; z: number; y: number; seg: number; cd: number; recoil: number; horiz: boolean; outer: number; aimX: number; aimZ: number; }

export class Sim {
  // Must exceed the total soldier count (currently ~2,220). If it's too small,
  // overflow soldiers have no backing storage: typed-array writes are silently
  // dropped and reads return undefined, which crashed the renderer
  // (this.meshes[undefined].setMatrixAt). Keep generous headroom.
  MAX = 4800;
  px = new Float32Array(this.MAX); pz = new Float32Array(this.MAX); py = new Float32Array(this.MAX);
  vx = new Float32Array(this.MAX); vz = new Float32Array(this.MAX);
  hp = new Float32Array(this.MAX); cd = new Float32Array(this.MAX);
  unit = new Int16Array(this.MAX); fac = new Uint8Array(this.MAX); typ = new Uint8Array(this.MAX);
  alive = new Uint8Array(this.MAX); slot = new Int32Array(this.MAX);
  ammo = new Float32Array(this.MAX);
  // wall-scaling: 0 ground, 1 climbing up, 2 on wall-top, 3 descending inside
  climbState = new Uint8Array(this.MAX); climbSeg = new Int16Array(this.MAX);
  climbLadder = new Int16Array(this.MAX).fill(-1); // ladder a climber is on (-1 = direct/none)
  ladders: Ladder[] = [];
  private ladderMinPy: number[] = []; // lowest occupied height per ladder (single-file gating)
  private attInsideCount = 0;         // attackers standing inside the walls
  captureProgress = 0;                // 0..1 — your banner rising over the keep
  private keepX = 0; private keepZ = 0; private captureR = 20;
  n = 0;
  units: Unit[] = [];
  typeCount = [0, 0, 0, 0, 0];
  fields = new Map<number, Float32Array>();
  projectiles: Projectile[] = [];
  ballistae: Emplacement[] = [];
  private _near = new Int32Array(this.MAX).fill(-1); // cached target per soldier (throttled re-scan)
  private _frame = 0;
  phase: 'deploy' | 'battle' | 'over' = 'deploy';
  winner: Faction | null = null;
  retreated = false;   // the player sounded the retreat (vs being beaten outright)
  private seed: number;
  private comp: ArmyComp;
  attackerAliveStart = 0; defenderAliveStart = 0;

  private difficulty: number;
  constructor(seed = 1234, comp: ArmyComp = DEFAULT_COMP, difficulty = 1, style?: CastleStyle, atk: AtkBuff = NO_BUFF) { this.seed = seed >>> 0; this.comp = comp; this.difficulty = difficulty; this.atk = atk; generateCastle(seed, style); this.setup(); }
  atk: AtkBuff = NO_BUFF;

  private rnd() { // mulberry32
    this.seed |= 0; this.seed = (this.seed + 0x6D2B79F5) | 0;
    let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private field(goal: number): Float32Array {
    let f = this.fields.get(goal);
    if (!f) { f = computeField(goal); this.fields.set(goal, f); }
    return f;
  }

  private addUnit(faction: Faction, type: UType, count: number,
                  place: (i: number) => [number, number, number], opts: Partial<Unit> = {}): Unit {
    count = Math.max(0, Math.min(count, this.MAX - this.n)); // clamp to the hard cap (never crash)
    const s0 = this.n;
    let sx = 0, sz = 0;
    for (let i = 0; i < count; i++) {
      const id = this.n++;
      const [x, z, y] = place(i);
      this.px[id] = x; this.pz[id] = z; this.py[id] = y; sx += x; sz += z;
      this.hp[id] = HP[type] * (faction === Faction.Attacker ? this.atk.hp : 1); this.cd[id] = this.rnd() * 0.5; this.ammo[id] = AMMO[type];
      this.unit[id] = this.units.length; this.fac[id] = faction; this.typ[id] = type;
      this.alive[id] = 1; this.slot[id] = this.typeCount[type]++;
    }
    const ax = count ? sx / count : 0, az = count ? sz / count : 0;
    const u: Unit = {
      id: this.units.length, faction, type, div: opts.div ?? -1, s0, count, alive: count,
      morale: 100, routing: false, hold: !!opts.hold,
      goal: opts.goal ?? cellOf(ax, az),
      ax, az,
      facing: Math.atan2(0 - ax, 0 - az), // face the castle (origin) by default
      cols: opts.cols ?? (type === UType.Siege ? count : Math.max(6, Math.round(Math.sqrt(count) * 1.7))),
      cx: ax, cz: az, siegeTargetSeg: -1,
      ammo: AMMO[type] * count, ammoMax: AMMO[type] * count,
      focusX: 0, focusZ: 0, hasFocus: false, fireArrows: !!opts.fireArrows,
      holdFire: false, assault: false,
      name: opts.name ?? TYPE_NAME[type],
    };
    this.units.push(u);
    return u;
  }

  // World position of soldier index k's slot within its unit's formation.
  private slotPos(u: Unit, k: number): [number, number] {
    const sp = SPACING[u.type];
    const cols = Math.max(1, u.cols);
    const rows = Math.ceil(u.count / cols);
    const col = k % cols, row = (k - col) / cols;
    const fx = Math.sin(u.facing), fz = Math.cos(u.facing); // forward
    const rx = Math.cos(u.facing), rz = -Math.sin(u.facing); // right
    const lr = (col - (cols - 1) / 2) * sp;
    const lf = ((rows - 1) / 2 - row) * sp;
    return [u.ax + rx * lr + fx * lf, u.az + rz * lr + fz * lf];
  }

  private setup() {
    this.ladders = []; this.climbLadder.fill(-1);
    const R = (a: number, b: number) => a + this.rnd() * (b - a);
    // grid block placement helper
    const block = (cx: number, cz: number, cols: number, gap: number) => (i: number): [number, number, number] => {
      const c = i % cols, r = Math.floor(i / cols);
      return [cx + (c - cols / 2) * gap + R(-0.4, 0.4), cz + r * gap + R(-0.4, 0.4), 0];
    };

    const L = LAYOUT, W = L.W, D = L.D;
    const C = this.comp; const cols = (n: number) => Math.max(8, Math.round(Math.sqrt(n) * 1.7));

    // ---------------- DEFENDERS (generated from the layout) ----------------
    // archers lined along a set of wall-lines (two ranks, inset from corners/gate)
    const archersOnLines = (lines: WallLine[], spacing: number, inset: number, wallTop = WH): [number, number, number][] => {
      const pts: [number, number, number][] = [];
      for (const ln of lines) {
        const a0 = (ln.horiz ? ln.x0 : ln.z0) + inset, a1 = (ln.horiz ? ln.x1 : ln.z1) - inset;
        for (let a = a0; a <= a1; a += spacing) {
          if (Math.abs(a - ln.gapC) < ln.gapH + 1) continue; // leave the gate clear
          for (let rk = 0; rk < 2; rk++) {
            const off = -ln.outer * rk * 1.3;
            pts.push(ln.horiz ? [a, ln.z0 + off, wallTop] : [ln.x0 + off, a, wallTop]);
          }
        }
      }
      return pts;
    };
    const cit = L.citadel;
    const openBailey = (): [number, number, number] => {
      let x = 0, z = 0;
      for (let t = 0; t < 50; t++) {
        x = R(-(W - T - 2), W - T - 2); z = R(-(D - T - 2), D - T - 2);
        if (blockedAt(x, z)) continue;
        if (cit && x > cit.x0 - 2 && x < cit.x1 + 2 && z > cit.z0 - 2 && z < cit.z1 + 2) continue;
        return [x, z, 0];
      }
      return [x, z, 0];
    };
    const inCit = (): [number, number, number] => {
      let x = 0, z = 0;
      for (let t = 0; t < 40; t++) { x = R(cit!.x0 + T + 1, cit!.x1 - T - 1); z = R(cit!.z0 + T + 1, cit!.z1 - T - 1); if (!blockedAt(x, z)) return [x, z, 0]; }
      return [x, z, 0];
    };
    // pre-compute every defender count, then scale BOTH armies to a total cap so
    // huge late-campaign sieges stay performant (and never blow the soldier cap).
    // A palisade town is a soft raid: only a sparse picket lines the low wall (so
    // it can't hide behind unreachable archers), and the militia fights on the
    // ground where your infantry can cut it down — a raid you win by routing the
    // defenders, not by a grinding siege.
    const wallPts = archersOnLines(L.wallLines, L.palisade ? 16 : 2.6, 6, L.palisade ? 5 : WH);
    const NT = TOWERS.length;
    const garr = Math.round((L.palisade ? Math.max(140, Math.min(300, Math.round(W * D / 16))) : Math.max(280, Math.min(560, Math.round(W * D / 14)))) * this.difficulty);
    const reserves = Math.round(garr * (L.palisade ? 0.35 : 0.6));
    const citGuard = cit ? Math.round(220 * this.difficulty) : 0;
    const cPts = cit ? archersOnLines(cit.wallLines, 2.4, 4) : [];
    const attReq = C.heavy + C.light + C.archer + C.cavalry;
    const defReq = wallPts.length + NT * 4 + garr + reserves + citGuard + cPts.length;
    const TARGET = 3900; // total foot soldiers (trebuchets excluded) — big but smooth
    const scale = Math.min(1, TARGET / Math.max(1, attReq + defReq));
    const S = (n: number) => Math.max(0, Math.round(n * scale));

    // ---------------- ATTACKERS (south of the castle, player) ----------------
    // Each arm is split into small companies (30–50) drawn up in a grid, so your
    // army reads as ranks of companies, not a horde. You still command each ARM
    // (division) as one — orders fan out to all its companies.
    const F = L.front; // southern extent (past any barbican) — deploy beyond it
    const division = (total: number, type: UType, cx: number, cz: number, gap: number, name: string) => {
      if (total <= 0) return;
      const across = Math.max(1, Math.round(Math.sqrt(Math.ceil(total / 40) * 1.6)));
      let left = total, k = 0, idx = 0;
      while (left > 0) {
        const c = Math.min(left, 30 + Math.floor(this.rnd() * 21));
        const col = k % across, row = Math.floor(k / across);
        const ax = cx + (col - (across - 1) / 2) * 17, az = cz + row * 13;
        const ccols = Math.max(3, Math.round(Math.sqrt(c) * 1.4));
        this.addUnit(Faction.Attacker, type, c, block(ax, az, ccols, gap), { name: `${name} ${++idx}`, cols: ccols, div: type });
        left -= c; k++;
      }
    };
    division(S(C.heavy), UType.Heavy, 0, F + 40, 1.6, 'Heavy Inf');
    division(S(C.light), UType.Light, -W * 0.78, F + 56, 1.4, 'Light Inf');
    division(S(C.archer), UType.Archer, 0, F + 74, 1.5, 'Archers');
    division(S(C.cavalry), UType.Cavalry, W * 0.86, F + 56, 2.2, 'Cavalry');
    if (C.siege) this.addUnit(Faction.Attacker, UType.Siege, C.siege, block(0, F + 92, C.siege, 13), { name: 'Trebuchets', cols: C.siege, div: UType.Siege });

    // wall archers, then flaming tower archers on every tower top
    this.addUnit(Faction.Defender, UType.Archer, S(wallPts.length), (i) => wallPts[i], { hold: true, name: 'Wall Archers' });
    this.addUnit(Faction.Defender, UType.Archer, S(NT * 4), (i) => {
      const tw = TOWERS[Math.floor(i / 4) % NT], k = i % 4;
      return [tw.x + (k % 2 - 0.5) * 2.2, tw.z + (Math.floor(k / 2) - 0.5) * 2.2, tw.big ? WH + 6 : WH + 4];
    }, { hold: true, fireArrows: true, name: 'Tower Archers' });
    // garrison + reserves: split into small companies (30–50 men) drawn up in
    // neat grid blocks (like the attackers), each manoeuvring, counter-attacking
    // and BREAKING as its own body — an army of companies, not one blob.
    const companies = (total: number, type: UType, anchor: () => [number, number, number], name: string) => {
      let left = total, idx = 0;
      while (left > 0) {
        const c = Math.min(left, 30 + Math.floor(this.rnd() * 21)); const [ax, az] = anchor();
        const cols = Math.max(4, Math.round(Math.sqrt(c) * 1.4));
        this.addUnit(Faction.Defender, type, c, block(ax, az, cols, type === UType.Light ? 1.4 : 1.6), { hold: true, name: `${name} ${++idx}`, cols });
        left -= c;
      }
    };
    companies(S(garr), UType.Heavy, openBailey, 'Garrison');
    companies(S(reserves), UType.Light, openBailey, 'Reserves');
    // citadel garrison (in companies) + its own wall archers (the last redoubt)
    if (cit) {
      companies(S(citGuard), UType.Heavy, inCit, 'Citadel Guard');
      this.addUnit(Faction.Defender, UType.Archer, S(cPts.length), (i) => cPts[i], { hold: true, name: 'Citadel Archers' });
    }

    for (const u of this.units) {
      if (u.faction === Faction.Attacker) this.attackerAliveStart += u.count;
      else this.defenderAliveStart += u.count;
    }
    // the keep is the prize: hold its ground to raise your banner over it
    const keep = CASTLE.find(b => b.kind === 'keep'); const citd = LAYOUT.citadel;
    this.keepX = citd ? citd.cx : keep ? (keep.x0 + keep.x1) / 2 : 0;
    this.keepZ = citd ? citd.cz : keep ? (keep.z0 + keep.z1) / 2 : 0;
    // a town is taken by storming its whole centre, not a tight keep-hold
    this.captureR = citd ? Math.max(20, (citd.x1 - citd.x0) / 2 + 4) : LAYOUT.palisade ? Math.max(28, Math.min(W, D) - 4) : 20;
    // defensive ballistae from the layout (staggered initial reload)
    this.ballistae = LAYOUT.ballistae.map(b => ({ x: b.x, z: b.z, y: b.y, seg: b.seg, cd: this.rnd() * BALLISTA_CD, recoil: 0, horiz: b.horiz, outer: b.outer, aimX: b.x, aimZ: b.z + b.outer * 40 }));
  }

  private setAnchor(u: Unit, x: number, z: number, facing: number, cols: number) {
    u.ax = Math.max(WORLD.minX + 2, Math.min(WORLD.maxX - 2, x));
    u.az = Math.max(WORLD.minZ + 2, Math.min(WORLD.maxZ - 2, z));
    u.facing = facing;
    // trebuchets line up in a single rank so they spread along the emplacement
    u.cols = u.type === UType.Siege ? u.count : Math.max(3, Math.min(u.count, Math.round(cols)));
    u.hold = false;
    let cell = cellOf(u.ax, u.az);
    if (BLOCKED[cell]) cell = cellOf(u.ax, u.az + 5); // nudge the flow goal off walls
    u.goal = cell;
    this.field(cell);
    // During pre-battle setup, don't make the player wait for the column to
    // march — snap the company straight into its formation where it's placed.
    if (this.phase === 'deploy') this.snapUnit(u);
  }

  // Teleport every soldier of a unit onto its formation slot (used in deploy).
  private snapUnit(u: Unit) {
    const t = u.type, sp = SPACING[t], cols = Math.max(1, u.cols), rows = Math.ceil(u.count / cols);
    const ffx = Math.sin(u.facing), ffz = Math.cos(u.facing), rrx = Math.cos(u.facing), rrz = -Math.sin(u.facing);
    for (let i = u.s0; i < u.s0 + u.count; i++) {
      if (!this.alive[i]) continue;
      const k = i - u.s0, col = k % cols, row = (k - col) / cols;
      const lr = (col - (cols - 1) / 2) * sp, lf = ((rows - 1) / 2 - row) * sp;
      this.px[i] = u.ax + rrx * lr + ffx * lf; this.pz[i] = u.az + rrz * lr + ffz * lf;
      this.vx[i] = 0; this.vz[i] = 0;
    }
    u.cx = u.ax; u.cz = u.az;
  }

  // Quick move: form up centred on a point, facing the castle (origin).
  orderMove(unitId: number, x: number, z: number) {
    const u = this.units[unitId];
    if (!u || u.faction !== Faction.Attacker || u.routing) return;
    const facing = Math.atan2(0 - x, 0 - z);
    this.setAnchor(u, x, z, facing, Math.round(Math.sqrt(u.count) * 1.7));
  }

  // Formation line: the unit lines up along the drag P0->P1, facing the side
  // toward the castle. Width of the drag sets the formation width.
  orderFormation(unitId: number, x0: number, z0: number, x1: number, z1: number) {
    const u = this.units[unitId];
    if (!u || u.faction !== Faction.Attacker || u.routing) return;
    const dx = x1 - x0, dz = z1 - z0;
    const width = Math.hypot(dx, dz);
    if (width < 4) { this.orderMove(unitId, x1, z1); return; }
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    const rx = dx / width, rz = dz / width;        // line (right) axis
    // two perpendicular candidates; pick the one pointing toward the castle
    let fx = -rz, fz = rx;
    if (fx * (0 - mx) + fz * (0 - mz) < 0) { fx = -fx; fz = -fz; }
    const facing = Math.atan2(fx, fz);
    const cols = Math.round(width / SPACING[u.type]) + 1;
    this.setAnchor(u, mx, mz, facing, cols);
  }

  // ---- division (player-arm) commands: orders fan out to every company ----
  divCompanies(div: number): Unit[] { return this.units.filter(u => u.faction === Faction.Attacker && u.div === div && u.alive > 0); }
  // aggregate stats for the HUD card of a whole arm
  divAgg(div: number): { type: UType; count: number; alive: number; ammo: number; ammoMax: number; cx: number; cz: number; routing: boolean } {
    let count = 0, alive = 0, ammo = 0, ammoMax = 0, sx = 0, sz = 0, type = div as UType, anyFight = false;
    for (const u of this.units) {
      if (u.faction !== Faction.Attacker || u.div !== div) continue;
      type = u.type; count += u.count; alive += u.alive; ammo += u.ammo; ammoMax += u.ammoMax;
      if (u.alive > 0) { sx += u.cx * u.alive; sz += u.cz * u.alive; if (!u.routing) anyFight = true; }
    }
    return { type, count, alive, ammo, ammoMax, cx: alive ? sx / alive : 0, cz: alive ? sz / alive : 0, routing: !anyFight };
  }
  // Lay the whole arm out across the dragged line as a grid of company blocks.
  orderDivision(div: number, x0: number, z0: number, x1: number, z1: number) {
    const comps = this.divCompanies(div); const n = comps.length; if (!n) return;
    let dx = x1 - x0, dz = z1 - z0, w = Math.hypot(dx, dz);
    let facing: number, ox = x0, oz = z0;
    if (w < 4) { // a tap: build a line centred on the point, facing the castle
      facing = Math.atan2(0 - x1, 0 - z1);
      const across0 = Math.max(1, Math.round(Math.sqrt(n))), lineW = across0 * 15;
      const rx = Math.cos(facing), rz = -Math.sin(facing);
      ox = x1 - rx * lineW / 2; oz = z1 - rz * lineW / 2; dx = rx * lineW; dz = rz * lineW; w = lineW;
    } else {
      let fx = -dz / w, fz = dx / w; const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      if (fx * (0 - mx) + fz * (0 - mz) < 0) { fx = -fx; fz = -fz; }
      facing = Math.atan2(fx, fz);
    }
    const fx = Math.sin(facing), fz = Math.cos(facing);
    const across = Math.max(1, Math.min(n, Math.round(w / 16)));
    for (let k = 0; k < n; k++) {
      const col = k % across, row = Math.floor(k / across);
      const t = across > 1 ? (col + 0.5) / across : 0.5;
      const cx = ox + dx * t - fx * row * 10, cz = oz + dz * t - fz * row * 10;  // rows stack behind
      const u = comps[k]; u.assault = false; this.setAnchor(u, cx, cz, facing, Math.max(3, Math.round(Math.sqrt(u.count) * 1.4)));
    }
  }
  setSiegeTargetDiv(div: number, segIdx: number) { for (const u of this.divCompanies(div)) { u.siegeTargetSeg = segIdx; u.holdFire = false; } }
  setFocusDiv(div: number, x: number, z: number) { for (const u of this.divCompanies(div)) { u.hasFocus = true; u.focusX = x; u.focusZ = z; } }
  clearFocusDiv(div: number) { for (const u of this.divCompanies(div)) u.hasFocus = false; }
  toggleHoldFireDiv(div: number): boolean { const cs = this.divCompanies(div); if (!cs.length) return false; const v = !cs[0].holdFire; for (const u of cs) u.holdFire = v; return v; }
  // the player's arms present in this battle, in roster order
  playerDivs(): number[] { const set = new Set<number>(); for (const u of this.units) if (u.faction === Faction.Attacker && u.count > 0) set.add(u.div); return [...set].sort((a, b) => a - b); }

  // ---- trebuchet target selection ----
  // Nearest still-standing wall/gate section to a tapped point (or -1).
  wallSegAt(x: number, z: number, maxDist = 14): number {
    let best = -1, bd = maxDist * maxDist;
    for (let s = 0; s < CASTLE.length; s++) {
      const seg = CASTLE[s];
      if (seg.dead || seg.kind === 'keep') continue; // walls, gate AND towers are targetable
      const cx = Math.max(seg.x0, Math.min(seg.x1, x)), cz = Math.max(seg.z0, Math.min(seg.z1, z));
      const d2 = (cx - x) ** 2 + (cz - z) ** 2;
      if (d2 < bd) { bd = d2; best = s; }
    }
    return best;
  }
  setSiegeTarget(unitId: number, segIdx: number) {
    const u = this.units[unitId];
    if (u && u.type === UType.Siege) { u.siegeTargetSeg = segIdx; u.holdFire = false; } // aiming resumes fire
  }
  // ceasefire toggle for a ranged unit (archers / trebuchets) so a distracted
  // player doesn't burn all their ammo. Returns the new state.
  toggleHoldFire(unitId: number): boolean {
    const u = this.units[unitId];
    if (!u) return false;
    u.holdFire = !u.holdFire; return u.holdFire;
  }
  segCenter(s: number): [number, number] { const g = CASTLE[s]; return [(g.x0 + g.x1) / 2, (g.z0 + g.z1) / 2]; }
  hasSiegeUnit(): boolean { return this.units.some(u => u.faction === Faction.Attacker && u.type === UType.Siege); }
  unitRange(unitId: number): number { return RANGE[this.units[unitId].type]; }
  isRanged(unitId: number): boolean { const t = this.units[unitId]?.type; return t === UType.Archer || t === UType.Siege; }

  begin() {
    if (this.phase !== 'deploy') return;
    this.phase = 'battle';
    // The army holds its deployed line. The player commits each arm to the
    // assault when ready — a deliberate, per-arm choice, not all-or-nothing.
    // Trebuchets batter the walls on their own from the moment battle is joined.
  }
  // Sound the general assault — commit every arm at once (a convenience button).
  assaultAll() { for (const d of this.playerDivs()) this.assaultDiv(d); }
  // Commit one arm to storm the keep. Infantry & cavalry advance on the keep;
  // archers move up to a firing line just short of the gate; engines never charge.
  assaultDiv(div: number) {
    const keep = cellOf(this.keepX, this.keepZ); this.field(keep);
    const fz = LAYOUT.front + 6; // archers' standoff, just short of the gate
    for (const u of this.divCompanies(div)) {
      if (u.type === UType.Siege || u.routing) continue;
      u.hold = false; u.assault = true;
      if (u.type === UType.Archer) {
        const ax = Math.max(WORLD.minX + 4, Math.min(WORLD.maxX - 4, u.ax));
        u.ax = ax; u.az = fz; let c = cellOf(ax, fz); if (BLOCKED[c]) c = cellOf(ax, fz + 6); u.goal = c;
      } else { u.goal = keep; u.ax = this.keepX; u.az = this.keepZ; }
    }
  }
  // Toggle an arm's assault. Pulling out halts it where it stands.
  toggleAssaultDiv(div: number): boolean {
    const cs = this.divCompanies(div); if (!cs.length) return false;
    if (cs.some(u => u.assault)) { this.holdDiv(div); return false; }
    this.assaultDiv(div); return true;
  }
  assaultingDiv(div: number): boolean { return this.divCompanies(div).some(u => u.assault); }
  // Halt an arm on its current ground (cancels an assault/advance order).
  holdDiv(div: number) {
    for (const u of this.divCompanies(div)) { u.assault = false; this.setAnchor(u, u.cx, u.cz, u.facing, Math.max(3, Math.round(Math.sqrt(u.count) * 1.4))); }
  }

  // ---- spatial hash for neighbour queries ----
  private hCell = 6;
  private hCols = Math.ceil((WORLD.maxX - WORLD.minX) / 6);
  private hRows = Math.ceil((WORLD.maxZ - WORLD.minZ) / 6);
  private buckets: number[][] = [];
  private rebuildHash() {
    const total = this.hCols * this.hRows;
    if (this.buckets.length !== total) { this.buckets = []; for (let i = 0; i < total; i++) this.buckets.push([]); }
    else for (let i = 0; i < total; i++) this.buckets[i].length = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const c = Math.min(this.hCols - 1, Math.max(0, Math.floor((this.px[i] - WORLD.minX) / this.hCell)));
      const r = Math.min(this.hRows - 1, Math.max(0, Math.floor((this.pz[i] - WORLD.minZ) / this.hCell)));
      this.buckets[r * this.hCols + c].push(i);
    }
  }

  step(dt: number) {
    if (this.phase === 'over') return;
    const deploy = this.phase === 'deploy'; // positioning phase: move, but no combat
    this._frame++;
    this.rebuildHash();

    // morale / routing per unit + centroids + live ammo
    for (const u of this.units) {
      let ax = 0, az = 0, a = 0, am = 0;
      for (let i = u.s0; i < u.s0 + u.count; i++) if (this.alive[i]) { ax += this.px[i]; az += this.pz[i]; a++; am += this.ammo[i]; }
      u.alive = a; u.ammo = am;
      if (a > 0) { u.cx = ax / a; u.cz = az / a; }
      if (!deploy && !u.routing && a > 0 && a / u.count < ROUT_FRAC) u.routing = true;
    }
    if (!deploy) {
      // The castle falls only when you actually win it: either raise your banner
      // over the keep (hold its ground while the garrison there is cleared) or
      // grind the garrison down to a shattered remnant. Count who holds the keep.
      let defAlive = 0, attInside = 0, attKeep = 0, defKeep = 0;
      const kr2 = this.captureR * this.captureR;
      for (let i = 0; i < this.n; i++) {
        if (!this.alive[i]) continue;
        const nearKeep = (this.px[i] - this.keepX) ** 2 + (this.pz[i] - this.keepZ) ** 2 < kr2 && this.py[i] < 7;
        if (this.fac[i] === Faction.Defender) {
          defAlive++;
          if (nearKeep) defKeep++;
        } else if (this.typ[i] !== UType.Siege) {
          if (this.climbState[i] === 0 && this.py[i] < 2 && Math.abs(this.px[i]) < LAYOUT.W - 1 && Math.abs(this.pz[i]) < LAYOUT.D - 1) attInside++;
          if (nearKeep) attKeep++;
        }
      }
      const defFrac = defAlive / Math.max(1, this.defenderAliveStart);
      this.attInsideCount = attInside; // wall defenders abandon the walls once this is high
      // capture meter: fills while you hold the keep ground with its guard cleared,
      // drains while the defenders still contest it.
      // A town falls once your men dominate its centre (more lenient and quicker
      // than holding a castle keep); a castle keep must be cleared of its guard.
      const pal = LAYOUT.palisade;
      if (attKeep >= (pal ? 5 : 6) && defKeep <= attKeep * (pal ? 1.0 : 0.4)) this.captureProgress = Math.min(1, this.captureProgress + dt / (pal ? CAPTURE_TIME * 0.7 : CAPTURE_TIME));
      else if (defKeep > attKeep * (pal ? 1.4 : 1)) this.captureProgress = Math.max(0, this.captureProgress - dt * 0.6);
      // only the last shattered survivors break and run
      if (defFrac < 0.12) for (const u of this.units) if (u.faction === Faction.Defender) u.routing = true;
    }

    // ---- ladders: raise animation + per-ladder lowest occupant (single file) ----
    if (!deploy && this.ladders.length) {
      if (this.ladderMinPy.length !== this.ladders.length) this.ladderMinPy = new Array(this.ladders.length).fill(Infinity);
      else this.ladderMinPy.fill(Infinity);
      for (let l = 0; l < this.ladders.length; l++) { const L = this.ladders[l]; if (L.raise < 1) L.raise = Math.min(1, L.raise + dt / 0.6); }
      for (let i = 0; i < this.n; i++) {
        if (!this.alive[i] || this.climbState[i] !== 1) continue;
        const l = this.climbLadder[i];
        if (l >= 0 && this.py[i] < this.ladderMinPy[l]) this.ladderMinPy[l] = this.py[i];
      }
    }

    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const u = this.units[this.unit[i]];
      const t = this.typ[i] as UType;
      const spd = SPEED[t];
      let dx = 0, dz = 0;       // desired direction
      this.cd[i] -= dt;

      const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((this.px[i] - WORLD.minX) / this.hCell)));
      const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((this.pz[i] - WORLD.minZ) / this.hCell)));

      // ---- nearest reachable enemy (skipped during deploy & for siege) ----
      let nearest = -1, nd2 = SENSE[t] * SENSE[t];
      if (!deploy && t !== UType.Siege) {
        const isMelee = t === UType.Heavy || t === UType.Light || t === UType.Cavalry;
        const my = this.py[i];
        // Re-scan only every few frames (staggered by index); the rest of the time
        // reuse the cached target if it's still alive and in reach. Combined with a
        // capped search radius/bucket, this keeps the gate pile from melting fps.
        const cached = this._near[i];
        let scanned = false;
        if (cached >= 0 && this.alive[cached] && this.fac[cached] !== this.fac[i] && (i + this._frame) % 4 !== 0) {
          const ex = this.px[cached] - this.px[i], ez = this.pz[cached] - this.pz[i], d2 = ex * ex + ez * ez;
          if (d2 < nd2 && !(isMelee && Math.abs(this.py[cached] - my) > 2.5)) { nearest = cached; nd2 = d2; scanned = true; }
        }
        if (!scanned) {
          const sr = Math.min(SRAD[t], 4); let done = false;
          for (let rr = hr - sr; rr <= hr + sr && !done; rr++) for (let cc = hc - sr; cc <= hc + sr && !done; cc++) {
            if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
            const b = this.buckets[rr * this.hCols + cc]; const bn = b.length < 18 ? b.length : 18;
            for (let bi = 0; bi < bn; bi++) {
              const j = b[bi];
              if (this.fac[j] === this.fac[i]) continue;
              if (isMelee && Math.abs(this.py[j] - my) > 2.5) continue; // can't reach wall-top troops
              const ex = this.px[j] - this.px[i], ez = this.pz[j] - this.pz[i], d2 = ex * ex + ez * ez;
              if (d2 < nd2) { nd2 = d2; nearest = j; if (d2 < 6.0) { done = true; break; } } // adjacent → good enough
            }
          }
          this._near[i] = nearest;
        }
      }

      // soldiers on a ladder / wall-top are handled by climbStep (unless routing,
      // in which case they bail off the wall and flee)
      if (!deploy && this.climbState[i] > 0 && !u.routing) { this.climbStep(i, u, t, dt, nearest); continue; }

      // Defenders abandon the wall-tops and come DOWN to fight once the attackers
      // hold the courtyard (or they're out of arrows) — they can't keep shooting
      // from above a fight they can't join.
      if (!deploy && !u.routing && u.faction === Faction.Defender && this.py[i] > 2 && this.climbState[i] === 0
          && (this.attInsideCount > 40 || (t === UType.Archer && this.ammo[i] <= 0))) {
        this.py[i] = Math.max(0, this.py[i] - 7 * dt);
        // Always come down on the INSIDE — toward the citadel centre if standing
        // on the citadel, else the keep/courtyard centre. Never chase an enemy
        // that's outside the wall (that bug let archers walk down the outer face).
        const cit = LAYOUT.citadel;
        let tx = 0, tz = 0;
        if (cit && this.px[i] > cit.x0 - 4 && this.px[i] < cit.x1 + 4 && this.pz[i] > cit.z0 - 4 && this.pz[i] < cit.z1 + 4) { tx = cit.cx; tz = cit.cz; }
        const dxg = tx - this.px[i], dzg = tz - this.pz[i], il = Math.hypot(dxg, dzg) || 1;
        this.px[i] += dxg / il * 3.5 * dt; this.pz[i] += dzg / il * 3.5 * dt;
        continue;
      }

      if (deploy) {
        // positioning phase: march to formation, no combat
        if (u.faction === Faction.Attacker && !u.hold) { this.formMove(u, i); dx = this._dir[0]; dz = this._dir[1]; }
      } else if (u.routing) {
        if (this.climbState[i] > 0) this.climbState[i] = 0;
        if (this.py[i] > 0) this.py[i] = Math.max(0, this.py[i] - 14 * dt); // scramble down the wall
        const fz = u.faction === Faction.Attacker ? 1 : -1;
        dx = (this.px[i] > 0 ? 0.4 : -0.4); dz = fz;
        if (this.px[i] < WORLD.minX + 3 || this.px[i] > WORLD.maxX - 3 ||
            this.pz[i] < WORLD.minZ + 3 || this.pz[i] > WORLD.maxZ - 3) { this.kill(i, u); continue; }
      } else if (t === UType.Siege) {
        let seg = u.siegeTargetSeg;
        if (seg >= 0 && CASTLE[seg].dead) {
          // the wall you ordered them to break is rubble — stand the battery down
          // rather than auto-roaming to another target (that was the annoying bit).
          // The player picks the next target; tapping a wall resumes fire.
          u.siegeTargetSeg = -1; u.holdFire = true; seg = -1;
        } else if (seg >= 0) {
          // ordered target still standing — hold fire until it's in range
          if (((CASTLE[seg].x0 + CASTLE[seg].x1) / 2 - this.px[i]) ** 2 + ((CASTLE[seg].z0 + CASTLE[seg].z1) / 2 - this.pz[i]) ** 2 > RANGE[t] * RANGE[t]) seg = -1;
        } else if (!u.holdFire) {
          // no specific orders and not stood down → batter the nearest wall on their own
          seg = this.nearestWall(this.px[i], this.pz[i], RANGE[t]);
        }
        if (seg >= 0 && this.cd[i] <= 0 && this.ammo[i] > 0 && !u.holdFire) { this.lobBoulder(i, seg); this.cd[i] = ATKCD[t] * this.atk.reload; this.ammo[i]--; }
        if (!u.hold) { this.formMove(u, i); dx = this._dir[0]; dz = this._dir[1]; }
      } else {
        const dist = nearest >= 0 ? Math.sqrt(nd2) : Infinity;
        if (t === UType.Archer && this.ammo[i] > 0) {
          // Archers always dress toward their firing-line slot, so the company
          // keeps its ranks (this steering is what counters the separation push
          // that otherwise melts a halted firing line into a scattered blob).
          // They loose only once roughly in position, so the line forms up at the
          // wall first instead of every man freezing where he first sees a target.
          if (!u.hold) { this.formMove(u, i); dx = this._dir[0]; dz = this._dir[1]; if (this._stuck) { this.useLadder(i); dx = this._dir[0]; dz = this._dir[1]; } }
          const settled = dx * dx + dz * dz < 0.5; // within ~1.7m of its slot
          if (settled && this.cd[i] <= 0 && nearest >= 0 && dist <= RANGE[t] && !u.holdFire && this.focusOk(u, nearest)) {
            this.shoot(i, nearest); this.cd[i] = ATKCD[t]; this.ammo[i]--;
          }
        } else {
          // melee — including archers who've spent all their arrows
          // Defender reserves rush to MOUNT a wall the enemy is scaling.
          if (u.hold && u.faction === Faction.Defender && t === UType.Light && nearest >= 0 && this.py[nearest] > 2 && dist < 16) {
            const seg = this.nearestClimbWall(this.px[i], this.pz[i]); if (seg >= 0) { this.startClimb(i, seg); continue; }
          }
          const mrng = t === UType.Archer ? RANGE[UType.Light] : RANGE[t];
          const mdmg = (t === UType.Archer ? MELEE[UType.Light] : MELEE[t]) * (u.faction === Faction.Attacker ? this.atk.melee : 1);
          if (nearest >= 0 && dist <= mrng) {
            if (this.cd[i] <= 0) { this.hp[nearest] -= mdmg; this.cd[i] = ATKCD[t]; if (this.hp[nearest] <= 0) this.kill(nearest, this.units[this.unit[nearest]]); }
          } else if (nearest >= 0 && dist < ENGAGE && !u.hold && !pathBlocked(this.px[i], this.pz[i], this.px[nearest], this.pz[nearest])
                     && (u.faction !== Faction.Attacker || (u.cx - u.ax) ** 2 + (u.cz - u.az) ** 2 < CHASE_LEASH * CHASE_LEASH)) {
            // chase a *reachable* enemy — but only once the company has reached its
            // ordered ground, so a marching arm isn't dragged off course en route
            const ex = this.px[nearest] - this.px[i], ez = this.pz[nearest] - this.pz[i]; const l = dist || 1; dx = ex / l; dz = ez / l;
          } else if (!u.hold) {
            this.formMove(u, i); dx = this._dir[0]; dz = this._dir[1];
            if (this._stuck && t !== UType.Cavalry) {
              // The flow field can't thread us to the goal. Make for the nearest
              // breach (broken-down walls are the way in); only scale a standing
              // wall as a last resort when nothing has been broken open yet.
              const br = this.nearestBreach(this.px[i], this.pz[i]);
              if (br >= 0) { const g = CASTLE[br], bx = (g.x0 + g.x1) / 2 - this.px[i], bz = (g.z0 + g.z1) / 2 - this.pz[i], bl = Math.hypot(bx, bz) || 1; dx = bx / bl; dz = bz / bl; }
              else { this.useLadder(i); dx = this._dir[0]; dz = this._dir[1]; }
            }
          } else if (u.hold && u.faction === Faction.Defender && this.py[i] < 3) {
            // Ground companies manoeuvre as a body. In a castle, a battered company
            // makes a fighting retreat to the keep while a fresh one sorties to meet
            // attackers within ~38m. A town militia has no keep to fall back on, so
            // it sorties far and wide to meet the raiders — and is cut down in the
            // open, the way a raid should end.
            const town = LAYOUT.palisade;
            if (!town && u.alive < u.count * 0.45 && !u.routing) {
              const ex = this.keepX - this.px[i], ez = this.keepZ - this.pz[i]; const l = Math.hypot(ex, ez) || 1;
              if (l > 7) { dx = ex / l; dz = ez / l; }
            } else if (nearest >= 0 && dist < (town ? 75 : 38) && !pathBlocked(this.px[i], this.pz[i], this.px[nearest], this.pz[nearest])) {
              const ex = this.px[nearest] - this.px[i], ez = this.pz[nearest] - this.pz[i]; const l = dist || 1; dx = ex / l; dz = ez / l;
            }
          }
        }
      }

      // ---- separation from same-faction neighbours ----
      let sx = 0, sz = 0;
      for (let rr = hr - 1; rr <= hr + 1; rr++) for (let cc = hc - 1; cc <= hc + 1; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const b = this.buckets[rr * this.hCols + cc];
        // cap neighbours sampled per bucket — separation is a soft force, so a
        // sample suffices and it keeps the gate pile from melting the frame-rate
        const cap = b.length < 22 ? b.length : 22;
        for (let bi = 0; bi < cap; bi++) {
          const j = b[bi]; if (j === i || this.fac[j] !== this.fac[i] || this.climbState[j] > 0) continue;
          const ex = this.px[i] - this.px[j], ez = this.pz[i] - this.pz[j];
          // separation radius kept BELOW formation spacing so soldiers settled
          // in their ranks don't shove each other (that caused the vibrating).
          const d2 = ex * ex + ez * ez; const rad = RADIUS[t] * 1.7;
          if (d2 > 0.0001 && d2 < rad * rad) { const d = Math.sqrt(d2); sx += ex / d * (1 - d / rad); sz += ez / d * (1 - d / rad); }
        }
      }

      // Obstacle avoidance — push off nearby blocked cells (keep, buildings, and
      // future deployable obstacles) so soldiers slide around them, not into them.
      let ox = 0, oz = 0;
      if (this.py[i] < 1) {
        const OR = 2.6;
        for (let a = 0; a < 8; a++) {
          const c = OBST_DIR[a], cx2 = c[0], cz2 = c[1]; const spx = this.px[i] + cx2 * OR, spz = this.pz[i] + cz2 * OR;
          if (spx < WORLD.minX || spx > WORLD.maxX || spz < WORLD.minZ || spz > WORLD.maxZ || BLOCKED[cellOf(spx, spz)]) { ox -= cx2; oz -= cz2; }
        }
      }

      // Desired velocity = steering*speed + separation + obstacle push, then
      // SMOOTHED toward current velocity so tiny opposing forces don't jitter.
      let desVx = dx * spd + sx * spd * 0.85 + ox * spd * 0.7;
      let desVz = dz * spd + sz * spd * 0.85 + oz * spd * 0.7;
      const dlen = Math.hypot(desVx, desVz), maxv = spd * 1.15;
      if (dlen > maxv) { desVx *= maxv / dlen; desVz *= maxv / dlen; }
      this.vx[i] += (desVx - this.vx[i]) * 0.3;
      this.vz[i] += (desVz - this.vz[i]) * 0.3;
      if (Math.abs(this.vx[i]) < 0.04 && Math.abs(this.vz[i]) < 0.04) { this.vx[i] = 0; this.vz[i] = 0; }

      let nx = this.px[i] + this.vx[i] * dt, nz = this.pz[i] + this.vz[i] * dt;
      if (this.py[i] < 1 && blockedAt(nx, nz)) { // ground units collide with walls
        if (!blockedAt(nx, this.pz[i])) { nz = this.pz[i]; this.vz[i] = 0; }
        else if (!blockedAt(this.px[i], nz)) { nx = this.px[i]; this.vx[i] = 0; }
        else { nx = this.px[i]; nz = this.pz[i]; this.vx[i] = 0; this.vz[i] = 0; }
      }
      this.px[i] = Math.max(WORLD.minX, Math.min(WORLD.maxX, nx));
      this.pz[i] = Math.max(WORLD.minZ, Math.min(WORLD.maxZ, nz));
    }

    if (!deploy) { this.stepBallistae(dt); this.stepProjectiles(dt); this.checkVictory(); }
  }

  // Archers only fire at enemies inside their ordered focus area (if one is set),
  // so the player can concentrate volleys — and not waste arrows on everything.
  private focusOk(u: Unit, j: number): boolean {
    if (!u.hasFocus) return true;
    const dx = this.px[j] - u.focusX, dz = this.pz[j] - u.focusZ;
    return dx * dx + dz * dz < 18 * 18;
  }
  setFocus(unitId: number, x: number, z: number) {
    const u = this.units[unitId];
    if (u && u.type === UType.Archer) { u.focusX = x; u.focusZ = z; u.hasFocus = true; }
  }
  clearFocus(unitId: number) { const u = this.units[unitId]; if (u) u.hasFocus = false; }

  private kill(i: number, u: Unit) { this.alive[i] = 0; if (u) u.alive = Math.max(0, u.alive - 1); }

  // Desired direction toward this soldier's formation slot, written to _dir.
  // Routes via the flow field only when a wall actually blocks the straight
  // path to the slot — otherwise steers directly (so ranks spread, no clumping).
  private _dir = [0, 0];
  private _stuck = false; // set when the flow field can't reach the goal (enclosed)
  private formMove(u: Unit, i: number) {
    const t = this.typ[i] as UType;
    const sp = SPACING[t], cols = Math.max(1, u.cols), rows = Math.ceil(u.count / cols);
    const k = i - u.s0, col = k % cols, row = (k - col) / cols;
    const ffx = Math.sin(u.facing), ffz = Math.cos(u.facing);
    const rrx = Math.cos(u.facing), rrz = -Math.sin(u.facing);
    const lr = (col - (cols - 1) / 2) * sp, lf = ((rows - 1) / 2 - row) * sp;
    const slx = u.ax + rrx * lr + ffx * lf, slz = u.az + rrz * lr + ffz * lf;
    const tx = slx - this.px[i], tz = slz - this.pz[i], l = Math.hypot(tx, tz);
    this._stuck = false;
    // Route via the flow field whenever an obstacle is between the soldier and
    // its slot (at ANY distance) — so they flow around the keep / buildings /
    // future deployable obstacles instead of piling against the near face.
    if (l > 1.5 && u.goal >= 0 && pathBlocked(this.px[i], this.pz[i], slx, slz)) {
      const f = this.field(u.goal), ci = cellOf(this.px[i], this.pz[i]);
      this._dir[0] = f[ci * 2]; this._dir[1] = f[ci * 2 + 1];
      this._stuck = f[ci * 2] === 0 && f[ci * 2 + 1] === 0; // no path: goal is walled off
    } else if (l > 0.35) {
      const mag = l < 2.5 ? l / 2.5 : 1; // ease into the slot (no overshoot/jitter)
      this._dir[0] = (tx / l) * mag; this._dir[1] = (tz / l) * mag;
    } else { this._dir[0] = 0; this._dir[1] = 0; }
  }

  // ---- wall scaling (ladders) ----
  private CLIMB = 4.5; // distance from a wall section's box at which a soldier mounts the ladder
  // Nearest breach (a fallen wall/gate section, now an open gap) — the entry point
  // attackers should make for when the flow field can't thread them to their goal.
  private nearestBreach(x: number, z: number): number {
    let best = -1, bd = 1e9;
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s]; if (!g.dead || (g.kind !== 'wall' && g.kind !== 'gate')) continue;
      const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2, d2 = (cx - x) ** 2 + (cz - z) ** 2;
      if (d2 < bd) { bd = d2; best = s; }
    }
    return best;
  }
  private nearestClimbWall(x: number, z: number): number {
    let best = -1, bd = 1e9;
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s]; if (g.dead || (g.kind !== 'wall' && g.kind !== 'gate')) continue;
      const cx = Math.max(g.x0, Math.min(g.x1, x)), cz = Math.max(g.z0, Math.min(g.z1, z));
      const d2 = (cx - x) ** 2 + (cz - z) ** 2;
      if (d2 < bd) { bd = d2; best = s; }
    }
    return best;
  }
  // Defender wall reinforcement uses interior stairs (direct climb, no ladder).
  private startClimb(i: number, seg: number) { this.climbState[i] = 1; this.climbSeg[i] = seg; this.climbLadder[i] = -1; }
  private moveXZ(i: number, tx: number, tz: number, step: number): number {
    const dx = tx - this.px[i], dz = tz - this.pz[i], l = Math.hypot(dx, dz);
    if (l > 0.05) { const s = Math.min(l, step); this.px[i] += dx / l * s; this.pz[i] += dz / l * s; }
    return l;
  }
  // Nearest standing tower + the point just inside it (where its stairs let you
  // down into the courtyard).
  private nearestTowerPos(x: number, z: number): { x: number; z: number; r: number; ix: number; iz: number } | null {
    let bx = 0, bz = 0, br = 0, bd = 1e9, found = false;
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s]; if (g.dead || g.kind !== 'tower') continue;
      const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2, d2 = (cx - x) ** 2 + (cz - z) ** 2;
      if (d2 < bd) { bd = d2; bx = cx; bz = cz; br = (g.x1 - g.x0) / 2; found = true; }
    }
    if (!found) return null;
    const il = Math.hypot(bx, bz) || 1; // inner point: from the tower toward the keep/centre
    return { x: bx, z: bz, r: br, ix: bx - bx / il * (br + 3), iz: bz - bz / il * (br + 3) };
  }

  // Attacker: pick (or raise) a ladder on the nearest wall and queue at its foot;
  // mount single-file once it's up and the rungs below are clear.
  private LADDER_CAP = 48;
  private findOrMakeLadder(seg: number, i: number): number {
    const g = CASTLE[seg], horiz = (g.x1 - g.x0) >= (g.z1 - g.z0);
    const myAlong = horiz ? this.px[i] : this.pz[i];
    let best = -1, bd = 1e9, onSeg = 0;
    for (let l = 0; l < this.ladders.length; l++) {
      const L = this.ladders[l]; if (L.seg !== seg) continue;
      onSeg++; const d = Math.abs(L.along - myAlong); if (d < bd) { bd = d; best = l; }
    }
    if (best >= 0 && bd < 7) return best;                 // reuse a nearby ladder
    const segLen = horiz ? g.x1 - g.x0 : g.z1 - g.z0;
    const cap = Math.max(1, Math.floor(segLen / 6));
    if (onSeg >= cap || this.ladders.length >= this.LADDER_CAP) return best; // at cap → share the nearest
    const wallPerp = horiz ? (g.z0 + g.z1) / 2 : (g.x0 + g.x1) / 2;
    // foot on the side the attacker is approaching from (works for the citadel,
    // whose walls aren't centred on the world origin)
    const myPerp = horiz ? this.pz[i] : this.px[i];
    const outer = (Math.sign(myPerp - wallPerp) || 1);
    const aMin = (horiz ? g.x0 : g.z0) + 1.2, aMax = (horiz ? g.x1 : g.z1) - 1.2;
    const along = Math.max(aMin, Math.min(aMax, myAlong));
    const foot = wallPerp + outer * (T / 2 + 1.6);
    this.ladders.push({ seg, along, bx: horiz ? along : foot, bz: horiz ? foot : along, horiz, outer, raise: 0 });
    return this.ladders.length - 1;
  }
  // The non-dead wall/gate section containing a point (or -1).
  private wallSegAtPoint(x: number, z: number): number {
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s];
      if (g.dead || (g.kind !== 'wall' && g.kind !== 'gate')) continue;
      if (x >= g.x0 - 0.5 && x <= g.x1 + 0.5 && z >= g.z0 - 0.5 && z <= g.z1 + 0.5) return s;
    }
    return -1;
  }
  // March from the soldier toward its goal and return the FIRST wall the path
  // crosses — that's the wall actually standing in the way (e.g. the citadel).
  private wallTowardGoal(i: number): number {
    const u = this.units[this.unit[i]];
    const x = this.px[i], z = this.pz[i];
    const ddx = u.ax - x, ddz = u.az - z, gl = Math.hypot(ddx, ddz) || 1, sx = ddx / gl, sz = ddz / gl;
    for (let d = 1.5; d < Math.min(gl + 6, 80); d += 1.5) {
      const qx = x + sx * d, qz = z + sz * d;
      if (qx < WORLD.minX || qx > WORLD.maxX || qz < WORLD.minZ || qz > WORLD.maxZ) break;
      if (blockedAt(qx, qz)) { const s = this.wallSegAtPoint(qx, qz); return s >= 0 ? s : this.nearestClimbWall(qx, qz); }
    }
    return this.nearestClimbWall(x, z);
  }
  private useLadder(i: number) {
    const seg = this.wallTowardGoal(i);
    if (seg < 0) { this._dir[0] = 0; this._dir[1] = 0; return; }
    const L = this.findOrMakeLadder(seg, i);
    if (L < 0) { // couldn't get a ladder: just press toward the wall and retry
      const g = CASTLE[seg], cpx = Math.max(g.x0, Math.min(g.x1, this.px[i])), cpz = Math.max(g.z0, Math.min(g.z1, this.pz[i]));
      const dx = cpx - this.px[i], dz = cpz - this.pz[i], l = Math.hypot(dx, dz) || 1; this._dir[0] = dx / l; this._dir[1] = dz / l; return;
    }
    const lad = this.ladders[L];
    const dx = lad.bx - this.px[i], dz = lad.bz - this.pz[i], l = Math.hypot(dx, dz);
    if (l <= 1.7) {
      this._dir[0] = 0; this._dir[1] = 0;     // at the foot — wait our turn, then mount
      const clear = this.ladderMinPy[L] === undefined || this.ladderMinPy[L] > 3.0;
      if (lad.raise >= 0.55 && clear) {
        this.climbState[i] = 1; this.climbSeg[i] = seg; this.climbLadder[i] = L;
        if (lad.horiz) this.px[i] = lad.along; else this.pz[i] = lad.along; // snap to the rung line
      }
    } else { this._dir[0] = dx / l; this._dir[1] = dz / l; }
  }

  // Fully controls a climbing soldier for the tick (sets px/pz/py): up a ladder
  // single-file, across the wall-walk to a tower, and down its stairs inside.
  private climbStep(i: number, u: Unit, t: UType, dt: number, nearest: number) {
    // wall-top / ladder melee against an adjacent same-level enemy
    if (nearest >= 0 && Math.abs(this.py[nearest] - this.py[i]) < 2.5) {
      const dd = Math.hypot(this.px[nearest] - this.px[i], this.pz[nearest] - this.pz[i]);
      if (dd < 2.2 && this.cd[i] <= 0) { const dmg = (MELEE[t] || 7) * 1.4 * (u.faction === Faction.Attacker ? this.atk.melee : 1); this.hp[nearest] -= dmg; this.cd[i] = ATKCD[t]; if (this.hp[nearest] <= 0) this.kill(nearest, this.units[this.unit[nearest]]); }
    }
    const st = this.climbState[i];
    if (st === 1) {                       // ascending
      const seg = CASTLE[this.climbSeg[i]];
      if (!seg || seg.dead) { this.climbState[i] = 0; this.py[i] = 0; this.climbLadder[i] = -1; return; } // wall fell → breach
      const horiz = (seg.x1 - seg.x0) >= (seg.z1 - seg.z0);
      const wallPerp = horiz ? (seg.z0 + seg.z1) / 2 : (seg.x0 + seg.x1) / 2;
      const lad = this.climbLadder[i] >= 0 ? this.ladders[this.climbLadder[i]] : null;
      if (lad) {                          // attacker, single-file up the ladder line
        this.moveXZ(i, horiz ? lad.along : wallPerp, horiz ? wallPerp : lad.along, 2.4 * dt);
        this.py[i] = Math.min(WH, this.py[i] + 3.2 * dt);
        if (this.py[i] >= WH - 0.1) { this.climbState[i] = 2; this.climbLadder[i] = -1; }
      } else {                            // defender, direct interior climb
        const aMin = (horiz ? seg.x0 : seg.z0) + 0.5, aMax = (horiz ? seg.x1 : seg.z1) - 0.5;
        const along = Math.max(aMin, Math.min(aMax, horiz ? this.px[i] : this.pz[i]));
        const l = this.moveXZ(i, horiz ? along : wallPerp, horiz ? wallPerp : along, 3.0 * dt);
        this.py[i] = Math.min(WH, this.py[i] + 4 * dt);
        if (l < 1.0 && this.py[i] >= WH - 0.1) this.climbState[i] = u.faction === Faction.Attacker ? 2 : 4;
      }
    } else if (st === 2) {                // attacker on the battlements: head to a tower to get down
      this.py[i] = WH;
      const tw = this.nearestTowerPos(this.px[i], this.pz[i]);
      if (!tw) { this.climbState[i] = 3; return; } // no tower left → drop where we are
      const l = this.moveXZ(i, tw.x, tw.z, 4.0 * dt);
      if (l < tw.r + 1.0) this.climbState[i] = 3;
    } else if (st === 3) {                // descend the tower stairs toward the interior we're assaulting
      this.moveXZ(i, u.ax, u.az, 3.2 * dt);
      this.py[i] = Math.max(0, this.py[i] - 4 * dt);
      if (this.py[i] <= 0.05) { this.climbState[i] = 0; this.py[i] = 0; }
    } else {                              // st 4: defender holds the wall-top
      const seg = CASTLE[this.climbSeg[i]];
      if (!seg || seg.dead) { this.climbState[i] = 0; this.py[i] = 0; return; }
      const horiz = (seg.x1 - seg.x0) >= (seg.z1 - seg.z0);
      const wallPerp = horiz ? (seg.z0 + seg.z1) / 2 : (seg.x0 + seg.x1) / 2;
      const aMin = (horiz ? seg.x0 : seg.z0) + 0.5, aMax = (horiz ? seg.x1 : seg.z1) - 0.5;
      const along = Math.max(aMin, Math.min(aMax, horiz ? this.px[i] : this.pz[i]));
      this.moveXZ(i, horiz ? along : wallPerp, horiz ? wallPerp : along, 1.5 * dt);
    }
  }

  private shoot(i: number, target: number) {
    const p = this.getProj();
    const atkShot = this.fac[i] === Faction.Attacker;
    const fire = this.units[this.unit[i]].fireArrows || (atkShot && this.atk.fire);
    const sx = this.px[i], sz = this.pz[i], sy = this.py[i] + 1.6;
    const tx0 = this.px[target], tz0 = this.pz[target], ty = this.py[target] + 1.0; // aim at the body, at its height
    const d = Math.hypot(tx0 - sx, tz0 - sz) || 1;
    // Spread + scatter: nudge each arrow off the exact mark (a little up close,
    // more at long range) so a volley fans across the enemies instead of every
    // shaft piling onto one man — and some fall short or wide and simply miss.
    const sc = 0.6 + d * 0.05;
    const tx = tx0 + (this.rnd() - 0.5) * 2 * sc, tz = tz0 + (this.rnd() - 0.5) * 2 * sc;
    // Lob exactly as high as needed: sample the tallest obstacle between archer
    // and target and compare it to where a flat-ish shot would be there; only
    // raise the arc if a structure actually blocks it (so close shots stay flat).
    let tof = Math.max(0.7, d / ARCHER_PROJ_SPEED);
    let need = 0;
    const steps = Math.max(2, Math.ceil(d / 3));
    for (let k = 2; k < steps; k++) { // skip the archer's own footprint
      const f = k / steps, qx = sx + (tx - sx) * f, qz = sz + (tz - sz) * f;
      const h = heightAt(qx, qz);
      if (h > 0) { const lineY = sy + (ty - sy) * f; const deficit = h - lineY; if (deficit > need) need = deficit; }
    }
    if (need > 0.5) tof = Math.max(tof, Math.sqrt(8 * (need + 2) / PROJ_G)); // apex (≈ g·tof²/8) clears the obstacle
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.ty = ty; p.fac = this.fac[i] as Faction;
    p.dmg = (fire ? ARCHER_PROJ_DMG * 1.7 : ARCHER_PROJ_DMG) * (atkShot ? this.atk.archer : 1); p.wall = -1; p.big = false; p.fire = fire; p.splash = 0; p.bolt = false;
    p.vx = (tx - sx) / tof; p.vz = (tz - sz) / tof; p.vy = (ty - sy) / tof + 0.5 * PROJ_G * tof; // ballistic arc to target height
  }

  // Nearest still-standing wall/gate section within a trebuchet's range.
  private nearestWall(x: number, z: number, range: number): number {
    let best = -1, bd = range * range;
    for (let s = 0; s < CASTLE.length; s++) {
      const seg = CASTLE[s];
      if (seg.dead || (seg.kind !== 'wall' && seg.kind !== 'gate')) continue;
      const cx = (seg.x0 + seg.x1) / 2, cz = (seg.z0 + seg.z1) / 2;
      const d2 = (cx - x) ** 2 + (cz - z) ** 2;
      if (d2 < bd) { bd = d2; best = s; }
    }
    return best;
  }

  private lobBoulder(i: number, segIdx: number) {
    const seg = CASTLE[segIdx];
    const p = this.getProj();
    const sx = this.px[i], sz = this.pz[i], sy = 3;
    // aim at the section centre with a little scatter (siege isn't pinpoint)
    const tx = (seg.x0 + seg.x1) / 2 + (this.rnd() - 0.5) * 5, tz = (seg.z0 + seg.z1) / 2 + (this.rnd() - 0.5) * 4;
    const d = Math.hypot(tx - sx, tz - sz) || 1;
    const tof = d / BOULDER_SPEED;
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.fac = this.fac[i] as Faction;
    p.dmg = BOULDER_DMG * this.atk.siege; p.wall = segIdx; p.big = true; p.fire = false; p.splash = ARTY_SPLASH; p.bolt = false;
    p.vx = (tx - sx) / tof; p.vz = (tz - sz) / tof; p.vy = (0 - sy) / tof + 0.5 * PROJ_G * tof;
  }

  private breach(segIdx: number) {
    const seg = CASTLE[segIdx];
    if (seg.dead) return;
    seg.dead = true;
    rebuildBlocked();
    this.fields.clear(); // passability changed — recompute flow fields on demand
    // archers standing on this section fall with it
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i] || this.py[i] < 1) continue;
      if (this.px[i] >= seg.x0 - 1.5 && this.px[i] <= seg.x1 + 1.5 && this.pz[i] >= seg.z0 - 1.5 && this.pz[i] <= seg.z1 + 1.5)
        this.kill(i, this.units[this.unit[i]]);
    }
  }

  private getProj(): Projectile {
    for (const p of this.projectiles) if (!p.active) return p;
    const p: Projectile = { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, tz: 0, ty: 0, dmg: 0, fac: 0, wall: -1, big: false, fire: false, splash: 0, bolt: false };
    this.projectiles.push(p); return p;
  }
  // Anti-personnel blast: the man at the point of impact is killed outright; a
  // very small radius around him takes a fraction (so it's a precise strike, not
  // a fireball). Trebuchets won't friendly-fire (skips its own faction).
  private artySplash(x: number, z: number, fac: Faction, dmg: number, radius: number) {
    const r2 = radius * radius;
    const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((x - WORLD.minX) / this.hCell)));
    const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((z - WORLD.minZ) / this.hCell)));
    const span = Math.ceil(radius / this.hCell) + 1;
    for (let rr = hr - span; rr <= hr + span; rr++) for (let cc = hc - span; cc <= hc + span; cc++) {
      if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
      for (const j of this.buckets[rr * this.hCols + cc]) {
        if (this.fac[j] === fac || this.typ[j] === UType.Siege || !this.alive[j]) continue;
        const d2 = (this.px[j] - x) ** 2 + (this.pz[j] - z) ** 2; if (d2 > r2) continue;
        this.hp[j] -= d2 < 2.0 ? dmg : dmg * 0.2;        // direct hit lethal, very little spill
        if (this.hp[j] <= 0) this.kill(j, this.units[this.unit[j]]);
      }
    }
  }
  private fireBolt(e: Emplacement, target: number) {
    const p = this.getProj();
    const sx = e.x, sz = e.z, sy = e.y + 1.2;
    const d0 = Math.hypot(this.px[target] - sx, this.pz[target] - sz) || 1;
    // a tiny bit of scatter so a ballista doesn't snipe a man with every bolt
    const sc = 0.8 + d0 * 0.03;
    const tx = this.px[target] + (this.rnd() - 0.5) * 2 * sc, tz = this.pz[target] + (this.rnd() - 0.5) * 2 * sc, ty = 1;
    const d = Math.hypot(tx - sx, tz - sz) || 1, tof = d / BOLT_SPEED;
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.ty = ty; p.fac = Faction.Defender;
    p.dmg = BALLISTA_DMG; p.wall = -1; p.big = false; p.fire = false; p.bolt = true; p.splash = ARTY_SPLASH;
    p.vx = (tx - sx) / tof; p.vz = (tz - sz) / tof; p.vy = (ty - sy) / tof + 0.5 * PROJ_G * tof;
    e.aimX = tx; e.aimZ = tz;
  }
  private stepBallistae(dt: number) {
    for (const e of this.ballistae) {
      if (CASTLE[e.seg].dead) continue;          // wall breached -> engine destroyed
      if (e.recoil > 0) e.recoil = Math.max(0, e.recoil - dt);
      e.cd -= dt; if (e.cd > 0) continue;
      // nearest attacker on the ground within reach
      let best = -1, bd = BALLISTA_RANGE * BALLISTA_RANGE;
      for (let i = 0; i < this.n; i++) {
        if (!this.alive[i] || this.fac[i] !== Faction.Attacker || this.typ[i] === UType.Siege || this.py[i] > 4) continue;
        const dx = this.px[i] - e.x, dz = this.pz[i] - e.z, d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; best = i; }
      }
      if (best >= 0) { this.fireBolt(e, best); e.cd = BALLISTA_CD; e.recoil = 0.45; }
      else e.cd = 0.6; // nothing in range — look again shortly
    }
  }
  private stepProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.vy -= PROJ_G * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const dxz = Math.hypot(p.x - p.tx, p.z - p.tz);
      if (p.y <= 0 || dxz < 1.4) {
        if (p.wall >= 0) {
          // Boulder: damage whatever solid section it actually comes down on —
          // walls AND towers are real objects, so a shot scattered onto a tower
          // breaks the tower instead of passing through to the wall behind it. If
          // it lands in open ground, count it against the ordered wall.
          let hit = structureAt(p.x, p.z);
          if (hit < 0) hit = p.wall;
          const seg = CASTLE[hit];
          if (seg && !seg.dead) { seg.hp -= p.dmg; if (seg.hp <= 0) this.breach(hit); }
          if (p.splash > 0) this.artySplash(p.x, p.z, p.fac, p.dmg * 0.5, p.splash); // also scatters troops at the wall
        } else if (p.splash > 0) {
          // ballista bolt / anti-personnel shot: kill the man it strikes, little spill
          this.artySplash(p.x, p.z, p.fac, p.dmg, p.splash);
        } else {
          // arrow: damage nearest enemy to the (scattered) impact point — tighter
          // radius so wide shots genuinely miss instead of always snapping to a hit
          let best = -1, bd2 = 1.7;
          const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((p.tx - WORLD.minX) / this.hCell)));
          const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((p.tz - WORLD.minZ) / this.hCell)));
          for (let rr = hr - 1; rr <= hr + 1; rr++) for (let cc = hc - 1; cc <= hc + 1; cc++) {
            if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
            const b = this.buckets[rr * this.hCols + cc];
            for (const j of b) { if (this.fac[j] === p.fac) continue; const d2 = (this.px[j] - p.tx) ** 2 + (this.pz[j] - p.tz) ** 2; if (d2 < bd2) { bd2 = d2; best = j; } }
          }
          if (best >= 0) { this.hp[best] -= p.dmg; if (this.hp[best] <= 0) this.kill(best, this.units[this.unit[best]]); }
        }
        p.active = false;
      }
    }
  }

  private checkVictory() {
    // You win by raising your banner over the keep (capture meter full) or by
    // all-but-annihilating the garrison (down to ~10%). You lose when the assault
    // is spent — every remaining company has broken and routed.
    let attActive = 0, defAlive = 0;
    for (const u of this.units) {
      if (u.faction === Faction.Defender) defAlive += u.alive;
      else if (!u.routing && u.type !== UType.Siege) attActive += u.alive; // trebuchets alone can't carry it
    }
    const defFrac = defAlive / Math.max(1, this.defenderAliveStart);
    if (this.captureProgress >= 1 || defFrac <= 0.1) { this.phase = 'over'; this.winner = Faction.Attacker; }
    else if (attActive === 0) { this.phase = 'over'; this.winner = Faction.Defender; }
  }
  // Sound the retreat — end now; survivors are saved, the castle stands.
  retreat() { if (this.phase === 'battle') { this.phase = 'over'; this.winner = Faction.Defender; this.retreated = true; } }
  // Attacker soldiers by unit type — committed (spawned) vs still alive.
  attackerSpawned(): number[] { const a = [0, 0, 0, 0, 0]; for (const u of this.units) if (u.faction === Faction.Attacker) a[u.type] += u.count; return a; }
  attackerAlive(): number[] { const a = [0, 0, 0, 0, 0]; for (const u of this.units) if (u.faction === Faction.Attacker) a[u.type] += u.alive; return a; }

  // aggregate counts for HUD
  countAlive(faction: Faction): number { let n = 0; for (const u of this.units) if (u.faction === faction) n += u.alive; return n; }
  playerUnits(): Unit[] { return this.units.filter(u => u.faction === Faction.Attacker); }
}
