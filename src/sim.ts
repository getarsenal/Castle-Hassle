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
// A gate is forced by a single RAM, not by sheer numbers: once a crew (a handful
// of men) is on it, it takes a FIXED amount of damage per second regardless of how
// many troops pile on — so 250 men don't smash it in three seconds. Tuned so a
// gate falls in ~20s (palisade) to ~40s (stone), long enough that ramming under
// un-silenced wall-fire is costly. Stone WALLS can't be battered at all — engines
// or ladders only.
const RAM_DPS = 55;          // gate hit-points lost per second while a crew rams
const RAM_CREW = 4;          // men that must be on the gate for the ram to bite
// signature abilities
const CHARGE_DUR = 4.5;      // a cavalry charge lasts this long...
const CHARGE_CD = 12;        // ...then must recover before the next
const CHARGE_SPD = 1.45;     // speed while charging
const CHARGE_DMG = 2.8;      // melee impact multiplier on the charge
const OBST_DIR: [number, number][] = Array.from({ length: 8 }, (_, a) => [Math.cos(a * Math.PI / 4), Math.sin(a * Math.PI / 4)]);

export function maxHp(t: UType) { return HP[t]; }

// ---- Procedural castle. A destructible AABB segment list (so all collision &
// siege mechanics work unchanged) plus a structured LAYOUT used for rendering
// and defender deployment. Bigger than before, varied per seed, with a town of
// buildings inside and (on larger ones) an inner CITADEL that must be taken. ----
export type SegKind = 'wall' | 'gate' | 'tower' | 'keep' | 'building';
export interface Seg { x0: number; x1: number; z0: number; z1: number; h: number; kind: SegKind; hp: number; maxhp: number; dead: boolean; ramT?: number; ramCrew?: number; }
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
// Wall test with a grid broad-phase. BLOCKED (cell-centre sample) covers the solid
// interior of every wall, so when the grid reads "open" the exact test almost never
// disagrees — skip the per-segment scan there. Only where the grid flags a possible
// wall do we run the exact check, which still threads the narrow gaps at gates,
// breaches and citadel scaling points (the coarse grid alone closed those off and
// made storming units mill around the walls). Fast in the open, precise at the walls.
function blockedFast(x: number, z: number): boolean {
  return !!BLOCKED[cellOf(x, z)] && blockedAt(x, z);
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
// CROSS: the EXTRA cost for a storming flow field to enter a cell. Open ground is
// 0; a standing gate is cheap to force (a ram), a standing wall dearer (an escalade),
// and towers/keep/buildings are impassable. This lets the attacker field reach EVERY
// cell with a gradient toward the cheapest way in — breach, then gate, then wall —
// so troops are never left with no direction (the cause of them balling up at a wall).
const X_INF = 1e9, X_GATE = 16, X_WALL = 20;
const CROSS = new Float32Array(NCELLS);
function crossAt(x: number, z: number): number {
  let pen = 0;
  for (let i = 0; i < CASTLE.length; i++) {
    const b = CASTLE[i]; if (b.dead) continue;
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) {
      if (b.kind === 'gate') pen = Math.max(pen, X_GATE);
      else if (b.kind === 'wall') pen = Math.max(pen, X_WALL);
      else return X_INF; // tower, keep, building — impassable even to a storm
    }
  }
  return pen;
}
function rebuildBlocked() {
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c; const [x, z] = cellCenter(i);
    BLOCKED[i] = blockedAt(x, z) ? 1 : 0;
    CROSS[i] = crossAt(x, z);
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
    if (blockedFast(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return true;
  }
  return false;
}

// ---- Flow field via Dijkstra (8-neighbour) ----
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]] as const;

// cross=true builds the STORMING field that may cross standing walls/gates at a
// cost (so it reaches everywhere); cross=false is the normal open-ground field.
// `seeds` is the goal cell, or several (multi-source) — the storm field seeds the
// whole capture ring, since the keep's own cell is solid and can't expand outward.
function computeField(seeds: number | number[], cross = false): Float32Array {
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
  if (typeof seeds === 'number') { cost[seeds] = 0; push(seeds, 0); }
  else for (const s of seeds) { if (cost[s] !== 0) { cost[s] = 0; push(s, 0); } }
  while (heap.length) {
    const [cell, co] = pop();
    if (co > cost[cell]) continue;
    const cc = cell % COLS, cr = (cell - cc) / COLS;
    for (let k = 0; k < 8; k++) {
      const nc = cc + NB[k][0], nr = cr + NB[k][1];
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      const ni = nr * COLS + nc;
      if (cross ? CROSS[ni] >= X_INF : !!BLOCKED[ni]) continue;
      // no diagonal corner-cutting: both orthogonal cells must be passable (for the
      // storm field, "passable" means not a tower/keep — walls/gates are crossable)
      if (k >= 4) {
        if (cross ? (CROSS[cr * COLS + nc] >= X_INF || CROSS[nr * COLS + cc] >= X_INF)
                  : (BLOCKED[cr * COLS + nc] || BLOCKED[nr * COLS + cc])) continue;
      }
      const ncost = co + NB[k][2] + (cross ? CROSS[ni] : 0);
      if (ncost < cost[ni]) { cost[ni] = ncost; push(ni, ncost); }
    }
  }
  // gradient: each cell points to lowest-cost neighbour
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    if ((cross ? CROSS[i] >= X_INF : !!BLOCKED[i]) || cost[i] === Infinity) continue;
    let best = cost[i], bx = 0, bz = 0;
    for (let k = 0; k < 8; k++) {
      const nc = c + NB[k][0], nr = r + NB[k][1];
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      const ni = nr * COLS + nc;
      if (cross ? CROSS[ni] >= X_INF : !!BLOCKED[ni]) continue;
      if (k >= 4 && (cross ? (CROSS[r * COLS + nc] >= X_INF || CROSS[nr * COLS + c] >= X_INF)
                           : (BLOCKED[r * COLS + nc] || BLOCKED[nr * COLS + c]))) continue; // no corner-cut
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
  // What an attacking arm is ordered to do, and against what. 'hold' = stand on the
  // ordered ground; 'storm' = make for the keep through whatever's open; 'breach' =
  // break in at a specific wall/gate section, then push on to the keep.
  objKind: 'hold' | 'storm' | 'breach';
  objSeg: number;      // the wall/gate section a 'breach' order targets (-1 otherwise)
  // signature stance/ability per arm: Heavy 'shield' (slow, armoured, steady),
  // Light 'sprint' (fast, exposed), Archer 'volley' (longer, harder, slower).
  stance: 'normal' | 'shield' | 'sprint' | 'volley';
  chargeT: number;     // cavalry: seconds of an active couched charge remaining
  chargeCd: number;    // cavalry: seconds until the charge can be sounded again
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
  // Must exceed the total soldier count. If it's too small, overflow soldiers
  // have no backing storage: typed-array writes are silently dropped and reads
  // return undefined, which crashed the renderer (this.meshes[undefined].
  // setMatrixAt). This is the only true ceiling on battle size now — set huge so
  // a whole late-campaign host can take the field uncapped. ~20 arrays * MAX * 4B
  // ≈ a couple MB, trivial; the real cost is sim/draw time, which TARGET paces.
  MAX = 20000;
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
  // per-frame sound-effect tallies; main drains these to drive procedural audio
  sfx = { arrows: 0, bolts: 0, boulders: 0, breaches: 0, melee: 0, deaths: 0, hits: 0, cavalry: 0 };
  drainSfx() { const s = this.sfx; this.sfx = { arrows: 0, bolts: 0, boulders: 0, breaches: 0, melee: 0, deaths: 0, hits: 0, cavalry: 0 }; return s; }
  keepX = 0; keepZ = 0; private captureR = 20;
  n = 0;
  units: Unit[] = [];
  typeCount = [0, 0, 0, 0, 0];
  fields = new Map<number, Float32Array>();
  projectiles: Projectile[] = [];
  ballistae: Emplacement[] = [];
  private _near = new Int32Array(this.MAX).fill(-1); // cached target per soldier (throttled re-scan)
  private _scanCd = new Int16Array(this.MAX);        // frames until next full enemy scan (adaptive)
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
  // The storming field: reaches every cell, routing toward the keep through the
  // cheapest opening (breach → gate → scaled wall) so attackers always have a way in.
  private attackFields = new Map<number, Float32Array>();
  private attackField(goal: number): Float32Array {
    let f = this.attackFields.get(goal);
    if (!f) {
      // Seed the whole capture ground (passable cells near the keep), because the
      // keep's own cell is solid: a single seed inside it can't expand outward, which
      // left the field empty and the attackers with nowhere to go.
      const seeds: number[] = [];
      const R = Math.min(this.captureR * 0.7, 16);
      const c0 = Math.floor((this.keepX - WORLD.minX) / CELL), r0 = Math.floor((this.keepZ - WORLD.minZ) / CELL);
      const span = Math.ceil(R / CELL) + 1;
      for (let dr = -span; dr <= span; dr++) for (let dc = -span; dc <= span; dc++) {
        const c = c0 + dc, r = r0 + dr; if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
        const ci = r * COLS + c; if (CROSS[ci] >= X_INF) continue; // not the keep/towers
        const [x, z] = cellCenter(ci); if ((x - this.keepX) ** 2 + (z - this.keepZ) ** 2 > R * R) continue;
        seeds.push(ci);
      }
      f = computeField(seeds.length ? seeds : [goal], true);
      this.attackFields.set(goal, f);
    }
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
      holdFire: false, assault: false, objKind: 'hold', objSeg: -1,
      stance: 'normal', chargeT: 0, chargeCd: 0,
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
    // pre-compute every defender count. We no longer shrink armies to a tight
    // cap — the whole host marches. The only scale-down left is a safety valve
    // that engages if the combined host would overrun the array (MAX), so a
    // truly enormous siege degrades gracefully instead of crashing.
    // A palisade town is a soft raid: only a sparse picket lines the low wall (so
    // it can't hide behind unreachable archers), and the militia fights on the
    // ground where your infantry can cut it down — a raid you win by routing the
    // defenders, not by a grinding siege.
    const wallPts = archersOnLines(L.wallLines, L.palisade ? 16 : 2.6, 6, L.palisade ? 5 : WH);
    const NT = TOWERS.length;
    const garr = Math.round((L.palisade ? Math.max(140, Math.min(300, Math.round(W * D / 16))) : Math.max(280, Math.min(900, Math.round(W * D / 11)))) * this.difficulty);
    const reserves = Math.round(garr * (L.palisade ? 0.35 : 0.6));
    const citGuard = cit ? Math.round(220 * this.difficulty) : 0;
    const cPts = cit ? archersOnLines(cit.wallLines, 2.4, 4) : [];
    const attReq = C.heavy + C.light + C.archer + C.cavalry;
    const defReq = wallPts.length + NT * 4 + garr + reserves + citGuard + cPts.length;
    // Safety valve only: keep the combined host just under the array ceiling so
    // overflow can never crash the renderer. Below this, nothing is shrunk — go wild.
    const TARGET = this.MAX - 1500; // headroom for trebuchet crews / late spawns
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
    // A citadel is taken by dominating its inner WARD (hold the ground inside the
    // last ring and outnumber its guard); a lone keep, by holding the courtyard
    // immediately around it; a town, by storming its whole centre.
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
    if (this.phase === 'deploy') {
      // while mustering you may only draw up OUTSIDE the enemy walls — clamp the
      // order south of the castle's frontage so troops can't pre-deploy inside it
      const line = LAYOUT.front + 8;
      z0 = Math.max(z0, line); z1 = Math.max(z1, line);
    }
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
      const u = comps[k]; u.assault = false; u.objKind = 'hold'; u.objSeg = -1; this.setAnchor(u, cx, cz, facing, Math.max(3, Math.round(Math.sqrt(u.count) * 1.4)));
    }
  }
  // southernmost line you may muster on during deploy (just outside the walls)
  deployLine(): number { return LAYOUT.front + 8; }
  setSiegeTargetDiv(div: number, segIdx: number) { for (const u of this.divCompanies(div)) { u.siegeTargetSeg = segIdx; u.holdFire = false; } }  setFocusDiv(div: number, x: number, z: number) { for (const u of this.divCompanies(div)) { u.hasFocus = true; u.focusX = x; u.focusZ = z; } }
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
      u.hold = false; u.assault = true; u.objKind = 'storm'; u.objSeg = -1;
      if (u.type === UType.Archer) {
        const ax = Math.max(WORLD.minX + 4, Math.min(WORLD.maxX - 4, u.ax));
        u.ax = ax; u.az = fz; let c = cellOf(ax, fz); if (BLOCKED[c]) c = cellOf(ax, fz + 6); u.goal = c;
      } else { u.goal = keep; u.ax = this.keepX; u.az = this.keepZ; }
    }
  }
  // "Break in HERE": send a melee arm to force a specific wall/gate section — march
  // to it, batter it down and scale it — then push on to the keep once it's open.
  // Archers move up to a firing line facing the section to support the escalade.
  breachSegDiv(div: number, seg: number) {
    const g = CASTLE[seg]; if (!g || g.kind === 'keep') { this.assaultDiv(div); return; }
    const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2;
    // a foot just OUTSIDE the section (on the side facing the keep's challenger)
    const horiz = (g.x1 - g.x0) >= (g.z1 - g.z0);
    // Gather a SPAN of nearby standing wall/gate sections so a large arm escalades a
    // WIDE stretch of wall (ladders all along it) instead of every man funnelling onto
    // one 8m section behind a couple of ladders — which reads as "bunched up, no ladders".
    const span: number[] = [];
    for (let s = 0; s < CASTLE.length; s++) {
      const b = CASTLE[s]; if (b.dead || (b.kind !== 'wall' && b.kind !== 'gate')) continue;
      if (Math.hypot((b.x0 + b.x1) / 2 - cx, (b.z0 + b.z1) / 2 - cz) <= 22) span.push(s);
    }
    if (!span.length) span.push(seg);
    for (const u of this.divCompanies(div)) {
      if (u.type === UType.Siege || u.routing) continue;
      u.hold = false; u.assault = true;
      if (u.type === UType.Archer) {
        u.objKind = 'storm'; // archers don't batter — they shoot from a standoff by the breach
        const perp = horiz ? Math.sign(u.cz - cz) || 1 : Math.sign(u.cx - cx) || 1;
        const ax = horiz ? cx : cx + perp * 10, az = horiz ? cz + perp * 10 : cz;
        u.ax = Math.max(WORLD.minX + 4, Math.min(WORLD.maxX - 4, ax)); u.az = Math.max(WORLD.minZ + 4, Math.min(WORLD.maxZ - 4, az));
        let c = cellOf(u.ax, u.az); if (BLOCKED[c]) c = cellOf(u.ax, u.az + 6); u.goal = c;
      } else {
        // each company forces the nearest section in the span — spreads the escalade
        let bestSeg = span[0], bd = 1e9;
        for (const s of span) { const b = CASTLE[s]; const d = ((b.x0 + b.x1) / 2 - u.cx) ** 2 + ((b.z0 + b.z1) / 2 - u.cz) ** 2; if (d < bd) { bd = d; bestSeg = s; } }
        const bg = CASTLE[bestSeg];
        u.objKind = 'breach'; u.objSeg = bestSeg; u.ax = (bg.x0 + bg.x1) / 2; u.az = (bg.z0 + bg.z1) / 2; u.goal = cellOf(this.keepX, this.keepZ);
      }
    }
    this.field(cellOf(this.keepX, this.keepZ));
  }
  // Did a tap land on the keep itself (the prize)? Used to issue a Storm order.
  keepTapped(x: number, z: number): boolean {
    for (let s = 0; s < CASTLE.length; s++) { const g = CASTLE[s]; if (g.kind !== 'keep') continue; if (x >= g.x0 - 3 && x <= g.x1 + 3 && z >= g.z0 - 3 && z <= g.z1 + 3) return true; }
    return (x - this.keepX) ** 2 + (z - this.keepZ) ** 2 < 14 * 14;
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
    for (const u of this.divCompanies(div)) { u.assault = false; u.objKind = 'hold'; u.objSeg = -1; this.setAnchor(u, u.cx, u.cz, u.facing, Math.max(3, Math.round(Math.sqrt(u.count) * 1.4))); }
  }

  // ---- signature abilities (per arm) ----
  // The stance an arm can hold: Heavy 'shield', Light 'sprint', Archer 'volley'.
  stanceFor(type: UType): Unit['stance'] { return type === UType.Heavy ? 'shield' : type === UType.Light ? 'sprint' : type === UType.Archer ? 'volley' : 'normal'; }
  toggleStanceDiv(div: number): boolean {
    const cs = this.divCompanies(div); if (!cs.length) return false;
    const st = this.stanceFor(cs[0].type); if (st === 'normal') return false;
    const on = cs[0].stance !== st; for (const u of cs) u.stance = on ? st : 'normal';
    return on;
  }
  stanceOnDiv(div: number): boolean { const cs = this.divCompanies(div); return cs.length > 0 && cs[0].stance !== 'normal'; }
  // Sound the cavalry charge: a timed couched-lance burst, then a recovery cooldown.
  chargeDiv(div: number) { for (const u of this.divCompanies(div)) if (u.type === UType.Cavalry && u.chargeCd <= 0 && !u.routing) { u.chargeT = CHARGE_DUR; u.chargeCd = CHARGE_DUR + CHARGE_CD; } }
  chargeReadyDiv(div: number): number { // 0 = charging, 1 = ready, fraction = recovering
    const cs = this.divCompanies(div); if (!cs.length) return 1; const u = cs[0];
    if (u.chargeT > 0) return 0; return u.chargeCd <= 0 ? 1 : 1 - u.chargeCd / CHARGE_CD;
  }
  isCavalry(div: number): boolean { const cs = this.divCompanies(div); return cs.length > 0 && cs[0].type === UType.Cavalry; }
  // movement-speed multiplier from a company's stance / active charge
  private speedMul(u: Unit): number { return u.stance === 'shield' ? 0.62 : u.stance === 'sprint' ? 1.45 : (u.type === UType.Cavalry && u.chargeT > 0) ? CHARGE_SPD : 1; }
  // incoming-damage multiplier on a soldier from its company's stance (shields halve it)
  private defenseMul(i: number): number { const st = this.units[this.unit[i]].stance; return st === 'shield' ? 0.5 : st === 'sprint' ? 1.18 : 1; }

  // ---- spatial hash for neighbour queries ----
  // Flat counting-sort layout: no per-frame allocation, and the unit indices for a
  // cell sit contiguously in one typed array (cache-friendly). hStart[cell] is the
  // offset where cell's indices begin in hItems; hStart[cell+1] is where they end.
  private hCell = 6;
  private hCols = Math.ceil((WORLD.maxX - WORLD.minX) / 6);
  private hRows = Math.ceil((WORLD.maxZ - WORLD.minZ) / 6);
  private hCount = new Int32Array(this.hCols * this.hRows);
  private hStart = new Int32Array(this.hCols * this.hRows + 1);
  private hItems = new Int32Array(this.MAX);
  private hCellOf = new Int32Array(this.MAX); // cached cell per unit (scratch, -1 = dead)
  // dev profiler: per-section step time, accumulated; read+reset via profSnapshot()
  prof = { hash: 0, pre: 0, main: 0, post: 0, steps: 0 };
  profSnapshot() {
    const p = this.prof, s = Math.max(1, p.steps);
    const r = { hash: p.hash / s, pre: p.pre / s, main: p.main / s, post: p.post / s, steps: p.steps };
    p.hash = p.pre = p.main = p.post = p.steps = 0;
    return r;
  }
  private rebuildHash() {
    const total = this.hCols * this.hRows, cols = this.hCols, cell = this.hCellOf, cnt = this.hCount;
    cnt.fill(0);
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) { cell[i] = -1; continue; }
      const c = Math.min(cols - 1, Math.max(0, Math.floor((this.px[i] - WORLD.minX) / this.hCell)));
      const r = Math.min(this.hRows - 1, Math.max(0, Math.floor((this.pz[i] - WORLD.minZ) / this.hCell)));
      const k = r * cols + c; cell[i] = k; cnt[k]++;
    }
    // prefix sum -> start offsets, then reuse cnt as a per-cell write cursor
    let acc = 0;
    for (let k = 0; k < total; k++) { this.hStart[k] = acc; acc += cnt[k]; cnt[k] = 0; }
    this.hStart[total] = acc;
    const items = this.hItems, start = this.hStart;
    for (let i = 0; i < this.n; i++) {
      const k = cell[i]; if (k < 0) continue;
      items[start[k] + cnt[k]++] = i;
    }
  }

  step(dt: number) {
    if (this.phase === 'over') return;
    const deploy = this.phase === 'deploy'; // positioning phase: move, but no combat
    this._frame++;
    const _p = this.prof; let _t = performance.now();
    this.rebuildHash();
    _p.hash += performance.now() - _t; _t = performance.now();

    // morale / routing per unit + centroids + live ammo
    for (const u of this.units) {
      let ax = 0, az = 0, a = 0, am = 0;
      for (let i = u.s0; i < u.s0 + u.count; i++) if (this.alive[i]) { ax += this.px[i]; az += this.pz[i]; a++; am += this.ammo[i]; }
      u.alive = a; u.ammo = am;
      if (a > 0) { u.cx = ax / a; u.cz = az / a; }
      if (!deploy && !u.routing && a > 0 && a / u.count < ROUT_FRAC) u.routing = true;
      if (u.chargeT > 0) u.chargeT = Math.max(0, u.chargeT - dt);   // cavalry charge timers
      if (u.chargeCd > 0) u.chargeCd = Math.max(0, u.chargeCd - dt);
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
      // A town falls once your men dominate its centre; a keep, once you hold its
      // ground with a local MAJORITY over its remaining guard. (It used to demand a
      // 2.5:1 edge at the keep, which — against a massed garrison you can never fully
      // clear under fire — made a stormed citadel impossible to actually take.)
      const pal = LAYOUT.palisade;
      if (attKeep >= (pal ? 5 : 6) && defKeep < attKeep * (pal ? 1.2 : 1.0)) this.captureProgress = Math.min(1, this.captureProgress + dt / (pal ? CAPTURE_TIME * 0.7 : CAPTURE_TIME));
      else if (defKeep > attKeep * (pal ? 1.4 : 1.15)) this.captureProgress = Math.max(0, this.captureProgress - dt * 0.6);
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

    _p.pre += performance.now() - _t; _t = performance.now();
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const u = this.units[this.unit[i]];
      const t = this.typ[i] as UType;
      const spd = SPEED[t] * this.speedMul(u);
      let dx = 0, dz = 0;       // desired direction
      this.cd[i] -= dt;

      const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((this.px[i] - WORLD.minX) / this.hCell)));
      const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((this.pz[i] - WORLD.minZ) / this.hCell)));

      // ---- nearest reachable enemy (skipped during deploy & for siege) ----
      let nearest = -1, nd2 = SENSE[t] * SENSE[t];
      if (!deploy && t !== UType.Siege) {
        const isMelee = t === UType.Heavy || t === UType.Light || t === UType.Cavalry;
        const my = this.py[i];
        // Keep using a still-valid cached target every frame (cheap distance check),
        // and only run the expensive bucket sweep on an adaptive cooldown: a unit in
        // contact rescans often to track/retarget, but one that finds nothing coasts
        // for ~12 frames — so a whole host marching in the open isn't sweeping 49-81
        // buckets per man per frame for enemies that aren't in reach yet.
        const cached = this._near[i];
        if (cached >= 0 && this.alive[cached] && this.fac[cached] !== this.fac[i]) {
          const ex = this.px[cached] - this.px[i], ez = this.pz[cached] - this.pz[i], d2 = ex * ex + ez * ez;
          if (d2 < nd2 && !(isMelee && Math.abs(this.py[cached] - my) > 2.5)) { nearest = cached; nd2 = d2; }
        }
        if (--this._scanCd[i] <= 0) {
          const sr = Math.min(SRAD[t], 4); let done = false;
          for (let rr = hr - sr; rr <= hr + sr && !done; rr++) for (let cc = hc - sr; cc <= hc + sr && !done; cc++) {
            if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
            const k = rr * this.hCols + cc, bs = this.hStart[k]; const bn = Math.min(this.hStart[k + 1] - bs, 18);
            for (let bi = 0; bi < bn; bi++) {
              const j = this.hItems[bs + bi];
              if (this.fac[j] === this.fac[i]) continue;
              if (isMelee && Math.abs(this.py[j] - my) > 2.5) continue; // can't reach wall-top troops
              const ex = this.px[j] - this.px[i], ez = this.pz[j] - this.pz[i], d2 = ex * ex + ez * ez;
              if (d2 < nd2) { nd2 = d2; nearest = j; if (d2 < 6.0) { done = true; break; } } // adjacent → good enough
            }
          }
          this._near[i] = nearest;
          this._scanCd[i] = nearest >= 0 ? 4 : 8; // engaged -> stay sharp; nothing found -> coast
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
          const vol = u.stance === 'volley'; // aimed massed volley: longer, harder, slower
          if (settled && this.cd[i] <= 0 && nearest >= 0 && dist <= RANGE[t] * (vol ? 1.28 : 1) && !u.holdFire && this.focusOk(u, nearest)) {
            this.shoot(i, nearest, vol ? 1.7 : 1); this.cd[i] = ATKCD[t] * (vol ? 1.85 : 1); this.ammo[i]--;
          }
        } else {
          // melee — including archers who've spent all their arrows
          // Defender reserves rush to MOUNT a wall the enemy is scaling.
          if (u.hold && u.faction === Faction.Defender && t === UType.Light && nearest >= 0 && this.py[nearest] > 2 && dist < 16) {
            const seg = this.nearestClimbWall(this.px[i], this.pz[i]); if (seg >= 0) { this.startClimb(i, seg); continue; }
          }
          const mrng = t === UType.Archer ? RANGE[UType.Light] : RANGE[t];
          const charge = t === UType.Cavalry && u.chargeT > 0 ? CHARGE_DMG : 1;
          const mdmg = (t === UType.Archer ? MELEE[UType.Light] : MELEE[t]) * (u.faction === Faction.Attacker ? this.atk.melee : 1) * charge;
          if (nearest >= 0 && dist <= mrng) {
            if (this.cd[i] <= 0) { this.hp[nearest] -= mdmg * this.defenseMul(nearest); this.cd[i] = ATKCD[t]; this.sfx.melee++; if (t === UType.Cavalry && u.faction === Faction.Attacker) this.sfx.cavalry++; if (this.hp[nearest] <= 0) this.kill(nearest, this.units[this.unit[nearest]]); }
          } else if (nearest >= 0 && dist < ENGAGE && !u.hold && !pathBlocked(this.px[i], this.pz[i], this.px[nearest], this.pz[nearest])
                     && (u.faction !== Faction.Attacker || (u.cx - u.ax) ** 2 + (u.cz - u.az) ** 2 < CHASE_LEASH * CHASE_LEASH)) {
            // chase a *reachable* enemy — but only once the company has reached its
            // ordered ground, so a marching arm isn't dragged off course en route
            const ex = this.px[nearest] - this.px[i], ez = this.pz[nearest] - this.pz[i]; const l = dist || 1; dx = ex / l; dz = ez / l;
          } else if (!u.hold && u.faction === Faction.Attacker && (u.objKind === 'storm' || u.objKind === 'breach')) {
            // Storming/breaching: drive at the objective and break through the wall
            // standing in the way — march to its foot, batter it down and scale it.
            this.assaultMove(i, u, t); dx = this._dir[0]; dz = this._dir[1];
          } else if (!u.hold) {
            this.formMove(u, i); dx = this._dir[0]; dz = this._dir[1];
            if (this._stuck) {
              // The ordered ground is walled off from us. An attacker fights its way
              // INWARD via the storming field (so it heads for an opening rather than
              // balling up against a wall — cavalry included); a defender scales.
              if (u.faction === Faction.Attacker) { this.assaultMove(i, u, t); dx = this._dir[0]; dz = this._dir[1]; }
              else if (t !== UType.Cavalry) { this.useLadder(i); dx = this._dir[0]; dz = this._dir[1]; }
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
      // The separation radius (~1.7m) is far smaller than a hash cell (6m), so only
      // the buckets whose edge the soldier actually sits near can hold a neighbour in
      // range. Scan just those (usually 1, at most 4) instead of the full 3x3 — the
      // result is identical, at a fraction of the work where crowds pile up.
      let sx = 0, sz = 0;
      const rad = RADIUS[t] * 1.7, rad2 = rad * rad;
      const lx = (this.px[i] - WORLD.minX) - hc * this.hCell;
      const lz = (this.pz[i] - WORLD.minZ) - hr * this.hCell;
      const cLo = lx < rad ? hc - 1 : hc, cHi = lx > this.hCell - rad ? hc + 1 : hc;
      const rLo = lz < rad ? hr - 1 : hr, rHi = lz > this.hCell - rad ? hr + 1 : hr;
      for (let rr = rLo; rr <= rHi; rr++) for (let cc = cLo; cc <= cHi; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const k = rr * this.hCols + cc, bs = this.hStart[k];
        // cap neighbours sampled per bucket — separation is a soft force, so a
        // sample suffices and it keeps the gate pile from melting the frame-rate
        const cap = Math.min(this.hStart[k + 1] - bs, 22);
        for (let bi = 0; bi < cap; bi++) {
          const j = this.hItems[bs + bi]; if (j === i || this.fac[j] !== this.fac[i] || this.climbState[j] > 0) continue;
          const ex = this.px[i] - this.px[j], ez = this.pz[i] - this.pz[j];
          // separation radius kept BELOW formation spacing so soldiers settled
          // in their ranks don't shove each other (that caused the vibrating).
          const d2 = ex * ex + ez * ez;
          if (d2 > 0.0001 && d2 < rad2) { const d = Math.sqrt(d2); sx += ex / d * (1 - d / rad); sz += ez / d * (1 - d / rad); }
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
      if (this.py[i] < 1 && blockedFast(nx, nz)) { // ground units collide with walls (grid-accelerated, gap-precise)
        if (!blockedFast(nx, this.pz[i])) { nz = this.pz[i]; this.vz[i] = 0; }
        else if (!blockedFast(this.px[i], nz)) { nx = this.px[i]; this.vx[i] = 0; }
        else { nx = this.px[i]; nz = this.pz[i]; this.vx[i] = 0; this.vz[i] = 0; }
      }
      this.px[i] = Math.max(WORLD.minX, Math.min(WORLD.maxX, nx));
      this.pz[i] = Math.max(WORLD.minZ, Math.min(WORLD.maxZ, nz));
    }

    _p.main += performance.now() - _t; _t = performance.now();
    if (!deploy) { this.stepRams(dt); this.stepBallistae(dt); this.stepProjectiles(dt); this.checkVictory(); }
    _p.post += performance.now() - _t; _p.steps++;
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
  // The breach (fallen wall/gate) that best leads INWARD toward the keep — the one
  // minimising (walk to breach + breach to keep), counting only breaches that
  // actually get us closer to the keep than we already are. Without the inward
  // test, a unit that has fought its way into the bailey of a concentric castle
  // doubles back to the outer breach it entered through (the nearest breach, but
  // FARTHER from the keep) instead of breaching/scaling the inner ward — so the
  // keep can never be reached and the siege is unwinnable.
  private breachToward(x: number, z: number): number {
    const dKeep = Math.hypot(this.keepX - x, this.keepZ - z);
    let best = -1, bc = 1e9;
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s]; if (!g.dead || (g.kind !== 'wall' && g.kind !== 'gate')) continue;
      const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2;
      const bk = Math.hypot(this.keepX - cx, this.keepZ - cz);
      if (bk >= dKeep - 1) continue;                 // breach is no closer to the keep — not progress
      const cost = Math.hypot(cx - x, cz - z) + bk;  // cheapest route in through this gap
      if (cost < bc) { bc = cost; best = s; }
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
  private LADDER_CAP = 160;
  private findOrMakeLadder(seg: number, i: number): number {
    const g = CASTLE[seg], horiz = (g.x1 - g.x0) >= (g.z1 - g.z0);
    const myAlong = horiz ? this.px[i] : this.pz[i];
    let best = -1, bd = 1e9, onSeg = 0;
    for (let l = 0; l < this.ladders.length; l++) {
      const L = this.ladders[l]; if (L.seg !== seg) continue;
      onSeg++; const d = Math.abs(L.along - myAlong); if (d < bd) { bd = d; best = l; }
    }
    if (best >= 0 && bd < 5) return best;                 // reuse a nearby ladder
    const segLen = horiz ? g.x1 - g.x0 : g.z1 - g.z0;
    const cap = Math.max(1, Math.floor(segLen / 4));
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
  // Drive an attacking soldier at its objective, breaking through the wall in the
  // way: march to the section's foot, batter it down, and scale it (infantry).
  private assaultMove(i: number, u: Unit, t: UType) {
    // A "break in HERE" order: smash the named section until it's open, even if a
    // way already exists elsewhere — the player chose this wall.
    if (u.objKind === 'breach') {
      if (u.objSeg >= 0 && CASTLE[u.objSeg] && !CASTLE[u.objSeg].dead) { this.engageWall(i, u, t, u.objSeg); return; }
      // the wall is rubble — re-home the company onto the keep and pour through,
      // instead of milling on the spot where the wall stood.
      u.objKind = 'storm'; u.objSeg = -1; u.ax = this.keepX; u.az = this.keepZ; u.goal = cellOf(this.keepX, this.keepZ);
    }
    // Storming: follow the STORMING flow field. It reaches every cell and points at
    // the cheapest way in — an existing breach first, then a gate to ram, then a wall
    // to scale — so the column always funnels through whatever opening is nearest and
    // never balls up against a blank wall. Where the field steers us into a standing
    // section, we engage it (ram a gate / scale a wall).
    const f = this.attackField(cellOf(this.keepX, this.keepZ));
    const ci = cellOf(this.px[i], this.pz[i]);
    const fx = f[ci * 2], fz = f[ci * 2 + 1];
    if (fx === 0 && fz === 0) { this.formMove(u, i); return; } // on the keep ground / enclosed pocket
    const probe = this.CLIMB + 2;
    if (blockedAt(this.px[i] + fx * probe, this.pz[i] + fz * probe)) {
      const seg = this.wallSegAtPoint(this.px[i] + fx * probe, this.pz[i] + fz * probe);
      if (seg >= 0) {
        if (t === UType.Cavalry && CASTLE[seg].kind !== 'gate') {
          // horse can't scale — peel off to an opening it can actually ride through
          const op = this.breachToward(this.px[i], this.pz[i]);
          if (op >= 0) { const g = CASTLE[op], bx = (g.x0 + g.x1) / 2 - this.px[i], bz = (g.z0 + g.z1) / 2 - this.pz[i], bl = Math.hypot(bx, bz) || 1; this._dir[0] = bx / bl; this._dir[1] = bz / bl; }
          else { this._dir[0] = 0; this._dir[1] = 0; } // wait for the foot to open a way, don't ride into the wall
          return;
        }
        this.engageWall(i, u, t, seg); return;
      }
    }
    this._dir[0] = fx; this._dir[1] = fz;
  }
  // March to a wall/gate section's foot, then force it: a GATE is rammed (we just
  // count the crew here; the fixed-rate ram damage is applied once per tick in
  // step), while a stone WALL is only ever SCALED (you don't smash a curtain wall
  // with swords — that's what the engines are for).
  private engageWall(i: number, u: Unit, t: UType, seg: number) {
    const g = CASTLE[seg];
    const cpx = Math.max(g.x0, Math.min(g.x1, this.px[i])), cpz = Math.max(g.z0, Math.min(g.z1, this.pz[i]));
    const dxw = cpx - this.px[i], dzw = cpz - this.pz[i], dw = Math.hypot(dxw, dzw);
    if (dw <= this.CLIMB + 1.5) {
      if (g.kind === 'gate') {                 // join the ram crew, pressing against the gate
        if (u.faction === Faction.Attacker) g.ramCrew = (g.ramCrew || 0) + 1;
        const l = dw || 1; this._dir[0] = dxw / l * 0.18; this._dir[1] = dzw / l * 0.18;
      } else if (t === UType.Cavalry) {        // horse can't scale — wait at the foot for a gap
        const l = dw || 1; this._dir[0] = dxw / l * 0.25; this._dir[1] = dzw / l * 0.25;
      } else this.useLadder(i, seg);           // scale the wall (never battered)
    } else { const l = dw || 1; this._dir[0] = dxw / l; this._dir[1] = dzw / l; } // march to its foot
  }
  // Fixed-rate gate ram: once a crew is on a gate it loses HP at RAM_DPS, no faster
  // for a mob than for a company. Run once per tick after movement has counted crews.
  private stepRams(dt: number) {
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s]; if (g.kind !== 'gate') continue;
      if (!g.dead && (g.ramCrew || 0) >= RAM_CREW) {
        g.hp -= RAM_DPS * (0.7 + 0.3 * this.atk.melee) * dt; g.ramT = this._frame; this.sfx.melee++;
        if (g.hp <= 0) this.breach(s);
      }
      g.ramCrew = 0; // reset for next tick
    }
  }
  // Gates currently under the ram (struck within the last ~0.4s), with a point just
  // OUTSIDE the gate and the heading to face it — so the renderer can show a ram.
  rammingGates(): { x: number; z: number; ang: number; seg: number }[] {
    const out: { x: number; z: number; ang: number; seg: number }[] = [];
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s];
      if (g.kind !== 'gate' || g.dead || g.ramT === undefined || this._frame - g.ramT > 20) continue;
      const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2;
      let nx = cx - this.keepX, nz = cz - this.keepZ; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl; // outward from the keep = the attackers' side
      out.push({ x: cx + nx * 4.2, z: cz + nz * 4.2, ang: Math.atan2(-nx, -nz), seg: s });
    }
    return out;
  }
  private useLadder(i: number, seg = this.wallTowardGoal(i)) {
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
      const clear = this.ladderMinPy[L] === undefined || this.ladderMinPy[L] > 1.8;
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
        this.py[i] = Math.min(WH, this.py[i] + 5.0 * dt);
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

  private shoot(i: number, target: number, dmgMul = 1) {
    this.sfx.arrows++;
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
    p.dmg = (fire ? ARCHER_PROJ_DMG * 1.7 : ARCHER_PROJ_DMG) * (atkShot ? this.atk.archer : 1.25) * dmgMul; p.wall = -1; p.big = false; p.fire = fire; p.splash = 0; p.bolt = false;
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
    this.sfx.boulders++;
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
    this.sfx.breaches++;
    seg.dead = true;
    rebuildBlocked();
    this.fields.clear(); this.attackFields.clear(); // passability changed — recompute flow fields on demand
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
  // Apply a ranged hit, with SHIELDS for ground attackers: a storming column raises
  // shields against the plunging fire from the walls, so an assault isn't simply
  // annihilated crossing the killing ground before it can force an entry. (Melee is
  // unaffected — this only blunts arrows and bolts, and only for attackers on foot.)
  private applyRangedHit(j: number, dmg: number, bolt: boolean) {
    if (this.fac[j] === Faction.Attacker && this.py[j] < 2.5) dmg *= bolt ? 0.68 : 0.5;
    dmg *= this.defenseMul(j); // a shield wall turns arrows too
    this.hp[j] -= dmg;
    if (this.hp[j] <= 0) this.kill(j, this.units[this.unit[j]]);
  }
  private artySplash(x: number, z: number, fac: Faction, dmg: number, radius: number) {
    const r2 = radius * radius;
    const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((x - WORLD.minX) / this.hCell)));
    const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((z - WORLD.minZ) / this.hCell)));
    const span = Math.ceil(radius / this.hCell) + 1;
    for (let rr = hr - span; rr <= hr + span; rr++) for (let cc = hc - span; cc <= hc + span; cc++) {
      if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
      const k = rr * this.hCols + cc;
      for (let bi = this.hStart[k]; bi < this.hStart[k + 1]; bi++) {
        const j = this.hItems[bi];
        if (this.fac[j] === fac || this.typ[j] === UType.Siege || !this.alive[j]) continue;
        const d2 = (this.px[j] - x) ** 2 + (this.pz[j] - z) ** 2; if (d2 > r2) continue;
        this.applyRangedHit(j, d2 < 2.0 ? dmg : dmg * 0.2, true); // direct hit lethal, very little spill
      }
    }
  }
  private fireBolt(e: Emplacement, target: number) {
    this.sfx.bolts++;
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
      // nearest attacker on the ground within reach — search only the hash cells the
      // ballista can actually shoot into, not the whole army
      let best = -1, bd = BALLISTA_RANGE * BALLISTA_RANGE;
      const ec = Math.min(this.hCols - 1, Math.max(0, Math.floor((e.x - WORLD.minX) / this.hCell)));
      const er = Math.min(this.hRows - 1, Math.max(0, Math.floor((e.z - WORLD.minZ) / this.hCell)));
      const span = Math.ceil(BALLISTA_RANGE / this.hCell) + 1;
      for (let rr = er - span; rr <= er + span; rr++) for (let cc = ec - span; cc <= ec + span; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const k = rr * this.hCols + cc, ke = this.hStart[k + 1];
        for (let bi = this.hStart[k]; bi < ke; bi++) {
          const i = this.hItems[bi];
          if (!this.alive[i] || this.fac[i] !== Faction.Attacker || this.typ[i] === UType.Siege || this.py[i] > 4) continue;
          const dx = this.px[i] - e.x, dz = this.pz[i] - e.z, d2 = dx * dx + dz * dz;
          if (d2 < bd) { bd = d2; best = i; }
        }
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
          if (seg && !seg.dead) { this.sfx.hits++; seg.hp -= p.dmg; if (seg.hp <= 0) this.breach(hit); }
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
            const k = rr * this.hCols + cc, be = this.hStart[k + 1];
            for (let bi = this.hStart[k]; bi < be; bi++) { const j = this.hItems[bi]; if (this.fac[j] === p.fac || !this.alive[j]) continue; const d2 = (this.px[j] - p.tx) ** 2 + (this.pz[j] - p.tz) ** 2; if (d2 < bd2) { bd2 = d2; best = j; } }
          }
          if (best >= 0) this.applyRangedHit(best, p.dmg, false);
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
