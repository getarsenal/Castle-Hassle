// Castle Hassle — battle simulation.
// Data-oriented: all soldiers live in flat typed arrays (Struct-of-Arrays) so
// we can push ~2000 agents with no per-entity GC churn. Movement uses a shared
// flow field per destination (no per-agent A*). Fixed-timestep & seeded so it's
// deterministic (replays / future PvP come cheap).

export const WORLD = { minX: -130, maxX: 130, minZ: -120, maxZ: 175 };
export const CELL = 2;
export const COLS = Math.round((WORLD.maxX - WORLD.minX) / CELL); // 100
export const ROWS = Math.round((WORLD.maxZ - WORLD.minZ) / CELL); // 90
export const NCELLS = COLS * ROWS;

export const enum Faction { Attacker = 0, Defender = 1 }
export const enum UType { Heavy = 0, Light = 1, Archer = 2, Cavalry = 3, Siege = 4 }

export const TYPE_NAME = ['Heavy Inf', 'Light Inf', 'Archers', 'Cavalry', 'Trebuchets'];

// ---- army composition (chosen on the muster screen before battle) ----
export interface ArmyComp { heavy: number; light: number; archer: number; cavalry: number; siege: number; }
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
const PROJ_G = 28; // projectile gravity (higher = more pronounced arc)
const ROUT_FRAC = 0.3;

export function maxHp(t: UType) { return HP[t]; }

// ---- Procedural castle. A destructible AABB segment list (so all collision &
// siege mechanics work unchanged) plus a structured LAYOUT used for rendering
// and defender deployment. Bigger than before, varied per seed, with a town of
// buildings inside and (on larger ones) an inner CITADEL that must be taken. ----
export type SegKind = 'wall' | 'gate' | 'tower' | 'keep' | 'building';
export interface Seg { x0: number; x1: number; z0: number; z1: number; h: number; kind: SegKind; hp: number; maxhp: number; dead: boolean; }
export interface WallLine { x0: number; z0: number; x1: number; z1: number; horiz: boolean; outer: number; gapC: number; gapH: number; }
export interface Citadel { x0: number; x1: number; z0: number; z1: number; cx: number; cz: number; gate: { x: number; z: number }; wallLines: WallLine[]; }
export interface CastleLayout {
  W: number; D: number; gate: { x: number; z: number };
  wallLines: WallLine[]; towers: { x: number; z: number; big: boolean }[];
  buildings: { x: number; z: number; w: number; d: number }[]; citadel: Citadel | null;
}

export const T = 4, WH = 9, SEG = 8;
export const TOWERS: { x: number; z: number; big: boolean }[] = [];
export let CASTLE: Seg[] = [];
export let LAYOUT: CastleLayout = null as any;

function genRng(seed: number) { let s = (seed >>> 0) || 1; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function generateCastle(seed: number) {
  CASTLE = []; TOWERS.length = 0;
  const segs = CASTLE;
  const R = genRng(Math.imul(seed >>> 0, 2654435761) >>> 0);
  const rr = (a: number, b: number) => a + R() * (b - a);
  const wall = (x0: number, x1: number, z0: number, z1: number, kind: SegKind = 'wall', h = WH) => {
    if (x1 - x0 < 0.3 || z1 - z0 < 0.3) return;
    const hp = kind === 'gate' ? 1100 : kind === 'building' ? 1e9 : 1700;
    segs.push({ x0, x1, z0, z1, h: kind === 'gate' ? WH - 1 : h, kind, hp, maxhp: hp, dead: false });
  };
  const tower = (x: number, z: number, big: boolean, list?: { x: number; z: number; big: boolean }[]) => {
    const r = big ? 5 : 4.2, hp = big ? 3200 : 2600;
    segs.push({ x0: x - r, x1: x + r, z0: z - r, z1: z + r, h: big ? WH + 6 : WH + 4, kind: 'tower', hp, maxhp: hp, dead: false });
    TOWERS.push({ x, z, big }); if (list) list.push({ x, z, big });
  };
  // a four-walled compound with a south gate; returns its wall-lines + towers
  const compound = (x0: number, x1: number, z0: number, z1: number, gateX: number, gh: number, gateOnSouth: boolean, tw?: { x: number; z: number; big: boolean }[]) => {
    const lines: WallLine[] = [];
    for (let x = x0; x < x1 - 0.1; x += SEG) { const e = Math.min(x + SEG, x1), c = (x + e) / 2; wall(x, e, z1 - T, z1, gateOnSouth && Math.abs(c - gateX) < gh ? 'gate' : 'wall'); } // south
    for (let x = x0; x < x1 - 0.1; x += SEG) wall(x, Math.min(x + SEG, x1), z0, z0 + T, 'wall'); // north
    for (let z = z0; z < z1 - 0.1; z += SEG) { const e = Math.min(z + SEG, z1); wall(x0, x0 + T, z, e, 'wall'); wall(x1 - T, x1, z, e, 'wall'); } // w/e
    lines.push({ x0, z0: z1 - T / 2, x1, z1: z1 - T / 2, horiz: true, outer: 1, gapC: gateOnSouth ? gateX : 1e9, gapH: gh });
    lines.push({ x0, z0: z0 + T / 2, x1, z1: z0 + T / 2, horiz: true, outer: -1, gapC: 1e9, gapH: 0 });
    lines.push({ x0: x0 + T / 2, z0, x1: x0 + T / 2, z1, horiz: false, outer: -1, gapC: 1e9, gapH: 0 });
    lines.push({ x0: x1 - T / 2, z0, x1: x1 - T / 2, z1, horiz: false, outer: 1, gapC: 1e9, gapH: 0 });
    tower(x0, z0, false, tw); tower(x1, z0, false, tw); tower(x0, z1, false, tw); tower(x1, z1, false, tw);
    return lines;
  };

  // ----- outer compound (bigger & varied) -----
  const W = Math.round(rr(52, 72) / 2) * 2, D = Math.round(rr(48, 62) / 2) * 2;
  const GH = 9, gateX = Math.round(rr(-W * 0.22, W * 0.22) / SEG) * SEG;
  const wallLines = compound(-W, W, -D, D, gateX, GH, true);
  // mid-wall towers
  for (let x = -W + 28; x < W - 18; x += 28) { tower(x, -D, false); if (Math.abs(x - gateX) > GH + 7) tower(x, D, false); }
  for (let z = -D + 28; z < D - 18; z += 28) { tower(-W, z, false); tower(W, z, false); }
  tower(gateX - GH - 3, D, true); tower(gateX + GH + 3, D, true); // gatehouse

  // ----- citadel (inner keep complex) on larger castles -----
  let citadel: Citadel | null = null;
  if (W * D > 2900 || R() < 0.55) {
    const cw = 19, cd = 15, ccx = Math.round(rr(-W * 0.18, W * 0.18)), ccz = -Math.round(D * 0.34);
    const cTowers: { x: number; z: number; big: boolean }[] = [];
    const cLines = compound(ccx - cw, ccx + cw, ccz - cd, ccz + cd, ccx, 6, true, cTowers);
    segs.push({ x0: ccx - 7, x1: ccx + 7, z0: ccz - 6, z1: ccz + 6, h: 21, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
    citadel = { x0: ccx - cw, x1: ccx + cw, z0: ccz - cd, z1: ccz + cd, cx: ccx, cz: ccz, gate: { x: ccx, z: ccz + cd }, wallLines: cLines };
  } else {
    segs.push({ x0: -8, x1: 8, z0: -8, z1: 8, h: 18, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
  }

  // ----- town buildings in the bailey (avoid walls, the gate avenue & citadel) -----
  const buildings: { x: number; z: number; w: number; d: number }[] = [];
  for (let bx = -W + 14; bx < W - 14; bx += rr(13, 18)) {
    for (let bz = -D + 14; bz < D - 14; bz += rr(12, 17)) {
      if (R() < 0.34) continue;
      const bw = rr(3.5, 6.5), bd = rr(3.5, 5.5), x = bx + rr(0, 4), z = bz + rr(0, 4);
      if (Math.abs(x - gateX) < 9 && z > -D * 0.1) continue;                 // keep the gate avenue clear
      if (citadel && x > citadel.x0 - 7 && x < citadel.x1 + 7 && z > citadel.z0 - 7 && z < citadel.z1 + 7) continue;
      if (x - bw < -W + T + 3 || x + bw > W - T - 3 || z - bd < -D + T + 3 || z + bd > D - T - 3) continue;
      wall(x - bw, x + bw, z - bd, z + bd, 'building', rr(5, 9)); buildings.push({ x, z, w: bw, d: bd });
    }
  }

  LAYOUT = { W, D, gate: { x: gateX, z: D }, wallLines, towers: [...TOWERS], buildings, citadel };
  rebuildBlocked();
}

function blockedAt(x: number, z: number): boolean {
  for (let i = 0; i < CASTLE.length; i++) {
    const b = CASTLE[i];
    if (!b.dead && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
  }
  return false;
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
  name: string;
}

// per-type formation spacing
const SPACING = [1.5, 1.3, 1.4, 2.1, 10];
const ENGAGE = 9; // range at which troops break formation to fight

export interface Projectile {
  active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  tx: number; tz: number; dmg: number; fac: Faction;
  wall: number;   // target wall-segment index for boulders, else -1
  big: boolean;   // boulder vs arrow (render size)
  fire: boolean;  // flaming arrow (tower archers)
}

export class Sim {
  // Must exceed the total soldier count (currently ~2,220). If it's too small,
  // overflow soldiers have no backing storage: typed-array writes are silently
  // dropped and reads return undefined, which crashed the renderer
  // (this.meshes[undefined].setMatrixAt). Keep generous headroom.
  MAX = 3800;
  px = new Float32Array(this.MAX); pz = new Float32Array(this.MAX); py = new Float32Array(this.MAX);
  vx = new Float32Array(this.MAX); vz = new Float32Array(this.MAX);
  hp = new Float32Array(this.MAX); cd = new Float32Array(this.MAX);
  unit = new Int16Array(this.MAX); fac = new Uint8Array(this.MAX); typ = new Uint8Array(this.MAX);
  alive = new Uint8Array(this.MAX); slot = new Int32Array(this.MAX);
  ammo = new Float32Array(this.MAX);
  // wall-scaling: 0 ground, 1 climbing up, 2 on wall-top, 3 descending inside
  climbState = new Uint8Array(this.MAX); climbSeg = new Int16Array(this.MAX);
  n = 0;
  units: Unit[] = [];
  typeCount = [0, 0, 0, 0, 0];
  fields = new Map<number, Float32Array>();
  projectiles: Projectile[] = [];
  phase: 'deploy' | 'battle' | 'over' = 'deploy';
  winner: Faction | null = null;
  private seed: number;
  private comp: ArmyComp;
  attackerAliveStart = 0; defenderAliveStart = 0;

  constructor(seed = 1234, comp: ArmyComp = DEFAULT_COMP) { this.seed = seed >>> 0; this.comp = comp; generateCastle(seed); this.setup(); }

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
    if (this.n + count > this.MAX) throw new Error(`Soldier cap exceeded: need ${this.n + count}, MAX is ${this.MAX}. Raise Sim.MAX.`);
    const s0 = this.n;
    let sx = 0, sz = 0;
    for (let i = 0; i < count; i++) {
      const id = this.n++;
      const [x, z, y] = place(i);
      this.px[id] = x; this.pz[id] = z; this.py[id] = y; sx += x; sz += z;
      this.hp[id] = HP[type]; this.cd[id] = this.rnd() * 0.5; this.ammo[id] = AMMO[type];
      this.unit[id] = this.units.length; this.fac[id] = faction; this.typ[id] = type;
      this.alive[id] = 1; this.slot[id] = this.typeCount[type]++;
    }
    const ax = sx / count, az = sz / count;
    const u: Unit = {
      id: this.units.length, faction, type, s0, count, alive: count,
      morale: 100, routing: false, hold: !!opts.hold,
      goal: opts.goal ?? cellOf(ax, az),
      ax, az,
      facing: Math.atan2(0 - ax, 0 - az), // face the castle (origin) by default
      cols: opts.cols ?? (type === UType.Siege ? count : Math.max(6, Math.round(Math.sqrt(count) * 1.7))),
      cx: ax, cz: az, siegeTargetSeg: -1,
      ammo: AMMO[type] * count, ammoMax: AMMO[type] * count,
      focusX: 0, focusZ: 0, hasFocus: false, fireArrows: !!opts.fireArrows,
      holdFire: false,
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
    const R = (a: number, b: number) => a + this.rnd() * (b - a);
    // grid block placement helper
    const block = (cx: number, cz: number, cols: number, gap: number) => (i: number): [number, number, number] => {
      const c = i % cols, r = Math.floor(i / cols);
      return [cx + (c - cols / 2) * gap + R(-0.4, 0.4), cz + r * gap + R(-0.4, 0.4), 0];
    };

    const L = LAYOUT, W = L.W, D = L.D;
    // ---------------- ATTACKERS (south of the castle, player) ----------------
    const C = this.comp; const cols = (n: number) => Math.max(8, Math.round(Math.sqrt(n) * 1.7));
    if (C.heavy) this.addUnit(Faction.Attacker, UType.Heavy, C.heavy, block(0, D + 22, cols(C.heavy), 1.6), { name: 'Heavy Inf', cols: cols(C.heavy) });
    if (C.light) this.addUnit(Faction.Attacker, UType.Light, C.light, block(-W * 0.7, D + 30, cols(C.light), 1.4), { name: 'Light Inf', cols: cols(C.light) });
    if (C.archer) this.addUnit(Faction.Attacker, UType.Archer, C.archer, block(0, D + 42, cols(C.archer), 1.5), { name: 'Archers', cols: cols(C.archer) });
    if (C.cavalry) this.addUnit(Faction.Attacker, UType.Cavalry, C.cavalry, block(W * 0.8, D + 30, cols(C.cavalry), 2.2), { name: 'Cavalry', cols: cols(C.cavalry) });
    if (C.siege) this.addUnit(Faction.Attacker, UType.Siege, C.siege, block(0, D + 58, C.siege, 13), { name: 'Trebuchets', cols: C.siege });

    // ---------------- DEFENDERS (generated from the layout) ----------------
    // archers lined along a set of wall-lines (two ranks, inset from corners/gate)
    const archersOnLines = (lines: WallLine[], spacing: number, inset: number): [number, number, number][] => {
      const pts: [number, number, number][] = [];
      for (const ln of lines) {
        const a0 = (ln.horiz ? ln.x0 : ln.z0) + inset, a1 = (ln.horiz ? ln.x1 : ln.z1) - inset;
        for (let a = a0; a <= a1; a += spacing) {
          if (Math.abs(a - ln.gapC) < ln.gapH + 1) continue; // leave the gate clear
          for (let rk = 0; rk < 2; rk++) {
            const off = -ln.outer * rk * 1.3;
            pts.push(ln.horiz ? [a, ln.z0 + off, WH] : [ln.x0 + off, a, WH]);
          }
        }
      }
      return pts;
    };
    const wallPts = archersOnLines(L.wallLines, 2.6, 6);
    this.addUnit(Faction.Defender, UType.Archer, wallPts.length, (i) => wallPts[i], { hold: true, name: 'Wall Archers' });
    // tower archers (flaming) on every tower top
    const NT = TOWERS.length;
    this.addUnit(Faction.Defender, UType.Archer, NT * 4, (i) => {
      const tw = TOWERS[Math.floor(i / 4) % NT], k = i % 4;
      return [tw.x + (k % 2 - 0.5) * 2.2, tw.z + (Math.floor(k / 2) - 0.5) * 2.2, tw.big ? WH + 6 : WH + 4];
    }, { hold: true, fireArrows: true, name: 'Tower Archers' });
    // garrison + reserves scattered through the open bailey (rejection-sampled
    // off the buildings/walls/citadel), holding their ground
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
    const garr = Math.max(280, Math.min(560, Math.round(W * D / 14)));
    this.addUnit(Faction.Defender, UType.Heavy, garr, openBailey, { hold: true, name: 'Garrison' });
    this.addUnit(Faction.Defender, UType.Light, Math.round(garr * 0.6), openBailey, { hold: true, name: 'Reserves' });
    // citadel garrison + its own wall archers (the last redoubt)
    if (cit) {
      const inCit = (): [number, number, number] => {
        let x = 0, z = 0;
        for (let t = 0; t < 40; t++) { x = R(cit.x0 + T + 1, cit.x1 - T - 1); z = R(cit.z0 + T + 1, cit.z1 - T - 1); if (!blockedAt(x, z)) return [x, z, 0]; }
        return [x, z, 0];
      };
      this.addUnit(Faction.Defender, UType.Heavy, 220, inCit, { hold: true, name: 'Citadel Guard' });
      const cPts = archersOnLines(cit.wallLines, 2.4, 4);
      this.addUnit(Faction.Defender, UType.Archer, cPts.length, (i) => cPts[i], { hold: true, name: 'Citadel Archers' });
    }

    for (const u of this.units) {
      if (u.faction === Faction.Attacker) this.attackerAliveStart += u.count;
      else this.defenderAliveStart += u.count;
    }
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

  begin() { if (this.phase === 'deploy') this.phase = 'battle'; }

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
      // The defense only collapses once it's genuinely beaten — NOT the moment a
      // few attackers stand in the bailey. Either the ground garrison (incl. the
      // citadel guard) is broken, OR the defenders have been ground down to a
      // remnant AND the attackers overwhelmingly hold the courtyard. This stops
      // the castle "falling" with most of the garrison still alive.
      let defGround = 0, defAlive = 0, attInside = 0;
      for (let i = 0; i < this.n; i++) {
        if (!this.alive[i]) continue;
        if (this.fac[i] === Faction.Defender) {
          defAlive++;
          if ((this.typ[i] === UType.Heavy || this.typ[i] === UType.Light) && this.climbState[i] === 0 && this.py[i] < 2) defGround++;
        } else if (this.climbState[i] === 0 && this.py[i] < 2 && Math.abs(this.px[i]) < LAYOUT.W - 1 && Math.abs(this.pz[i]) < LAYOUT.D - 1 && this.typ[i] !== UType.Siege) attInside++;
      }
      const defFrac = defAlive / Math.max(1, this.defenderAliveStart);
      if (defGround < 25 || (defFrac < 0.5 && attInside > 80 && attInside > 2.5 * defGround))
        for (const u of this.units) if (u.faction === Faction.Defender) u.routing = true;
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
        const sr = SRAD[t]; const isMelee = t === UType.Heavy || t === UType.Light || t === UType.Cavalry;
        const my = this.py[i];
        for (let rr = hr - sr; rr <= hr + sr; rr++) for (let cc = hc - sr; cc <= hc + sr; cc++) {
          if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
          const b = this.buckets[rr * this.hCols + cc];
          for (let bi = 0; bi < b.length; bi++) {
            const j = b[bi];
            if (this.fac[j] === this.fac[i]) continue;
            if (isMelee && Math.abs(this.py[j] - my) > 2.5) continue; // can't reach wall-top troops
            const ex = this.px[j] - this.px[i], ez = this.pz[j] - this.pz[i];
            const d2 = ex * ex + ez * ez;
            if (d2 < nd2) { nd2 = d2; nearest = j; }
          }
        }
      }

      // soldiers on a ladder / wall-top are handled by climbStep (unless routing,
      // in which case they bail off the wall and flee)
      if (!deploy && this.climbState[i] > 0 && !u.routing) { this.climbStep(i, u, t, dt, nearest); continue; }

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
        if (seg < 0 || CASTLE[seg].dead) { seg = this.nearestWall(this.px[i], this.pz[i], RANGE[t]); if (u.siegeTargetSeg >= 0 && CASTLE[u.siegeTargetSeg].dead) u.siegeTargetSeg = -1; }
        else if (((CASTLE[seg].x0 + CASTLE[seg].x1) / 2 - this.px[i]) ** 2 + ((CASTLE[seg].z0 + CASTLE[seg].z1) / 2 - this.pz[i]) ** 2 > RANGE[t] * RANGE[t]) seg = -1;
        if (seg >= 0 && this.cd[i] <= 0 && this.ammo[i] > 0 && !u.holdFire) { this.lobBoulder(i, seg); this.cd[i] = ATKCD[t]; this.ammo[i]--; }
        if (!u.hold) { this.formMove(u, i); dx = this._dir[0]; dz = this._dir[1]; }
      } else {
        const dist = nearest >= 0 ? Math.sqrt(nd2) : Infinity;
        if (t === UType.Archer && this.ammo[i] > 0) {
          // active archer: volley enemies in range (within the focus area if set)
          if (nearest >= 0 && dist <= RANGE[t] && !u.holdFire && this.focusOk(u, nearest)) {
            if (this.cd[i] <= 0) { this.shoot(i, nearest); this.cd[i] = ATKCD[t]; this.ammo[i]--; }
          } else if (!u.hold) { this.formMove(u, i); dx = this._dir[0]; dz = this._dir[1]; if (this._stuck) { this.scaleWall(i); dx = this._dir[0]; dz = this._dir[1]; } }
        } else {
          // melee — including archers who've spent all their arrows
          // Defender reserves rush to MOUNT a wall the enemy is scaling.
          if (u.hold && u.faction === Faction.Defender && t === UType.Light && nearest >= 0 && this.py[nearest] > 2 && dist < 16) {
            const seg = this.nearestClimbWall(this.px[i], this.pz[i]); if (seg >= 0) { this.startClimb(i, seg); continue; }
          }
          const mrng = t === UType.Archer ? RANGE[UType.Light] : RANGE[t];
          const mdmg = t === UType.Archer ? MELEE[UType.Light] : MELEE[t];
          if (nearest >= 0 && dist <= mrng) {
            if (this.cd[i] <= 0) { this.hp[nearest] -= mdmg; this.cd[i] = ATKCD[t]; if (this.hp[nearest] <= 0) this.kill(nearest, this.units[this.unit[nearest]]); }
          } else if (nearest >= 0 && dist < ENGAGE && !u.hold && !pathBlocked(this.px[i], this.pz[i], this.px[nearest], this.pz[nearest])) {
            // chase only a *reachable* enemy — never walk into a wall after one
            const ex = this.px[nearest] - this.px[i], ez = this.pz[nearest] - this.pz[i]; const l = dist || 1; dx = ex / l; dz = ez / l;
          } else if (!u.hold) {
            this.formMove(u, i); dx = this._dir[0]; dz = this._dir[1];
            // no breach to filter through → march to the wall in front and scale it
            if (this._stuck && t !== UType.Cavalry) { this.scaleWall(i); dx = this._dir[0]; dz = this._dir[1]; }
          } else if (u.hold && nearest >= 0 && dist < 24 && !pathBlocked(this.px[i], this.pz[i], this.px[nearest], this.pz[nearest])) {
            // garrison surges off its hold to engage enemies that get inside the walls
            const ex = this.px[nearest] - this.px[i], ez = this.pz[nearest] - this.pz[i]; const l = dist || 1; dx = ex / l; dz = ez / l;
          }
        }
      }

      // ---- separation from same-faction neighbours ----
      let sx = 0, sz = 0;
      for (let rr = hr - 1; rr <= hr + 1; rr++) for (let cc = hc - 1; cc <= hc + 1; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const b = this.buckets[rr * this.hCols + cc];
        for (let bi = 0; bi < b.length; bi++) {
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
          const ang = a * (Math.PI / 4), spx = this.px[i] + Math.cos(ang) * OR, spz = this.pz[i] + Math.sin(ang) * OR;
          if (spx < WORLD.minX || spx > WORLD.maxX || spz < WORLD.minZ || spz > WORLD.maxZ || BLOCKED[cellOf(spx, spz)]) { ox -= Math.cos(ang); oz -= Math.sin(ang); }
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

    if (!deploy) { this.stepProjectiles(dt); this.checkVictory(); }
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
  private startClimb(i: number, seg: number) { this.climbState[i] = 1; this.climbSeg[i] = seg; }

  // Walled off from the goal: head to the nearest wall section and start scaling
  // it. Writes the approach direction to _dir (0,0 once the ladder is mounted).
  private scaleWall(i: number) {
    const seg = this.nearestClimbWall(this.px[i], this.pz[i]);
    if (seg < 0) { this._dir[0] = 0; this._dir[1] = 0; return; }
    const g = CASTLE[seg];
    const cpx = Math.max(g.x0, Math.min(g.x1, this.px[i])), cpz = Math.max(g.z0, Math.min(g.z1, this.pz[i]));
    const ddx = cpx - this.px[i], ddz = cpz - this.pz[i], l = Math.hypot(ddx, ddz) || 1;
    if (l <= this.CLIMB) { this.startClimb(i, seg); this._dir[0] = 0; this._dir[1] = 0; }
    else { this._dir[0] = ddx / l; this._dir[1] = ddz / l; }
  }

  // Fully controls a climbing soldier for the tick (sets px/pz/py). Each soldier
  // climbs at its OWN position along the wall (so they spread out, not jam) and
  // pushes across the walkway while fighting, then drops inside.
  private climbStep(i: number, u: Unit, t: UType, dt: number, nearest: number) {
    const seg = CASTLE[this.climbSeg[i]];
    if (!seg || seg.dead) { this.climbState[i] = 0; this.py[i] = 0; return; } // wall fell → it's a breach now
    const horiz = (seg.x1 - seg.x0) >= (seg.z1 - seg.z0);
    const wallPerp = horiz ? (seg.z0 + seg.z1) / 2 : (seg.x0 + seg.x1) / 2;
    const aMin = (horiz ? seg.x0 : seg.z0) + 0.5, aMax = (horiz ? seg.x1 : seg.z1) - 0.5;
    const along = Math.max(aMin, Math.min(aMax, horiz ? this.px[i] : this.pz[i]));
    const sgn = wallPerp >= 0 ? 1 : -1;
    const innerPerp = wallPerp - sgn * (T + 3.5);
    const at = (alongV: number, perpV: number, sp: number) => {
      const tx = horiz ? alongV : perpV, tz = horiz ? perpV : alongV;
      const dx = tx - this.px[i], dz = tz - this.pz[i], l = Math.hypot(dx, dz);
      if (l > 0.05) { const s = Math.min(l, sp * dt); this.px[i] += dx / l * s; this.pz[i] += dz / l * s; }
      return l;
    };
    // strike a same-level enemy if adjacent (the wall-top melee)
    if (nearest >= 0 && Math.abs(this.py[nearest] - this.py[i]) < 2.5) {
      const dd = Math.hypot(this.px[nearest] - this.px[i], this.pz[nearest] - this.pz[i]);
      if (dd < 2.2 && this.cd[i] <= 0) { const dmg = (MELEE[t] || 7) * 1.4; this.hp[nearest] -= dmg; this.cd[i] = ATKCD[t]; if (this.hp[nearest] <= 0) this.kill(nearest, this.units[this.unit[nearest]]); }
    }
    const st = this.climbState[i];
    if (st === 1) {                       // up the outer face onto the walkway
      const l = at(along, wallPerp, 3.0); this.py[i] = Math.min(WH, this.py[i] + 4 * dt);
      if (l < 1.0 && this.py[i] >= WH - 0.1) this.climbState[i] = u.faction === Faction.Attacker ? 2 : 4;
    } else if (st === 2) {                // attacker: push across the walkway (fighting), then drop in
      const l = at(along, innerPerp, 1.6);
      if (l < 1.2) this.climbState[i] = 3;
    } else if (st === 3) {                // descend into the courtyard
      const l = at(along, innerPerp, 3.0); this.py[i] = Math.max(0, this.py[i] - 4 * dt);
      if (this.py[i] <= 0.05 && l < 1.2) { this.climbState[i] = 0; this.py[i] = 0; }
    } else {                              // st 4: defender holds the wall-top
      at(along, wallPerp, 1.5);
    }
  }

  private shoot(i: number, target: number) {
    const p = this.getProj();
    const fire = this.units[this.unit[i]].fireArrows;
    const sx = this.px[i], sz = this.pz[i], sy = this.py[i] + 1.6;
    const tx = this.px[target], tz = this.pz[target];
    const d = Math.hypot(tx - sx, tz - sz) || 1;
    const tof = Math.max(0.75, d / ARCHER_PROJ_SPEED); // min loft so even close shots arc
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.fac = this.fac[i] as Faction;
    p.dmg = fire ? ARCHER_PROJ_DMG * 1.7 : ARCHER_PROJ_DMG; p.wall = -1; p.big = false; p.fire = fire;
    p.vx = (tx - sx) / tof; p.vz = (tz - sz) / tof; p.vy = (0 - sy) / tof + 0.5 * PROJ_G * tof; // ballistic arc
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
    p.dmg = BOULDER_DMG; p.wall = segIdx; p.big = true; p.fire = false;
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
    const p: Projectile = { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, tz: 0, dmg: 0, fac: 0, wall: -1, big: false, fire: false };
    this.projectiles.push(p); return p;
  }
  private stepProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.vy -= PROJ_G * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const dxz = Math.hypot(p.x - p.tx, p.z - p.tz);
      if (p.y <= 0 || dxz < 1.4) {
        if (p.wall >= 0) {
          // boulder: damage the wall section; crumble it into a breach at 0 hp
          const seg = CASTLE[p.wall];
          if (!seg.dead) { seg.hp -= p.dmg; if (seg.hp <= 0) this.breach(p.wall); }
        } else {
          // arrow: damage nearest enemy soldier to the impact point
          let best = -1, bd2 = 6.25;
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
    let attActive = 0, defActive = 0;
    for (const u of this.units) { if (u.routing) continue; if (u.faction === Faction.Attacker) attActive += u.alive; else defActive += u.alive; }
    if (defActive === 0) { this.phase = 'over'; this.winner = Faction.Attacker; }
    else if (attActive === 0) { this.phase = 'over'; this.winner = Faction.Defender; }
  }

  // aggregate counts for HUD
  countAlive(faction: Faction): number { let n = 0; for (const u of this.units) if (u.faction === faction) n += u.alive; return n; }
  playerUnits(): Unit[] { return this.units.filter(u => u.faction === Faction.Attacker); }
}
