// Castle Hassle — battle simulation.
// Data-oriented: all soldiers live in flat typed arrays (Struct-of-Arrays) so
// we can push ~2000 agents with no per-entity GC churn. Movement uses a shared
// flow field per destination (no per-agent A*). Fixed-timestep & seeded so it's
// deterministic (replays / future PvP come cheap).

export const WORLD = { minX: -100, maxX: 100, minZ: -90, maxZ: 90 };
export const CELL = 2;
export const COLS = Math.round((WORLD.maxX - WORLD.minX) / CELL); // 100
export const ROWS = Math.round((WORLD.maxZ - WORLD.minZ) / CELL); // 90
export const NCELLS = COLS * ROWS;

export const enum Faction { Attacker = 0, Defender = 1 }
export const enum UType { Heavy = 0, Light = 1, Archer = 2, Cavalry = 3 }

export const TYPE_NAME = ['Heavy Inf', 'Light Inf', 'Archers', 'Cavalry'];

// Per-type stats, indexed by UType.
const HP = [120, 70, 55, 95];
const SPEED = [7, 11, 8, 17];
const MELEE = [9, 7, 5, 15];
const ATKCD = [0.8, 0.55, 1.3, 0.75];
const RANGE = [1.8, 1.7, 40, 2.0];
const SENSE = [16, 16, 46, 20];
const RADIUS = [0.7, 0.6, 0.6, 0.95];
const ARCHER_PROJ_DMG = 12;
const ARCHER_PROJ_SPEED = 55;
const ROUT_FRAC = 0.3;

export function maxHp(t: UType) { return HP[t]; }

// ---- Castle layout (shared with renderer so geometry matches collision) ----
export interface Box { x0: number; x1: number; z0: number; z1: number; h: number; kind: 'wall' | 'tower' | 'keep'; }
const HALF = 26, T = 3, GATE = 11;
export const CASTLE: Box[] = [
  // North wall (far side, solid)
  { x0: -HALF, x1: HALF, z0: -HALF, z1: -HALF + T, h: 6, kind: 'wall' },
  // South wall (near attackers): a central gate gap (|x|<GATE) plus a battered
  // BREACH gap on the right (x 14..22) — two wide ways in, so the host floods.
  { x0: -HALF, x1: -GATE, z0: HALF - T, z1: HALF, h: 6, kind: 'wall' },
  { x0: GATE, x1: 14, z0: HALF - T, z1: HALF, h: 6, kind: 'wall' },
  { x0: 22, x1: HALF, z0: HALF - T, z1: HALF, h: 6, kind: 'wall' },
  // rubble stubs marking the breach (short, broken wall — low)
  { x0: 14, x1: 15.2, z0: HALF - T, z1: HALF, h: 2.2, kind: 'wall' },
  { x0: 20.8, x1: 22, z0: HALF - T, z1: HALF, h: 1.6, kind: 'wall' },
  // West & East walls
  { x0: -HALF, x1: -HALF + T, z0: -HALF, z1: HALF, h: 6, kind: 'wall' },
  { x0: HALF - T, x1: HALF, z0: -HALF, z1: HALF, h: 6, kind: 'wall' },
  // Corner towers
  { x0: -HALF - 1, x1: -HALF + 5, z0: -HALF - 1, z1: -HALF + 5, h: 10, kind: 'tower' },
  { x0: HALF - 5, x1: HALF + 1, z0: -HALF - 1, z1: -HALF + 5, h: 10, kind: 'tower' },
  { x0: -HALF - 1, x1: -HALF + 5, z0: HALF - 5, z1: HALF + 1, h: 10, kind: 'tower' },
  { x0: HALF - 5, x1: HALF + 1, z0: HALF - 5, z1: HALF + 1, h: 10, kind: 'tower' },
  // Keep
  { x0: -9, x1: 9, z0: -9, z1: 9, h: 13, kind: 'keep' },
];

function blockedAt(x: number, z: number): boolean {
  for (let i = 0; i < CASTLE.length; i++) {
    const b = CASTLE[i];
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
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

// Precompute which cells are blocked.
const BLOCKED = new Uint8Array(NCELLS);
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const [x, z] = cellCenter(r * COLS + c);
  BLOCKED[r * COLS + c] = blockedAt(x, z) ? 1 : 0;
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
  guardX: number; guardZ: number;
  goal: number;          // goal cell, or -1
  cx: number; cz: number; // centroid
  name: string;
}

export interface Projectile { active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; tx: number; tz: number; dmg: number; fac: Faction; }

export class Sim {
  MAX = 2200;
  px = new Float32Array(this.MAX); pz = new Float32Array(this.MAX); py = new Float32Array(this.MAX);
  vx = new Float32Array(this.MAX); vz = new Float32Array(this.MAX);
  hp = new Float32Array(this.MAX); cd = new Float32Array(this.MAX);
  unit = new Int16Array(this.MAX); fac = new Uint8Array(this.MAX); typ = new Uint8Array(this.MAX);
  alive = new Uint8Array(this.MAX); slot = new Int32Array(this.MAX);
  n = 0;
  units: Unit[] = [];
  typeCount = [0, 0, 0, 0];
  fields = new Map<number, Float32Array>();
  projectiles: Projectile[] = [];
  phase: 'deploy' | 'battle' | 'over' = 'deploy';
  winner: Faction | null = null;
  private seed: number;
  attackerAliveStart = 0; defenderAliveStart = 0;

  constructor(seed = 1234) { this.seed = seed >>> 0; this.setup(); }

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
    const s0 = this.n;
    for (let i = 0; i < count; i++) {
      const id = this.n++;
      const [x, z, y] = place(i);
      this.px[id] = x; this.pz[id] = z; this.py[id] = y;
      this.hp[id] = HP[type]; this.cd[id] = this.rnd() * 0.5;
      this.unit[id] = this.units.length; this.fac[id] = faction; this.typ[id] = type;
      this.alive[id] = 1; this.slot[id] = this.typeCount[type]++;
    }
    const u: Unit = {
      id: this.units.length, faction, type, s0, count, alive: count,
      morale: 100, routing: false, hold: !!opts.hold,
      guardX: opts.guardX ?? 0, guardZ: opts.guardZ ?? 0, goal: opts.goal ?? -1,
      cx: 0, cz: 0, name: opts.name ?? TYPE_NAME[type],
    };
    this.units.push(u);
    return u;
  }

  private setup() {
    const R = (a: number, b: number) => a + this.rnd() * (b - a);
    // grid block placement helper
    const block = (cx: number, cz: number, cols: number, gap: number) => (i: number): [number, number, number] => {
      const c = i % cols, r = Math.floor(i / cols);
      return [cx + (c - cols / 2) * gap + R(-0.4, 0.4), cz + r * gap + R(-0.4, 0.4), 0];
    };

    // ---------------- ATTACKERS (south, player) ----------------
    // Default orders split the host between the gate (centre) and the breach
    // (right) so both entries are used; the player can redirect any unit.
    this.addUnit(Faction.Attacker, UType.Heavy, 300, block(-34, 62, 30, 1.3), { name: 'Vanguard', goal: cellOf(0, 14) });
    this.addUnit(Faction.Attacker, UType.Heavy, 300, block(34, 62, 30, 1.3), { name: 'Ironsides', goal: cellOf(17, 13) });
    this.addUnit(Faction.Attacker, UType.Light, 320, block(0, 70, 36, 1.2), { name: 'Skirmishers', goal: cellOf(0, 14) });
    this.addUnit(Faction.Attacker, UType.Archer, 260, block(0, 80, 40, 1.3), { name: 'Longbows', goal: cellOf(0, 32) });
    this.addUnit(Faction.Attacker, UType.Cavalry, 160, block(-62, 64, 20, 1.8), { name: 'Lancers', goal: cellOf(17, 13) });

    // ---------------- DEFENDERS (the castle, AI) ----------------
    // Archers along the south wall tops (either side of the gate) + side walls.
    this.addUnit(Faction.Defender, UType.Archer, 80, (i) => {
      const left = i < 40; const k = left ? i : i - 40;
      const x = left ? -24 + (k % 8) * 2.0 : 9 + (k % 8) * 2.0;
      const z = 23.0 + Math.floor(k / 8) * 1.2;
      return [x, z, 6];
    }, { hold: true, name: 'Wall Archers' });
    this.addUnit(Faction.Defender, UType.Archer, 50, (i) => {
      const east = i < 25; const k = east ? i : i - 25;
      const z = -20 + (k % 5) * 8;
      const x = east ? 24.0 + Math.floor(k / 5) * 1.2 : -25.2 - Math.floor(k / 5) * 1.2;
      return [x, z, 6];
    }, { hold: true, name: 'Flank Archers' });
    // Garrison melee HOLD the south courtyard, right where the flood enters
    // (between the keep and the gate) so attackers meet them head-on and their
    // numbers tell — no safe corner to hide in.
    // A large garrison packed across the whole courtyard (scattered, holding
    // position). The assault must fight through the entire yard to take it.
    const yard = (): [number, number, number] => { let x = 0, z = 0; do { x = R(-23, 23); z = R(-21, 21); } while (blockedAt(x, z)); return [x, z, 0]; };
    this.addUnit(Faction.Defender, UType.Heavy, 450, yard, { hold: true, name: 'Garrison' });
    this.addUnit(Faction.Defender, UType.Light, 300, yard, { hold: true, name: 'Reserves' });

    for (const u of this.units) {
      if (u.faction === Faction.Attacker) this.attackerAliveStart += u.count;
      else this.defenderAliveStart += u.count;
    }
    // prime the fields the AI/initial orders use
    this.field(cellOf(0, 14)); this.field(cellOf(17, 13)); this.field(cellOf(0, 32));
  }

  issueMove(unitId: number, x: number, z: number) {
    const u = this.units[unitId];
    if (!u || u.faction !== Faction.Attacker || u.routing) return;
    let cx = Math.max(WORLD.minX + 1, Math.min(WORLD.maxX - 1, x));
    let cz = Math.max(WORLD.minZ + 1, Math.min(WORLD.maxZ - 1, z));
    let cell = cellOf(cx, cz);
    if (BLOCKED[cell]) cell = cellOf(cx, cz + 4); // nudge off walls
    u.goal = cell; u.hold = false;
    this.field(cell);
  }

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
    if (this.phase !== 'battle') return;
    this.rebuildHash();

    // morale / routing per unit + centroids
    for (const u of this.units) {
      let ax = 0, az = 0, a = 0;
      for (let i = u.s0; i < u.s0 + u.count; i++) if (this.alive[i]) { ax += this.px[i]; az += this.pz[i]; a++; }
      u.alive = a;
      if (a > 0) { u.cx = ax / a; u.cz = az / a; }
      if (!u.routing && a > 0 && a / u.count < ROUT_FRAC) u.routing = true;
    }
    // Once the courtyard garrison (all defender melee) is broken, the walls are
    // overrun — the wall archers' morale collapses and they abandon their posts.
    let defMelee = 0;
    for (const u of this.units) if (u.faction === Faction.Defender && (u.type === UType.Heavy || u.type === UType.Light)) defMelee += u.alive;
    if (defMelee < 25) for (const u of this.units) if (u.faction === Faction.Defender) u.routing = true;

    const sense = (i: number) => SENSE[this.typ[i]];

    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const u = this.units[this.unit[i]];
      const t = this.typ[i] as UType;
      const spd = SPEED[t];
      let dx = 0, dz = 0;       // desired direction
      this.cd[i] -= dt;

      // ---- find nearest enemy via hash ----
      // Vertical separation is weighted heavily (VK) so ground troops don't get
      // "stuck" trying to engage archers standing up on the walls — they ignore
      // them and keep pouring through the gate. Ranged units (big sense) can
      // still reach up for counter-battery fire.
      const VK = 3.2;
      let nearest = -1, nd2 = sense(i) * sense(i);
      const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((this.px[i] - WORLD.minX) / this.hCell)));
      const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((this.pz[i] - WORLD.minZ) / this.hCell)));
      for (let rr = hr - 1; rr <= hr + 1; rr++) for (let cc = hc - 1; cc <= hc + 1; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const b = this.buckets[rr * this.hCols + cc];
        for (let bi = 0; bi < b.length; bi++) {
          const j = b[bi];
          if (this.fac[j] === this.fac[i]) continue;
          const ex = this.px[j] - this.px[i], ez = this.pz[j] - this.pz[i], ey = (this.py[j] - this.py[i]) * VK;
          const d2 = ex * ex + ez * ez + ey * ey;
          if (d2 < nd2) { nd2 = d2; nearest = j; }
        }
      }

      if (u.routing) {
        // flee toward the nearest map edge (south for attackers, away otherwise)
        const fz = u.faction === Faction.Attacker ? 1 : -1;
        dx = (this.px[i] > 0 ? 0.4 : -0.4); dz = fz;
        if (this.px[i] < WORLD.minX + 3 || this.px[i] > WORLD.maxX - 3 ||
            this.pz[i] < WORLD.minZ + 3 || this.pz[i] > WORLD.maxZ - 3) { this.kill(i, u); continue; }
      } else {
        const dist = nearest >= 0 ? Math.sqrt(nd2) : Infinity;
        const rng = RANGE[t];
        if (nearest >= 0 && t === UType.Archer) {
          // archers: shoot if in range, else (defenders hold; attackers edge closer)
          if (dist <= rng && this.cd[i] <= 0) { this.shoot(i, nearest); this.cd[i] = ATKCD[t]; }
          if (!u.hold && dist > rng * 0.8) { const ex = this.px[nearest] - this.px[i], ez = this.pz[nearest] - this.pz[i]; const l = dist || 1; dx = ex / l; dz = ez / l; }
        } else if (nearest >= 0 && dist <= rng) {
          // melee: in range → strike, hold ground
          if (this.cd[i] <= 0) { this.hp[nearest] -= MELEE[t]; this.cd[i] = ATKCD[t]; if (this.hp[nearest] <= 0) this.kill(nearest, this.units[this.unit[nearest]]); }
        } else if (nearest >= 0 && !u.hold && dist < 12) {
          // melee: only *short-range* chase for final convergence. Beyond that
          // we trust the flow field (below) so troops route through the gate /
          // breach instead of mobbing the solid wall face.
          const ex = this.px[nearest] - this.px[i], ez = this.pz[nearest] - this.pz[i]; const l = dist || 1; dx = ex / l; dz = ez / l;
        } else if (!u.hold && u.goal >= 0) {
          // otherwise follow the flow field toward the unit's goal
          const f = this.field(u.goal); const ci = cellOf(this.px[i], this.pz[i]);
          dx = f[ci * 2]; dz = f[ci * 2 + 1];
        } else if (u.hold) {
          // garrison: hold position and fight whatever comes (no drift)
        }
      }

      // ---- separation from same-faction neighbours ----
      let sx = 0, sz = 0;
      for (let rr = hr - 1; rr <= hr + 1; rr++) for (let cc = hc - 1; cc <= hc + 1; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const b = this.buckets[rr * this.hCols + cc];
        for (let bi = 0; bi < b.length; bi++) {
          const j = b[bi]; if (j === i || this.fac[j] !== this.fac[i]) continue;
          const ex = this.px[i] - this.px[j], ez = this.pz[i] - this.pz[j];
          const d2 = ex * ex + ez * ez; const rad = RADIUS[t] * 2.2;
          if (d2 > 0.0001 && d2 < rad * rad) { const d = Math.sqrt(d2); sx += ex / d * (1 - d / rad); sz += ez / d * (1 - d / rad); }
        }
      }
      dx += sx * 0.55; dz += sz * 0.55;

      // integrate with wall collision
      const dl = Math.hypot(dx, dz);
      if (dl > 0.001) { dx /= dl; dz /= dl; }
      const step = spd * dt * (dl > 0.001 ? 1 : 0);
      let nx = this.px[i] + dx * step, nz = this.pz[i] + dz * step;
      if (this.py[i] < 1) { // ground units collide with walls; wall archers stay put
        if (blockedAt(nx, nz)) {
          if (!blockedAt(nx, this.pz[i])) nz = this.pz[i];
          else if (!blockedAt(this.px[i], nz)) nx = this.px[i];
          else { nx = this.px[i]; nz = this.pz[i]; }
        }
      }
      this.px[i] = Math.max(WORLD.minX, Math.min(WORLD.maxX, nx));
      this.pz[i] = Math.max(WORLD.minZ, Math.min(WORLD.maxZ, nz));
    }

    this.stepProjectiles(dt);
    this.checkVictory();
  }

  private kill(i: number, u: Unit) { this.alive[i] = 0; if (u) u.alive = Math.max(0, u.alive - 1); }

  private shoot(i: number, target: number) {
    const p = this.getProj();
    const sx = this.px[i], sz = this.pz[i], sy = this.py[i] + 1.6;
    const tx = this.px[target], tz = this.pz[target];
    const d = Math.hypot(tx - sx, tz - sz) || 1;
    const tof = d / ARCHER_PROJ_SPEED;
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.fac = this.fac[i] as Faction;
    p.dmg = ARCHER_PROJ_DMG;
    p.vx = (tx - sx) / tof; p.vz = (tz - sz) / tof; p.vy = (0 - sy) / tof + 0.5 * 18 * tof; // ballistic arc
  }
  private getProj(): Projectile {
    for (const p of this.projectiles) if (!p.active) return p;
    const p: Projectile = { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, tz: 0, dmg: 0, fac: 0 };
    this.projectiles.push(p); return p;
  }
  private stepProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.vy -= 18 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const dxz = Math.hypot(p.x - p.tx, p.z - p.tz);
      if (p.y <= 0 || dxz < 1.4) {
        // area hit: damage nearest enemy soldier to impact
        let best = -1, bd2 = 6.25;
        const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((p.tx - WORLD.minX) / this.hCell)));
        const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((p.tz - WORLD.minZ) / this.hCell)));
        for (let rr = hr - 1; rr <= hr + 1; rr++) for (let cc = hc - 1; cc <= hc + 1; cc++) {
          if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
          const b = this.buckets[rr * this.hCols + cc];
          for (const j of b) { if (this.fac[j] === p.fac) continue; const d2 = (this.px[j] - p.tx) ** 2 + (this.pz[j] - p.tz) ** 2; if (d2 < bd2) { bd2 = d2; best = j; } }
        }
        if (best >= 0) { this.hp[best] -= p.dmg; if (this.hp[best] <= 0) this.kill(best, this.units[this.unit[best]]); }
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
