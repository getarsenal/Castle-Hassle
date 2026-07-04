// Castle Hassle — battle simulation.
// Data-oriented: all soldiers live in flat typed arrays (Struct-of-Arrays) so
// we can push ~2000 agents with no per-entity GC churn. Movement uses a shared
// flow field per destination (no per-agent A*). Fixed-timestep & seeded so it's
// deterministic (replays / future PvP come cheap).

export const WORLD = { minX: -224, maxX: 224, minZ: -160, maxZ: 296 }; // a broad theatre: room to flank wide, camp deep, and assault from any quarter
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
// Persistent attacker buffs. The base fields are the classic global multipliers;
// the optional per-arm layers come from the branching War Council paths (each arm
// picks a doctrine — e.g. archers go Longbow (damage/range) or Shortbow (speed/volume)).
export interface AtkBuff {
  hp: number; melee: number; archer: number; fire: boolean; siege: number; reload: number;
  hpA?: number[];      // per-arm hp multiplier, indexed by UType
  dmgA?: number[];     // per-arm damage multiplier
  spdA?: number[];     // per-arm movement-speed multiplier
  cdA?: number[];      // per-arm attack-cooldown multiplier (lower = faster)
  rngA?: number[];     // per-arm range multiplier (archers/siege)
  ammoA?: number[];    // per-arm ammunition multiplier
  chargeMul?: number;  // cavalry: charge damage multiplier override
  chargeDur?: number;  // cavalry: extra seconds of charge
  chargeCd?: number;   // cavalry: charge cooldown multiplier
  lightFlank?: number; // light infantry: flank-specialist multiplier override
  braceMul?: number;   // heavy: braced counter multiplier override
  firepot?: boolean;   // trebuchets may load incendiary ammo
  burnMul?: number;    // incendiary: burn-patch life/size multiplier
  surgeons?: number;   // fraction of the fallen recovered after victory (campaign-side)
}
export const NO_BUFF: AtkBuff = { hp: 1, melee: 1, archer: 1, fire: false, siege: 1, reload: 1 };
export const COST = { heavy: 1.5, light: 1.0, archer: 1.3, cavalry: 2.0, siege: 70 };
export const BUDGET = 3200; // bigger castles + garrisons → a bigger assault army
export const DEFAULT_COMP: ArmyComp = { heavy: 600, light: 480, archer: 460, cavalry: 220, siege: 8 }; // ~3066 / 3200
export function compCost(c: ArmyComp): number { return c.heavy * COST.heavy + c.light * COST.light + c.archer * COST.archer + c.cavalry * COST.cavalry + c.siege * COST.siege; }
const AMMO = [0, 0, 16, 0, 16]; // arrows per archer / boulders per trebuchet

// COMBAT PACING: every man carries HP_SCALE× the hit points, and every RANGED
// source (arrows, bolts, anti-personnel boulders) hits HP_SCALE× harder — so the
// killing-ground/approach plays exactly as before, but MELEE damage is left alone,
// which means a hand-to-hand fight now takes ~HP_SCALE× longer. Ranks grind and
// push through each other instead of evaporating, so the storm inside the walls is
// a real, decision-driven melee rather than an instant wipe.
const HP_SCALE = 2.5;
// Per-type stats, indexed by UType. (index 4 = siege engine / trebuchet)
const HP = [120, 70, 55, 95, 260].map((h) => h * HP_SCALE);
const SPEED = [7, 11, 8, 17, 3.2];
const MELEE = [9, 7, 5, 15, 0];
const ATKCD = [0.8, 0.55, 1.3, 0.75, 6.5]; // trebuchets reload slowly
const RANGE = [1.8, 1.7, 40, 2.0, 110];   // siege = bombardment range
const SENSE = [16, 16, 46, 20, 110];
const SRAD = SENSE.map((s) => Math.max(1, Math.ceil(s / 6))); // hash search radius in buckets (hCell=6)
const RADIUS = [0.7, 0.6, 0.6, 0.95, 2.0];
const ARCHER_PROJ_DMG = 12 * HP_SCALE;   // scaled with HP so arrows stay as lethal as before
const ARCHER_PROJ_SPEED = 32;
const BOULDER_DMG = 200;       // damage a trebuchet boulder does to a wall section (walls are NOT scaled)
const BOULDER_SPEED = 30;
const BALLISTA_RANGE = 78;     // defensive ballista reach
const BALLISTA_DMG = 260 * HP_SCALE; // a bolt still kills any infantryman it strikes
const BALLISTA_CD = 3.4;       // reload time
const BOLT_SPEED = 52;
const ARTY_SPLASH = 2.6;       // anti-personnel blast radius (very little spill)
const PROJ_G = 28; // projectile gravity (higher = more pronounced arc)
const ROUT_FRAC = 0.25;     // hard floor: below this strength a company shatters regardless of morale
// ---- MORALE (the live model — replaces the old fixed 30% threshold) ----
// A company's nerve drains with casualties (rate matters more than total), with
// blows landing on its flank/rear, and with the sight of friends routing nearby;
// it steadies again when the pressure lifts. Shaken companies fight hesitantly;
// broken ones run — and can be RALLIED back if they aren't shattered.
const MOR_SHAKEN = 45;      // below this: shaken (weaker blows, wavering)
const MOR_BREAK = 16;       // below this: broken → rout
const MOR_RALLY = 34;       // a rally horn restores a broken company to this
const MOR_LOSS_K = 130;     // morale lost per (death/company-size) — ~55% casualties breaks a green company
const MOR_REAR_HIT = 0.35;  // extra morale per blow taken from flank/rear
const MOR_FEAR = 2.4;       // morale/s drained per nearby routing friendly company (cascades, but doesn't sweep)
const MOR_RECOVER = 3.2;    // morale/s regained when out of contact
// ---- COUNTERS & IMPACT ----
const FLANK_MULT = 1.3, REAR_MULT = 1.6;      // facing bonuses on melee damage
const HEAVY_VS_CAV = 1.35;                    // heavies set spears — bonus on horsemen
const BRACE_VS_CAV = 1.8;                     // braced (shield-stance) heavies punish a charge
const LIGHT_FLANK = 1.25;                     // light infantry are flank specialists
const CHARGE_KNOCK = 9;                       // knockback speed on a charge impact
const CHARGE_STUN = 0.7;                      // extra attack delay on a knocked man
// ---- BODY BLOCKING: enemies are solid — you fight THROUGH a line, never run
// through it. (Same-faction stays a soft shove so ranks can still flow.)
const ENEMY_BLOCK_R = 1.6, ENEMY_BLOCK_F = 2.4;
const WOUND_FRAC = 0.3, WOUND_MULT = 0.72;    // badly wounded men strike weaker blows
// ---- WEATHER & FOOTING ----
export type Weather = 'clear' | 'rain' | 'mist' | 'wind';
const MUD_RING = 12;        // churned ground hugging the walls (the siege has been here a while)
const MUD_SPEED = 0.8;      // speed multiplier in the churn
const RAIN_BOW = 0.85;      // wet strings loose weaker
const MIST_RANGE = 0.75;    // archers can't mark targets in the murk
const HIGH_GROUND = 1.15;   // plunging fire from the battlements bites harder
const CAPTURE_TIME = 11;   // seconds holding the keep to raise your banner
// A gate is forced by a single RAM, not by sheer numbers: once a crew (a handful
// of men) is on it, it takes a FIXED amount of damage per second regardless of how
// many troops pile on — so 250 men don't smash it in three seconds. Tuned so a
// gate falls in ~20s (palisade) to ~40s (stone), long enough that ramming under
// un-silenced wall-fire is costly. Stone WALLS can't be battered at all — engines
// or ladders only.
const RAM_DPS = 30;          // gate hit-points lost per second while a crew rams (stone gate ≈ 37s — the oil gets its say)
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
export interface Seg { x0: number; x1: number; z0: number; z1: number; h: number; kind: SegKind; hp: number; maxhp: number; dead: boolean; ramT?: number; ramCrew?: number; out?: number; ang?: number; olen?: number; } // ang/olen: an ORIENTED wall chunk — x0..z1 is just its bounding box
export interface WallLine { x0: number; z0: number; x1: number; z1: number; horiz: boolean; outer: number; gapC: number; gapH: number; nx?: number; nz?: number; } // nx/nz: outward normal of an ANGLED line (gapC then = distance along from x0,z0)
export interface Citadel { x0: number; x1: number; z0: number; z1: number; cx: number; cz: number; gate: { x: number; z: number }; wallLines: WallLine[]; }
// A scaling ladder raised against a wall section. Attackers queue at the foot
// and climb it single-file; `raise` animates it swinging up (0..1).
export interface Ladder { seg: number; along: number; bx: number; bz: number; horiz: boolean; outer: number; raise: number;  dead?: boolean; }
// A defensive ballista emplacement on a stretch of wall: it shoots bolts at the
// attackers and is knocked out when the wall section under it (`seg`) is destroyed.
export interface Ballista { x: number; z: number; y: number; seg: number; horiz: boolean; outer: number; }
export interface CastleLayout {
  W: number; D: number; front: number; gate: { x: number; z: number };
  wallLines: WallLine[]; towers: { x: number; z: number; big: boolean }[];
  buildings: { x: number; z: number; w: number; d: number }[]; citadel: Citadel | null;
  round: boolean; concentric: boolean; ballistae: Ballista[]; palisade: boolean;
  // the enceinte's cell blob: the exact irregular footprint (for inside tests)
  blob: { x0: number; z0: number; cs: number; gw: number; gh: number; cells: Uint8Array; area: number };
}
// exact point-in-enceinte test against the traced blob (bbox tests lie in the notches)
export function insideCastle(x: number, z: number): boolean {
  const b = LAYOUT?.blob; if (!b) return Math.abs(x) < (LAYOUT?.W ?? 0) && Math.abs(z) < (LAYOUT?.D ?? 0);
  const cx = Math.floor((x - b.x0) / b.cs), cz = Math.floor((z - b.z0) / b.cs);
  return cx >= 0 && cz >= 0 && cx < b.gw && cz < b.gh && !!b.cells[cz * b.gw + cx];
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
  form?: 'crag' | 'bastion' | 'sprawl' | 'shell'; // enceinte silhouette archetype (derived from seed when unset)
}

export const T = 4, WH = 9, SEG = 8;
export const TOWERS: { x: number; z: number; big: boolean }[] = [];
export let CASTLE: Seg[] = [];
export let LAYOUT: CastleLayout = null as any;

function genRng(seed: number) { let s = (seed >>> 0) || 1; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// hand-authored décor (trees/earthworks) — set by generateCastleFromDoc, cleared by generateCastle
export let DOC_DECO: { trees: [number, number][]; works: [number, number][] | null } | null = null;
let lastGen: { seed: number; style?: CastleStyle } | null = null;
export function generateCastle(seed: number, style?: CastleStyle) {
  lastGen = { seed, style };
  DOC_DECO = null;
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

  // ===== THE ENCEINTE: an irregular rectilinear ring traced from a seeded cell
  // blob — every castle is a different SHAPE (stepped crag wards, jutting corner
  // bastions, sprawling walled towns, rounded shells), not a resized rectangle.
  // Rectilinear runs keep every downstream contract intact: each run is a
  // WallLine an archer can man, a ballista can sit on, a ladder can hook. =====
  const CS = 12; // blob cell size (world units)
  const form: NonNullable<CastleStyle['form']> = st.form ?? (pal ? 'shell'
    : st.town > 0.68 ? 'sprawl'
    : st.concentric ? (R() < 0.5 ? 'crag' : 'shell')
    : st.strongKeep ? (R() < 0.55 ? 'bastion' : 'crag')
    : (['sprawl', 'bastion', 'shell', 'crag'] as const)[Math.floor(R() * 4)]);
  // cell budget from scale/aspect — typical holds ~13x10 cells (156x120 ground),
  // the great fortresses 17x13 (204x156) — three to five times the old ground
  const sizeMul = pal ? 0.62 : 1;
  const gw = Math.max(9, Math.min(18, Math.round((12.4 + rr(0, 2.6)) * st.scale * Math.sqrt(st.aspect) * sizeMul)));
  const gh = Math.max(7, Math.min(13, Math.round((9.4 + rr(0, 2)) * st.scale / Math.sqrt(st.aspect) * sizeMul)));
  const cells = new Uint8Array(gw * gh);
  const at = (x: number, z: number) => (x >= 0 && z >= 0 && x < gw && z < gh ? cells[z * gw + x] : 0);
  const put = (x: number, z: number, v = 1) => { if (x >= 0 && z >= 0 && x < gw && z < gh) cells[z * gw + x] = v; };
  const rect = (x0: number, z0: number, x1: number, z1: number) => { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(x, z); };
  if (form === 'shell') {
    // a lobed shell — a rounded ring-work whose radius swells and pinches as it
    // goes round (Harlech's rock, Restormel's shell keep, motte ring-works)
    const a = (gw - 1) / 2, b = (gh - 1) / 2;
    const p1 = R() * 6.28, p2 = R() * 6.28, l2 = rr(0.1, 0.22), l3 = rr(0.06, 0.16);
    for (let z = 0; z < gh; z++) for (let x = 0; x < gw; x++) {
      const dx = (x - a) / Math.max(1, a), dz = (z - b) / Math.max(1, b);
      const ang = Math.atan2(dz, dx);
      const rad = 1 + l2 * Math.sin(2 * ang + p1) + l3 * Math.sin(3 * ang + p2);
      if (Math.pow(Math.abs(dx), 1.45) + Math.pow(Math.abs(dz), 1.45) <= rad) put(x, z);
    }
  } else if (form === 'crag') {
    // stepped diagonal wards climbing a ridge line (Edinburgh, Château Gaillard):
    // three offset blocks whose union reads as a castle following its crag
    const w1 = Math.max(4, Math.round(gw * 0.55)), h1 = Math.max(3, Math.round(gh * 0.6));
    const flip = R() < 0.5 ? 1 : -1; // ridge may run either diagonal
    const fx = (x: number) => (flip > 0 ? x : gw - 1 - x);
    for (let z = gh - h1; z <= gh - 1; z++) for (let x = 0; x <= w1 - 1; x++) put(fx(x), z);
    const m0 = Math.round(gw * 0.3);
    for (let z = Math.max(0, gh - h1 - Math.round(gh * 0.35)); z <= gh - Math.max(1, Math.round(h1 * 0.45)); z++)
      for (let x = m0; x <= Math.min(gw - 1, m0 + Math.round(gw * 0.5)); x++) put(fx(x), z);
    for (let z = 0; z <= Math.round(gh * 0.55); z++) for (let x = gw - Math.max(3, Math.round(gw * 0.42)); x <= gw - 1; x++) put(fx(x), z);
  } else if (form === 'bastion') {
    // a quadrangular curtain with corner works THRUST OUT well past the walls
    // and a gatehouse block jutting south (Dover, Coucy, the Edwardian squares)
    rect(2, 2, gw - 3, gh - 3);
    rect(0, 0, 2, 2); rect(gw - 3, 0, gw - 1, 2); rect(0, gh - 3, 2, gh - 1); rect(gw - 3, gh - 3, gw - 1, gh - 1);
    const gxC = Math.round(gw / 2) + (R() < 0.5 ? -1 : 0);
    rect(Math.max(0, gxC - 1), gh - 3, Math.min(gw - 1, gxC + 1), gh - 1); // the gatehouse block
    if (gh > 8) rect(Math.round(gw * 0.38), 0, Math.round(gw * 0.58), 1);  // a north sally block
    if (R() < 0.5) rect(0, Math.round(gh * 0.4), 1, Math.round(gh * 0.62)); // a mid-flank bastion
  } else {
    // sprawl: a walled town GROWN ward by ward (Carcassonne, Conwy) — each new
    // ward is a rect that must overlap the town so far, and none is allowed to
    // fill the grid, so the union reads as an organic patchwork, not a slab
    const px0 = Math.floor(R() * gw * 0.35), pz0 = Math.floor(gh * 0.2 + R() * gh * 0.3);
    rect(px0, pz0, Math.min(gw - 1, px0 + Math.max(4, Math.round(gw * rr(0.45, 0.6)))), Math.min(gh - 1, pz0 + Math.max(3, Math.round(gh * rr(0.45, 0.6)))));
    // grow ward by ward, each ANCHORED on a cell the town already holds, until
    // the town holds enough ground — guaranteed mass, organic patchwork outline
    for (let wd = 0; wd < 9; wd++) {
      let filled = 0; for (let i = 0; i < cells.length; i++) filled += cells[i];
      if (filled >= gw * gh * 0.58) break;
      const anchors: number[] = [];
      for (let i = 0; i < cells.length; i++) if (cells[i]) anchors.push(i);
      const an = anchors[Math.floor(R() * anchors.length)];
      const ax = an % gw, az = (an / gw) | 0;
      const ww = Math.max(3, Math.round(gw * rr(0.3, 0.5))), wh2 = Math.max(2, Math.round(gh * rr(0.3, 0.5)));
      const x0 = Math.max(0, Math.min(gw - 1 - ww, ax - Math.floor(R() * ww)));
      const z0 = Math.max(0, Math.min(gh - 1 - wh2, az - Math.floor(R() * wh2)));
      rect(x0, z0, x0 + ww, z0 + wh2);
    }
  }
  // organic jitter: bud and nibble the outline so no two castles share a trace
  // (bastioned quadrangles jitter least — their geometry IS the point)
  const JN = Math.round(gw * gh * (form === 'bastion' ? 0.05 : 0.14));
  for (let j = 0; j < JN; j++) {
    const x = Math.floor(R() * gw), z = Math.floor(R() * gh);
    const nb = at(x - 1, z) + at(x + 1, z) + at(x, z - 1) + at(x, z + 1);
    const domino = R() < 0.35; const dx = R() < 0.5 ? 1 : 0, dz = 1 - dx; // sometimes bite two cells
    if (R() < 0.5) {
      if (!at(x, z) && nb >= 2) { put(x, z); if (domino && !at(x + dx, z + dz) && (at(x + dx - 1, z + dz) + at(x + dx + 1, z + dz) + at(x + dx, z + dz - 1) + at(x + dx, z + dz + 1)) >= 1) put(x + dx, z + dz); }
    } else if (at(x, z) && nb <= 2) { put(x, z, 0); if (domino) put(x + dx, z + dz, 0); }
  }
  { // sanitise: strip dangling single cells, fill enclosed holes, keep one castle
    for (let pass = 0; pass < 5; pass++) {
      let changed = false;
      for (let z = 0; z < gh; z++) for (let x = 0; x < gw; x++)
        if (at(x, z) && at(x - 1, z) + at(x + 1, z) + at(x, z - 1) + at(x, z + 1) <= 1) { put(x, z, 0); changed = true; }
      if (!changed) break;
    }
    const seen = new Uint8Array(gw * gh); const stack: number[] = [];
    for (let x = 0; x < gw; x++) { if (!at(x, 0)) stack.push(x); if (!at(x, gh - 1)) stack.push((gh - 1) * gw + x); }
    for (let z = 0; z < gh; z++) { if (!at(0, z)) stack.push(z * gw); if (!at(gw - 1, z)) stack.push(z * gw + gw - 1); }
    while (stack.length) { // flood the OUTSIDE; unfilled emptiness left over = holes
      const i = stack.pop()!; if (seen[i] || cells[i]) continue; seen[i] = 1;
      const x = i % gw, z = (i / gw) | 0;
      if (x > 0) stack.push(i - 1); if (x < gw - 1) stack.push(i + 1); if (z > 0) stack.push(i - gw); if (z < gh - 1) stack.push(i + gw);
    }
    for (let i = 0; i < cells.length; i++) if (!cells[i] && !seen[i]) cells[i] = 1;
    let root = -1; for (let i = 0; i < cells.length && root < 0; i++) if (cells[i]) root = i;
    if (root >= 0) { // keep only the component the root touches
      const comp = new Uint8Array(gw * gh); const st2 = [root];
      while (st2.length) {
        const i = st2.pop()!; if (comp[i] || !cells[i]) continue; comp[i] = 1;
        const x = i % gw, z = (i / gw) | 0;
        if (x > 0) st2.push(i - 1); if (x < gw - 1) st2.push(i + 1); if (z > 0) st2.push(i - gw); if (z < gh - 1) st2.push(i + gw);
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] && !comp[i]) cells[i] = 0;
    }
    let n = 0; for (let i = 0; i < cells.length; i++) n += cells[i];
    // a castle must HOLD GROUND: thin rolls dilate outward (keeping their
    // silhouette's character) until they carry enough ward to be a fortress
    let guardD = 0;
    while (n < gw * gh * 0.42 && guardD++ < 6) {
      const add: number[] = [];
      for (let z = 0; z < gh; z++) for (let x = 0; x < gw; x++) {
        if (at(x, z)) continue;
        if (at(x - 1, z) + at(x + 1, z) + at(x, z - 1) + at(x, z + 1) >= 2) add.push(z * gw + x);
      }
      if (!add.length) break;
      for (const i of add) { if (n < gw * gh * 0.5) { cells[i] = 1; n++; } }
    }
    if (n < 12) { cells.fill(0); rect(1, 1, gw - 2, gh - 2); } // degenerate roll — fall back to a plain ward
  }
  // recenter the blob so its bounding box sits on the origin
  let mnx = gw, mxx = -1, mnz = gh, mxz = -1, cellCount = 0;
  for (let z = 0; z < gh; z++) for (let x = 0; x < gw; x++) if (at(x, z)) { cellCount++; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (z < mnz) mnz = z; if (z > mxz) mxz = z; }
  const W = (mxx - mnx + 1) * CS / 2, D = (mxz - mnz + 1) * CS / 2;
  const wx0 = -W - mnx * CS, wz0 = -D - mnz * CS;   // world position of cell (0,0)'s corner
  const cX = (cx: number) => wx0 + cx * CS, cZ = (cz: number) => wz0 + cz * CS; // cell corner → world
  const blob = { x0: wx0, z0: wz0, cs: CS, gw, gh, cells, area: cellCount * CS * CS };
  const cellAtW = (x: number, z: number) => at(Math.floor((x - wx0) / CS), Math.floor((z - wz0) / CS));

  // ----- trace the boundary into merged wall RUNS (with their outward side) -----
  interface Run { horiz: boolean; a0: number; a1: number; c: number; outer: number }
  const runs: Run[] = [];
  { // horizontal runs: rows of cell edges grouped by (row, outward side), merged
    for (let z = 0; z <= gh; z++) for (const o of [1, -1] as const) {
      let x = 0;
      while (x < gw) {
        const edge = (xx: number) => (o > 0 ? at(xx, z - 1) && !at(xx, z) : at(xx, z) && !at(xx, z - 1));
        if (!edge(x)) { x++; continue; }
        let e = x; while (e < gw && edge(e)) e++;
        runs.push({ horiz: true, a0: cX(x), a1: cX(e), c: cZ(z), outer: o });
        x = e;
      }
    }
    for (let x = 0; x <= gw; x++) for (const o of [1, -1] as const) {
      let z = 0;
      while (z < gh) {
        const edge = (zz: number) => (o > 0 ? at(x - 1, zz) && !at(x, zz) : at(x, zz) && !at(x - 1, zz));
        if (!edge(z)) { z++; continue; }
        let e = z; while (e < gh && edge(e)) e++;
        runs.push({ horiz: false, a0: cZ(z), a1: cZ(e), c: cX(x), outer: o });
        z = e;
      }
    }
  }
  // ----- the GATE: the longest, most southern south-facing run near the centre.
  // On an irregular trace it often sits recessed in a bay — a natural killing
  // ground the attacker must enter before ramming (real gatehouses did exactly this).
  const GH_ = 9;
  let gateRun = runs[0]; let bestScore = -1e9;
  for (const r of runs) {
    if (!r.horiz || r.outer !== 1 || r.a1 - r.a0 < 24) continue;
    const mid = (r.a0 + r.a1) / 2;
    const sc = r.c * 2 - Math.abs(mid) * 0.7 + (r.a1 - r.a0) * 0.2;
    if (sc > bestScore) { bestScore = sc; gateRun = r; }
  }
  const gateX = Math.round(Math.max(gateRun.a0 + GH_ + 5, Math.min(gateRun.a1 - GH_ - 5, (gateRun.a0 + gateRun.a1) / 2 + rr(-8, 8))));
  const gateZ = gateRun.c;
  const outerWH = pal ? 5 : st.concentric ? WH - 2 : WH;
  // ----- raise the curtain along every run (SEG-chunked so breaches stay local) -----
  const wallLines: WallLine[] = [];
  for (const r of runs) {
    const isGate = r === gateRun;
    if (r.horiz) {
      const zlo = r.outer > 0 ? r.c - T : r.c, zhi = r.outer > 0 ? r.c : r.c + T;
      for (let x = r.a0; x < r.a1 - 0.1; x += SEG) {
        const e = Math.min(x + SEG, r.a1), cmid = (x + e) / 2;
        const w0 = segs.length;
        wall(x, e, zlo, zhi, isGate && Math.abs(cmid - gateX) < GH_ ? 'gate' : 'wall', outerWH);
        for (let q = w0; q < segs.length; q++) segs[q].out = r.outer;
      }
      wallLines.push({ x0: r.a0, z0: r.c - r.outer * T / 2, x1: r.a1, z1: r.c - r.outer * T / 2, horiz: true, outer: r.outer, gapC: isGate ? gateX : 1e9, gapH: isGate ? GH_ : 0 });
    } else {
      const xlo = r.outer > 0 ? r.c - T : r.c, xhi = r.outer > 0 ? r.c : r.c + T;
      for (let z = r.a0; z < r.a1 - 0.1; z += SEG) {
        const w0 = segs.length;
        wall(xlo, xhi, z, Math.min(z + SEG, r.a1), 'wall', outerWH);
        for (let q = w0; q < segs.length; q++) segs[q].out = r.outer;
      }
      wallLines.push({ x0: r.c - r.outer * T / 2, z0: r.a0, x1: r.c - r.outer * T / 2, z1: r.a1, horiz: false, outer: r.outer, gapC: 1e9, gapH: 0 });
    }
  }
  // ----- towers crown every salient: corners first, then mid-run flankers -----
  {
    const seenT = new Set<string>();
    const addT = (x: number, z: number, big: boolean) => {
      const k = `${Math.round(x / 4)},${Math.round(z / 4)}`;
      if (seenT.has(k)) return; seenT.add(k);
      tower(x, z, big);
    };
    addT(gateX - GH_ - 3, gateZ, true); addT(gateX + GH_ + 3, gateZ, true); // gatehouse drums
    // a corner earns a tower only when BOTH runs meeting there are substantial —
    // little jitter steps stay as bare wall articulation, real salients get drums
    const cornerLen = new Map<string, number>();
    const note = (x: number, z: number, len: number) => {
      const k = `${Math.round(x)},${Math.round(z)}`;
      cornerLen.set(k, Math.min(cornerLen.get(k) ?? 1e9, len));
    };
    for (const r of runs) {
      const len = r.a1 - r.a0;
      if (r.horiz) { note(r.a0, r.c, len); note(r.a1, r.c, len); } else { note(r.c, r.a0, len); note(r.c, r.a1, len); }
    }
    let ci = 0;
    for (const [k, minLen] of cornerLen) {
      if (minLen < CS - 0.1) continue; // a one-cell jog — no drum
      const [x, z] = k.split(',').map(Number);
      addT(x, z, !pal && (ci++ % 7 === 3)); if (TOWERS.length > 44) break;
    }
    for (const r of runs) { // long curtains get interval flanking towers
      if (TOWERS.length > 52) break;
      const len = r.a1 - r.a0; if (len < 46) continue;
      for (let a = r.a0 + 28; a < r.a1 - 20; a += 30) {
        if (r === gateRun && Math.abs(a - gateX) < GH_ + 8) continue;
        addT(r.horiz ? a : r.c, r.horiz ? r.c : a, false);
      }
    }
  }

  // ----- optional barbican thrust out before the gate (style-driven, as before) -----
  let front = D, outerGateX = gateX;
  if ((st.shape === 'barbican' || st.shape === 'twin') && gateZ > -D * 0.2) {
    const runLen = gateRun.a1 - gateRun.a0;
    const bhw = Math.min(runLen / 2 - 2, Math.round((st.shape === 'twin' ? rr(0.5, 0.66) : rr(0.32, 0.44)) * Math.max(runLen / 2, 30)));
    const bd = Math.round(st.shape === 'twin' ? rr(28, 40) : rr(20, 30));
    const bx0 = Math.max(gateRun.a0, gateX - bhw), bx1 = Math.min(gateRun.a1, gateX + bhw), bz1 = gateZ + bd;
    for (let x = bx0; x < bx1 - 0.1; x += SEG) {
      const e = Math.min(x + SEG, bx1), c = (x + e) / 2, w0 = segs.length;
      wall(x, e, bz1 - T, bz1, Math.abs(c - gateX) < GH_ ? 'gate' : 'wall');
      for (let q = w0; q < segs.length; q++) segs[q].out = 1;
    }
    for (let z = gateZ; z < bz1 - 0.1; z += SEG) {
      const e = Math.min(z + SEG, bz1), w0 = segs.length;
      wall(bx0, bx0 + T, z, e, 'wall'); wall(bx1 - T, bx1, z, e, 'wall');
      for (let q = w0; q < segs.length; q++) segs[q].out = segs[q].x0 < gateX ? -1 : 1;
    }
    wallLines.push({ x0: bx0, z0: bz1 - T / 2, x1: bx1, z1: bz1 - T / 2, horiz: true, outer: 1, gapC: gateX, gapH: GH_ });
    wallLines.push({ x0: bx0 + T / 2, z0: gateZ, x1: bx0 + T / 2, z1: bz1, horiz: false, outer: -1, gapC: 1e9, gapH: 0 });
    wallLines.push({ x0: bx1 - T / 2, z0: gateZ, x1: bx1 - T / 2, z1: bz1, horiz: false, outer: 1, gapC: 1e9, gapH: 0 });
    tower(bx0, bz1, false); tower(bx1, bz1, false); tower(gateX - GH_ - 3, bz1, true); tower(gateX + GH_ + 3, bz1, true);
    front = Math.max(front, bz1);
  }
  const GH = GH_; // (citadel + buildings below reuse the name)

  // ----- inner stronghold, seated in the blob's DEEPEST ward (not the origin —
  // on a crag trace the origin can be empty ground outside the walls) -----
  // cell depth = BFS steps from the boundary; the keep sits where the castle is thickest
  const depth = new Int16Array(gw * gh).fill(-1);
  { const q: number[] = [];
    for (let z = 0; z < gh; z++) for (let x = 0; x < gw; x++) {
      const i = z * gw + x; if (!cells[i]) continue;
      if (!at(x - 1, z) || !at(x + 1, z) || !at(x, z - 1) || !at(x, z + 1)) { depth[i] = 0; q.push(i); }
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h], x = i % gw, z = (i / gw) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, nz = z + dz; if (nx < 0 || nz < 0 || nx >= gw || nz >= gh) continue;
        const ni = nz * gw + nx; if (cells[ni] && depth[ni] < 0) { depth[ni] = depth[i] + 1; q.push(ni); }
      }
    }
  }
  let kcx = 0, kcz = 0, kbest = -1;
  for (let z = 0; z < gh; z++) for (let x = 0; x < gw; x++) {
    const dpt = depth[z * gw + x]; if (dpt < 0) continue;
    const sc = dpt * 10 - z * 0.6; // deep, and biased away from the gate front
    if (sc > kbest) { kbest = sc; kcx = x; kcz = z; }
  }
  const keepX = Math.round(cX(kcx) + CS / 2), keepZ = Math.round(cZ(kcz) + CS / 2);
  // shrink a candidate citadel rect until it fits wholly on filled cells
  const fits = (x0: number, z0: number, x1: number, z1: number) => {
    for (let x = x0; x <= x1; x += CS * 0.5) for (let z = z0; z <= z1; z += CS * 0.5) if (!cellAtW(x, z)) return false;
    return cellAtW(x1, z0) && cellAtW(x1, z1);
  };
  let citadel: Citadel | null = null;
  const cTowers: { x: number; z: number; big: boolean }[] = [];
  if (st.concentric) {
    // A full, taller inner ward — the attacker must breach two rings
    // (Krak des Chevaliers, Dover, Caerphilly, Harlech).
    let cw = Math.round(Math.min(W * 0.5, 44) / SEG) * SEG, cd = Math.round(Math.min(D * 0.5, 36) / SEG) * SEG;
    while ((cw > 16 || cd > 16) && !fits(keepX - cw - 2, keepZ - cd - 2, keepX + cw + 2, keepZ + cd + 2)) {
      if (cw >= cd) cw -= SEG; else cd -= SEG;
      cw = Math.max(16, cw); cd = Math.max(16, cd);
      if (cw === 16 && cd === 16) break;
    }
    const ccx = keepX, ccz = keepZ;
    const igX = Math.round(rr(-cw * 0.35, cw * 0.35) / SEG) * SEG; // inner gate offset (bent entry)
    const cLines = compound(ccx - cw, ccx + cw, ccz - cd, ccz + cd, ccx + igX, 6, true, cTowers, WH + 4);
    tower(ccx, ccz, true, cTowers); // corner drums on the inner ward
    segs.push({ x0: ccx - 8, x1: ccx + 8, z0: ccz - 7, z1: ccz + 7, h: 24, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
    citadel = { x0: ccx - cw, x1: ccx + cw, z0: ccz - cd, z1: ccz + cd, cx: ccx, cz: ccz, gate: { x: ccx + igX, z: ccz + cd }, wallLines: cLines };
  } else if (!pal && (st.strongKeep || blob.area > 14000 || R() < 0.45)) {
    // an offset inner bailey + keep
    const cw = 19, cd = 15, ccx = keepX, ccz = keepZ;
    const cLines = compound(ccx - cw, ccx + cw, ccz - cd, ccz + cd, ccx, 6, true, cTowers);
    segs.push({ x0: ccx - 7, x1: ccx + 7, z0: ccz - 6, z1: ccz + 6, h: st.strongKeep ? 24 : 21, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
    citadel = { x0: ccx - cw, x1: ccx + cw, z0: ccz - cd, z1: ccz + cd, cx: ccx, cz: ccz, gate: { x: ccx, z: ccz + cd }, wallLines: cLines };
  } else {
    // a lone keep dominating an open ward — a lord's manor in a palisade town
    const kh = pal ? 13 : 20, kr = pal ? 7 : 9;
    segs.push({ x0: keepX - kr, x1: keepX + kr, z0: keepZ - kr, z1: keepZ + kr, h: kh, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
  }

  // ----- town buildings fill the wards (never straying outside the trace) -----
  const keepProb = 1 - st.town; // chance a slot is left empty
  const buildings: { x: number; z: number; w: number; d: number }[] = [];
  for (let bx = -W + 10; bx < W - 10; bx += rr(13, 18)) {
    for (let bz = -D + 10; bz < D - 10; bz += rr(12, 17)) {
      if (R() < keepProb) continue;
      const bw = rr(3.5, 6.5), bd = rr(3.5, 5.5), x = bx + rr(0, 4), z = bz + rr(0, 4);
      if (Math.abs(x - gateX) < 9 && z > keepZ + 12) continue;                // keep the gate avenue clear
      if (citadel && x > citadel.x0 - 7 && x < citadel.x1 + 7 && z > citadel.z0 - 7 && z < citadel.z1 + 7) continue;
      if (!citadel && (x - keepX) ** 2 + (z - keepZ) ** 2 < 18 * 18) continue; // open plaza around the lone keep
      // every corner must sit INSIDE the enceinte, a wall-thickness clear of the trace
      let ok = true;
      for (const [px, pz] of [[x - bw - T - 2, z - bd - T - 2], [x + bw + T + 2, z - bd - T - 2], [x - bw - T - 2, z + bd + T + 2], [x + bw + T + 2, z + bd + T + 2]] as const)
        if (!cellAtW(px, pz)) { ok = false; break; }
      if (!ok) continue;
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
    const outerCap = Math.round(rr(3, 5) + blob.area / 5200); // more on bigger castles
    placeBallistae(wallLines, 30, outerCap);
    if (citadel) placeBallistae(citadel.wallLines, 22, ballistae.length + 3);
  }

  LAYOUT = { W, D, front, gate: { x: outerGateX, z: front }, wallLines, towers: [...TOWERS], buildings, citadel, round: st.round, concentric: st.concentric, ballistae, palisade: pal, blob };
  rebuildBlocked();
}

// ===== HAND-AUTHORED CASTLES (the Castle Workshop) =====
// A CastleDoc is what the in-game editor saves: polyline curtains at ANY angle,
// plus towers/gate/keep/houses/trees/earthworks. generateCastleFromDoc converts
// one into the live seg/LAYOUT world: axis-near edges snap straight, diagonal
// edges become stepped rectilinear runs (real curtains stepped on slopes the
// same way) — so every siege mechanic runs unchanged. The doc keeps the true
// angles untouched for the coming angled-wall renderer.
export interface CastleDoc {
  v: 1; name: string;
  walls: { pts: [number, number][]; closed: boolean }[];
  gates: { x: number; z: number }[];               // attach to the nearest wall run
  towers: { x: number; z: number; big: boolean }[];
  keep: { x: number; z: number; w: number; d: number } | null;
  houses: { x: number; z: number; w: number; d: number }[];
  trees: [number, number][];
  works: [number, number][] | null;                 // custom earthworks ring (render)
}
export function generateCastleFromDoc(doc: CastleDoc) {
  lastGen = null; // doc battles aren't part of the seed-restore dance
  CASTLE = []; TOWERS.length = 0;
  const segs = CASTLE;
  const wall = (x0: number, x1: number, z0: number, z1: number, kind: SegKind = 'wall', h = WH, out = 1) => {
    if (x1 - x0 < 0.3 || z1 - z0 < 0.3) return;
    const hp = kind === 'gate' ? 1100 : kind === 'building' ? 1e9 : 1700;
    segs.push({ x0, x1, z0, z1, h: kind === 'gate' ? Math.max(5, h - 1) : h, kind, hp, maxhp: hp, dead: false, out });
  };
  // 1) recentre the doc so its wall bbox sits on the origin, gate side south (+z)
  let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
  for (const w of doc.walls) for (const [x, z] of w.pts) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mnz = Math.min(mnz, z); mxz = Math.max(mxz, z); }
  if (mxx <= mnx) { mnx = -40; mxx = 40; mnz = -30; mxz = 30; }
  const ox = -(mnx + mxx) / 2, oz = -(mnz + mxz) / 2;
  const W = Math.max(30, (mxx - mnx) / 2 + 2), D = Math.max(24, (mxz - mnz) / 2 + 2);
  const TX = (p: [number, number]): [number, number] => [p[0] + ox, p[1] + oz];
  // 2) walls: each polyline edge → axis runs (diagonals stair-step at ~SEG pitch)
  const wallLines: WallLine[] = [];
  interface RunOut { horiz: boolean; a0: number; a1: number; c: number }
  const centroidOf = (pts: [number, number][]) => {
    let cx = 0, cz = 0; for (const p of pts) { cx += p[0]; cz += p[1]; } return [cx / pts.length, cz / pts.length] as const;
  };
  const emitRun = (r: RunOut, outerSign: number, isGate: (a: number, c: number) => boolean, gateAt: number) => {
    if (r.a1 - r.a0 < 1) return;
    if (r.horiz) {
      const zlo = outerSign > 0 ? r.c - T : r.c, zhi = outerSign > 0 ? r.c : r.c + T;
      for (let x = r.a0; x < r.a1 - 0.1; x += SEG) {
        const e = Math.min(x + SEG, r.a1);
        wall(x, e, zlo, zhi, isGate((x + e) / 2, r.c) ? 'gate' : 'wall', WH, outerSign);
      }
      wallLines.push({ x0: r.a0, z0: r.c - outerSign * T / 2, x1: r.a1, z1: r.c - outerSign * T / 2, horiz: true, outer: outerSign, gapC: gateAt, gapH: gateAt < 1e8 ? 9 : 0 });
    } else {
      const xlo = outerSign > 0 ? r.c - T : r.c, xhi = outerSign > 0 ? r.c : r.c + T;
      for (let z = r.a0; z < r.a1 - 0.1; z += SEG) wall(xlo, xhi, z, Math.min(z + SEG, r.a1), 'wall', WH, outerSign);
      wallLines.push({ x0: r.c - outerSign * T / 2, z0: r.a0, x1: r.c - outerSign * T / 2, z1: r.a1, horiz: false, outer: outerSign, gapC: 1e9, gapH: 0 });
    }
  };
  const gates: [number, number][] = doc.gates.map(g => [g.x + ox, g.z + oz]); // gates are {x,z} objects — feeding them through the tuple TX made NaN and blanked the camera
  for (const wl of doc.walls) {
    if (wl.pts.length < 2) continue;
    const pts = wl.pts.map(TX);
    const [ccx, ccz] = centroidOf(pts);
    const edges = wl.closed ? pts.length : pts.length - 1;
    for (let e = 0; e < edges; e++) {
      const a = pts[e], b = pts[(e + 1) % pts.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
      if (len < 2) continue;
      // outward = away from the polyline's centroid, per edge
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      // does a gate marker sit on this edge?
      let gAt = 1e9;
      for (const g of gates) {
        const t = Math.max(0, Math.min(1, ((g[0] - a[0]) * dx + (g[1] - a[1]) * dz) / (len * len)));
        const px = a[0] + dx * t, pz = a[1] + dz * t;
        if (Math.hypot(g[0] - px, g[1] - pz) < 7) { gAt = t; break; }
      }
      // near-axis edges keep the exact axis path; everything else becomes TRUE
      // ANGLED wall chunks — straight stone between the points you drew.
      if (Math.abs(dx) < 1.5 || Math.abs(dz) < 1.5) {
        const horiz = Math.abs(dx) >= Math.abs(dz);
        const r: RunOut = horiz
          ? { horiz: true, a0: Math.min(a[0], b[0]), a1: Math.max(a[0], b[0]), c: (a[1] + b[1]) / 2 }
          : { horiz: false, a0: Math.min(a[1], b[1]), a1: Math.max(a[1], b[1]), c: (a[0] + b[0]) / 2 };
        const outer = r.horiz ? (r.c >= ccz ? 1 : -1) : (r.c >= ccx ? 1 : -1);
        const gateHere = gAt < 1e8 && r.horiz;
        const gateX = a[0] + dx * gAt;
        emitRun(r, outer, (cm) => gateHere && Math.abs(cm - gateX) < 9, gateHere ? gateX : 1e9);
      } else {
        const ang = Math.atan2(dz, dx), ux = dx / len, uz = dz / len;
        let nrmx = -uz, nrmz = ux;                          // left normal of the walk direction
        const midx2 = (a[0] + b[0]) / 2, midz2 = (a[1] + b[1]) / 2;
        let out = 1;                                        // local +z IS the left normal
        if (Math.hypot(midx2 + nrmx * 3 - ccx, midz2 + nrmz * 3 - ccz) < Math.hypot(midx2 - ccx, midz2 - ccz)) {
          nrmx = -nrmx; nrmz = -nrmz; out = -1;             // left points INTO the ward — outward is the right side
        }
        const gAlong = gAt < 1e8 ? gAt * len : 1e9;
        const n = Math.max(1, Math.round(len / SEG));
        for (let k = 0; k < n; k++) {
          const m0 = k * len / n, m1 = (k + 1) * len / n, mc = (m0 + m1) / 2, half = (m1 - m0) / 2;
          const cx2 = a[0] + ux * mc, cz2 = a[1] + uz * mc;
          const isG = gAlong < 1e8 && Math.abs(mc - gAlong) < 9;
          const exx = Math.abs(ux * half) + Math.abs(nrmx * T / 2), ezz = Math.abs(uz * half) + Math.abs(nrmz * T / 2);
          const kind: SegKind = isG ? 'gate' : 'wall';
          const hp = kind === 'gate' ? 1100 : 1700;
          segs.push({ x0: cx2 - exx, x1: cx2 + exx, z0: cz2 - ezz, z1: cz2 + ezz,
            h: kind === 'gate' ? WH - 1 : WH, kind, hp, maxhp: hp, dead: false, out, ang, olen: half });
        }
        wallLines.push({ x0: a[0], z0: a[1], x1: b[0], z1: b[1], horiz: Math.abs(dx) >= Math.abs(dz),
          outer: out, gapC: gAlong, gapH: gAlong < 1e8 ? 9 : 0, nx: nrmx, nz: nrmz });
      }
      void mx; void mz;
    }
  }
  // 3) towers / keep / houses
  for (const t of doc.towers) {
    const [x, z] = TX([t.x, t.z]); const r = t.big ? 5 : 4.2, hp = t.big ? 3200 : 2600;
    segs.push({ x0: x - r, x1: x + r, z0: z - r, z1: z + r, h: t.big ? WH + 6 : WH + 4, kind: 'tower', hp, maxhp: hp, dead: false });
    TOWERS.push({ x, z, big: t.big });
  }
  let keepC: [number, number] = [0, -D * 0.3];
  if (doc.keep) {
    const [x, z] = TX([doc.keep.x, doc.keep.z]); keepC = [x, z];
    segs.push({ x0: x - doc.keep.w / 2, x1: x + doc.keep.w / 2, z0: z - doc.keep.d / 2, z1: z + doc.keep.d / 2, h: 22, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
  } else {
    segs.push({ x0: keepC[0] - 8, x1: keepC[0] + 8, z0: keepC[1] - 7, z1: keepC[1] + 7, h: 20, kind: 'keep', hp: Infinity, maxhp: Infinity, dead: false });
  }
  const buildings: { x: number; z: number; w: number; d: number }[] = [];
  for (const h of doc.houses) {
    const [x, z] = TX([h.x, h.z]);
    wall(x - h.w / 2, x + h.w / 2, z - h.d / 2, z + h.d / 2, 'building', 6.5);
    buildings.push({ x, z, w: h.w / 2, d: h.d / 2 });
  }
  // 4) blob: rasterise the closed curtains for exact inside tests
  const CSd = 4, gw2 = Math.ceil(W * 2 / CSd) + 2, gh2 = Math.ceil(D * 2 / CSd) + 2;
  const bx0 = -W - CSd, bz0 = -D - CSd;
  const cells2 = new Uint8Array(gw2 * gh2);
  const polys = doc.walls.filter(w => w.closed && w.pts.length >= 3).map(w => w.pts.map(TX));
  let area2 = 0;
  for (let gz = 0; gz < gh2; gz++) for (let gx = 0; gx < gw2; gx++) {
    const x = bx0 + (gx + 0.5) * CSd, z = bz0 + (gz + 0.5) * CSd;
    let ins = false;
    for (const poly of polys) { // even-odd ray cast
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
      }
      if (hit) { ins = true; break; }
    }
    if (ins) { cells2[gz * gw2 + gx] = 1; area2 += CSd * CSd; }
  }
  let gate0 = gates[0] ?? [0, D];
  if (!Number.isFinite(gate0[0]) || !Number.isFinite(gate0[1])) gate0 = [0, D]; // belt & braces: a bad marker must never poison the camera
  DOC_DECO = { trees: doc.trees.map(TX), works: doc.works ? doc.works.map(TX) : null };
  LAYOUT = {
    W, D, front: D, gate: { x: gate0[0], z: D },
    wallLines, towers: [...TOWERS], buildings, citadel: null,
    round: false, concentric: false, ballistae: [], palisade: false,
    blob: { x0: bx0, z0: bz0, cs: CSd, gw: gw2, gh: gh2, cells: cells2, area: Math.max(area2, 3000) },
  };
  // wall ballistae along the authored curtains, same policy as generated castles
  const segAt2 = (x: number, z: number): number => {
    for (let i = 0; i < segs.length; i++) { const b = segs[i]; if ((b.kind === 'wall' || b.kind === 'gate') && x >= b.x0 - 0.6 && x <= b.x1 + 0.6 && z >= b.z0 - 0.6 && z <= b.z1 + 0.6) return i; }
    return -1;
  };
  const balls: Ballista[] = []; const cap = Math.round(3 + area2 / 5200);
  for (const ln of wallLines) {
    if (ln.nx !== undefined) continue; // angled curtains carry archers, not engines (v1)
    if (balls.length >= cap) break;
    const a0 = ln.horiz ? ln.x0 : ln.z0, a1 = ln.horiz ? ln.x1 : ln.z1;
    for (let a = a0 + 18; a < a1 - 12 && balls.length < cap; a += 30) {
      if (Math.abs(a - ln.gapC) < ln.gapH + 4) continue;
      const x = ln.horiz ? a : ln.x0, z = ln.horiz ? ln.z0 : a;
      const sg = segAt2(x, z); if (sg < 0) continue;
      const b = segs[sg]; if (ln.horiz) { b.x0 -= 1.6; b.x1 += 1.6; } else { b.z0 -= 1.6; b.z1 += 1.6; }
      balls.push({ x, z: z - ln.outer * 0.6, y: WH, seg: sg, horiz: ln.horiz, outer: ln.outer });
    }
  }
  LAYOUT.ballistae = balls;
  rebuildBlocked();
}

// ---- Defender order-of-battle: the SINGLE source of truth for who holds a castle.
// Both the live siege (Sim.setup) and the campaign-map survey draw from this, so the
// garrison on the info card is exactly the garrison you fight. ----
// archers lined along a set of wall-lines (two ranks, inset from corners & the gate)
function wallArcherPoints(lines: WallLine[], spacing: number, inset: number, wallTop: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (const ln of lines) {
    if (ln.nx !== undefined && ln.nz !== undefined) {
      // an ANGLED curtain: walk the true line, ranks stepped inward off the normal
      const dx = ln.x1 - ln.x0, dz = ln.z1 - ln.z0, L = Math.hypot(dx, dz);
      if (L < 2) continue;
      const ux = dx / L, uz = dz / L;
      for (let a = inset; a <= L - inset; a += spacing) {
        if (Math.abs(a - ln.gapC) < ln.gapH + 1) continue;
        for (let rk = 0; rk < 2; rk++) pts.push([ln.x0 + ux * a - ln.nx * rk * 1.3, ln.z0 + uz * a - ln.nz * rk * 1.3, wallTop]);
      }
      continue;
    }
    const a0 = (ln.horiz ? ln.x0 : ln.z0) + inset, a1 = (ln.horiz ? ln.x1 : ln.z1) - inset;
    for (let a = a0; a <= a1; a += spacing) {
      if (Math.abs(a - ln.gapC) < ln.gapH + 1) continue; // leave the gate clear
      for (let rk = 0; rk < 2; rk++) { const off = -ln.outer * rk * 1.3; pts.push(ln.horiz ? [a, ln.z0 + off, wallTop] : [ln.x0 + off, a, wallTop]); }
    }
  }
  return pts;
}
export interface DefenderPlan {
  wallArchers: [number, number, number][]; towerArchers: number;
  garrison: number; reserves: number; citGuard: number; citArchers: [number, number, number][];
  total: number;
}
export function defenderPlan(L: CastleLayout, difficulty: number): DefenderPlan {
  const pal = L.palisade;
  // ward area & curtain perimeter from the REAL trace — a sprawling irregular
  // enceinte is longer-walled than its bounding box suggests, so archer spacing
  // widens with perimeter to keep garrison totals in the same family as before
  const qArea = (L.blob ? L.blob.area : L.W * L.D * 4) / 4;
  let perim = 0; for (const ln of L.wallLines) perim += ln.horiz ? ln.x1 - ln.x0 : ln.z1 - ln.z0;
  const spacing = pal ? 16 : Math.max(2.6, Math.min(3.4, perim / 185));
  const wallArchers = wallArcherPoints(L.wallLines, spacing, 6, pal ? 5 : WH);
  const towerArchers = L.towers.length * 4;
  const garrison = Math.round((pal ? Math.max(140, Math.min(300, Math.round(qArea / 16))) : Math.max(300, Math.min(1060, Math.round(qArea / 10)))) * difficulty);
  const reserves = Math.round(garrison * (pal ? 0.35 : 0.6));
  const citGuard = L.citadel ? Math.round(220 * difficulty) : 0;
  const citArchers = L.citadel ? wallArcherPoints(L.citadel.wallLines, 2.4, 4, WH) : [];
  const total = wallArchers.length + towerArchers + garrison + reserves + citGuard + citArchers.length;
  return { wallArchers, towerArchers, garrison, reserves, citGuard, citArchers, total };
}

// A full survey of a castle from its seed+style — exact garrison order-of-battle plus
// the structural facts (towers, rings, citadel, footprint) and the layout to draw a
// schematic. Deterministic; used by the campaign map's info card.
export interface CastleSurvey {
  plan: DefenderPlan; total: number;
  towers: number; bigTowers: number; wallRings: number; gates: number;
  concentric: boolean; citadel: boolean; round: boolean; palisade: boolean;
  footprintW: number; footprintD: number; layout: CastleLayout;
  keep: { x0: number; x1: number; z0: number; z1: number } | null;
}
export function surveyCastle(seed: number, style: CastleStyle, difficulty: number): CastleSurvey {
  const prev = lastGen; // CASTLE/LAYOUT are module globals a live scene may be reading
  generateCastle(seed, style);
  const L = LAYOUT, plan = defenderPlan(L, difficulty);
  const gates = L.wallLines.filter(ln => ln.gapH > 0 && Math.abs(ln.gapC) < 1e8).length + (L.citadel ? 1 : 0);
  const kp = CASTLE.find(b => b.kind === 'keep');
  const survey: CastleSurvey = {
    plan, total: plan.total, towers: L.towers.length, bigTowers: L.towers.filter(t => t.big).length,
    wallRings: L.concentric ? 2 : 1, gates, concentric: !!L.concentric, citadel: !!L.citadel,
    round: !!L.round, palisade: !!L.palisade, footprintW: Math.round(L.W * 2), footprintD: Math.round(L.D * 2), layout: L,
    keep: kp ? { x0: kp.x0, x1: kp.x1, z0: kp.z0, z1: kp.z1 } : null,
  };
  // put the globals back the way the live scene had them (generation is seed-deterministic)
  if (prev && (prev.seed !== seed || prev.style !== style)) generateCastle(prev.seed, prev.style);
  return survey;
}

function inSeg(b: Seg, x: number, z: number): boolean {
  if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return false;
  if (b.ang === undefined) return true;
  // oriented chunk: the AABB is only the broad phase — test the true rotated box
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, ca = Math.cos(b.ang), sa = Math.sin(b.ang);
  const lx = (x - cx) * ca + (z - cz) * sa, lz = -(x - cx) * sa + (z - cz) * ca;
  return Math.abs(lx) <= (b.olen ?? SEG / 2) && Math.abs(lz) <= T / 2;
}
function blockedAt(x: number, z: number): boolean {
  for (let i = 0; i < CASTLE.length; i++) {
    const b = CASTLE[i];
    if (!b.dead && inSeg(b, x, z)) return true;
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
// Forcing an opening is cheap; SCALING an intact wall is dear — so once anything
// is breached (cost 0), the storm funnels through the gap/gate from well across the
// bailey instead of throwing men at the nearest intact wall. (Escalade still happens
// when there's no opening and the gate is far: a near wall then beats the long walk.)
const X_INF = 1e9, X_GATE = 30, X_WALL = 64;
const CROSS = new Float32Array(NCELLS);
function crossAt(x: number, z: number): number {
  let pen = 0;
  for (let i = 0; i < CASTLE.length; i++) {
    const b = CASTLE[i]; if (b.dead) continue;
    if (inSeg(b, x, z)) {
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
  shaken: boolean;     // wavering: strikes 15% weaker, visibly hesitant
  recentLoss: number;  // decaying casualty pressure (drives the morale drain)
  rallyCd: number;     // seconds until this company can answer another rally horn
  tight: boolean;      // close-order (breach plugs): tighter files, harder to shove
  firepot: boolean;    // trebuchet battery loaded with incendiaries (needs the upgrade)
  bearer: number;      // the company's standard bearer (soldier index; -1 = fallen/none)
  crewFor: number;     // unit id of the engine battery this company crews (-1 = none)
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
  plug: number;        // defender: the breached section this company has been sent to plug (-1 = none)
  // signature stance/ability per arm: Heavy 'shield' (slow, armoured, steady),
  // Light 'sprint' (fast, exposed), Archer 'volley' (longer, harder, slower).
  stance: 'normal' | 'shield' | 'sprint' | 'volley';
  chargeT: number;     // cavalry: seconds of an active couched charge remaining
  chargeCd: number;    // cavalry: seconds until the charge can be sounded again
  name: string;
}

// per-type formation spacing
const SPACING = [1.5, 1.3, 1.4, 2.1, 10];
// how many trebuchets stand abreast in the battery — a near-square block of ranks
// (capped so a big siege train stays a tidy battery, never one long line)
function siegeCols(n: number): number { return Math.min(5, n, Math.max(2, Math.ceil(Math.sqrt(n)))); }
const ENGAGE = 9; // range at which troops break formation to fight
// How close a company's body must be to its ordered ground before its men will
// peel off to chase a nearby enemy. While still marching to an objective they
// hold course (and only trade blows with whatever they make actual contact with),
// so an ordered move isn't derailed by every skirmisher along the way.
const CHASE_LEASH = 22;

export interface Projectile {
  active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  tx: number; tz: number; ty: number; dmg: number; fac: Faction; src: number; // src = firing arm's UType (for kill credit)
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
  // Per-wall-section escalade state, rebuilt each tick (indexed by CASTLE segment):
  //   wallAtt = attackers climbing/atop it, wallDef = defenders holding it.
  // Drives the foothold fight (attackers hold & clear a section before descending)
  // and the defender rush to plug a threatened section.
  wallAtt: Int16Array = new Int16Array(0);
  wallDef: Int16Array = new Int16Array(0);
  private _wallThreat = false;        // any section under escalade right now (gates the defender rush)
  captureProgress = 0;                // 0..1 — your banner rising over the keep
  // per-frame sound-effect tallies; main drains these to drive procedural audio
  sfx = { arrows: 0, bolts: 0, boulders: 0, breaches: 0, melee: 0, deaths: 0, hits: 0, cavalry: 0, oil: 0 };
  drainSfx() { const s = this.sfx; this.sfx = { arrows: 0, bolts: 0, boulders: 0, breaches: 0, melee: 0, deaths: 0, hits: 0, cavalry: 0, oil: 0 }; return s; }
  // per-frame event POSITIONS (flat x,z pairs) for render-side FX — pure output
  // logs like sfx: writers never read them, so determinism is untouched.
  clashes: number[] = [];    // where melee blows landed (clash sparks)
  fireLands: number[] = [];  // where flaming arrows came down (igniting thatch)
  drainClashes() { const c = this.clashes; this.clashes = []; return c; }
  drainFireLands() { const f = this.fireLands; this.fireLands = []; return f; }
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
  // The defending commander's temperament — seeded per castle, so each siege
  // defends differently, and difficulty scales BEHAVIOUR as well as headcount.
  cmd = { name: 'Castellan', kind: 'steady' as 'aggressive' | 'stubborn' | 'cunning' | 'steady', sortieRange: 38, wallAbandon: 40, plugCompanies: 2, moraleGrit: 0, oilCd: 6.5 };
  weather: Weather = 'clear';
  constructor(seed = 1234, comp: ArmyComp = DEFAULT_COMP, difficulty = 1, style?: CastleStyle, atk: AtkBuff = NO_BUFF, vet: number[] = [1, 1, 1, 1, 1], env?: { weather?: Weather; towers?: number; ram?: boolean; doc?: CastleDoc }) {
    this.seed = seed >>> 0; this.comp = comp; this.difficulty = difficulty; this.atk = atk;
    this.weather = env?.weather ?? 'clear';
    this.equipTowers = Math.max(0, Math.min(3, env?.towers ?? 0)); this.equipRam = !!env?.ram;
    for (let i = 0; i < 5; i++) this.vetMul[i] = vet[i] ?? 1;
    if (env?.doc) generateCastleFromDoc(env.doc); else generateCastle(seed, style);
    // pick the castellan: temperament from the castle's seed; sharper at higher difficulty
    const kinds = [
      { kind: 'aggressive' as const, name: 'Baldric the Bold', sortieRange: 58, wallAbandon: 26, plugCompanies: 2, moraleGrit: 2, oilCd: 5.5 },
      { kind: 'stubborn' as const, name: 'Odo the Unyielding', sortieRange: 28, wallAbandon: 85, plugCompanies: 3, moraleGrit: 9, oilCd: 6.5 },
      { kind: 'cunning' as const, name: 'Renaud the Fox', sortieRange: 40, wallAbandon: 42, plugCompanies: 3, moraleGrit: 4, oilCd: 6.0 },
      { kind: 'steady' as const, name: 'Hugh the Grey', sortieRange: 38, wallAbandon: 40, plugCompanies: 2, moraleGrit: 0, oilCd: 6.5 },
    ];
    this.cmd = { ...kinds[(seed >>> 5) % kinds.length] };
    if (difficulty > 1.1) { this.cmd.plugCompanies++; this.cmd.moraleGrit += 3; this.cmd.oilCd *= 0.8; } // veteran castellans at high tiers
    this.setup();
  }
  atk: AtkBuff = NO_BUFF;
  // per-arm buff accessors (base global multiplier × the arm's doctrine layer)
  private aHp(t: number) { return this.atk.hp * (this.atk.hpA?.[t] ?? 1); }
  private aDmg(t: number) { return (t === UType.Archer ? this.atk.archer : t === UType.Siege ? this.atk.siege : this.atk.melee) * (this.atk.dmgA?.[t] ?? 1); }
  private aSpd(t: number) { return this.atk.spdA?.[t] ?? 1; }
  private aCd(t: number) { return (t === UType.Siege ? this.atk.reload : 1) * (this.atk.cdA?.[t] ?? 1); }
  private aRng(t: number) { return this.atk.rngA?.[t] ?? 1; }
  equipTowers = 0; equipRam = false; // per-siege assault works (bought at muster)
  // How firm the ground is underfoot (1 = firm): the churned ring at the walls is
  // heavy going, and rain turns the whole field soft. Horses feel it most.
  footing(x: number, z: number): number {
    // churned ground = just OUTSIDE the enceinte but within a probe of it (the
    // blob test follows every notch and bastion, unlike the old bounding box)
    let f = 1;
    if (!insideCastle(x, z)
      && (insideCastle(x + MUD_RING, z) || insideCastle(x - MUD_RING, z) || insideCastle(x, z + MUD_RING) || insideCastle(x, z - MUD_RING))) f = MUD_SPEED;
    if (this.weather === 'rain') f *= 0.88;
    return f;
  }
  // per-arm veterancy combat multiplier (attacker only), indexed by UType. Lifts both
  // hp at spawn and the arm's damage. Defaults to 1 (a green, unranked host).
  vetMul = [1, 1, 1, 1, 1];
  // kills credited to each attacker arm this battle, indexed by UType — drives XP.
  attackerKills = [0, 0, 0, 0, 0];
  // transient: while a projectile's impact is being resolved, which attacker arm
  // (UType) loosed it, so a felling shot can be credited. -1 = not an attacker shot.
  private _shotCredit = -1;
  private creditAtkKill(type: number) { if (type >= 0 && type < 5) this.attackerKills[type]++; }

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
      this.hp[id] = HP[type] * (faction === Faction.Attacker ? this.aHp(type) * this.vetMul[type] : 1); this.cd[id] = this.rnd() * 0.5;
      this.ammo[id] = AMMO[type] * (faction === Faction.Attacker ? (this.atk.ammoA?.[type] ?? 1) : 1);
      this.unit[id] = this.units.length; this.fac[id] = faction; this.typ[id] = type;
      this.alive[id] = 1; this.slot[id] = this.typeCount[type]++;
    }
    const ax = count ? sx / count : 0, az = count ? sz / count : 0;
    const u: Unit = {
      id: this.units.length, faction, type, div: opts.div ?? -1, s0, count, alive: count,
      morale: 100, routing: false, hold: !!opts.hold,
      shaken: false, recentLoss: 0, rallyCd: 0, tight: false, firepot: false, crewFor: opts.crewFor ?? -1,
      bearer: (type !== UType.Siege && (opts.crewFor ?? -1) < 0 && count >= 12) ? s0 : -1, // fighting companies carry a standard
      goal: opts.goal ?? cellOf(ax, az),
      ax, az,
      facing: Math.atan2(0 - ax, 0 - az), // face the castle (origin) by default
      cols: opts.cols ?? (type === UType.Siege ? count : Math.max(6, Math.round(Math.sqrt(count) * 1.7))),
      cx: ax, cz: az, siegeTargetSeg: -1,
      ammo: AMMO[type] * count, ammoMax: AMMO[type] * count,
      focusX: 0, focusZ: 0, hasFocus: false, fireArrows: !!opts.fireArrows,
      holdFire: false, assault: false, objKind: 'hold', objSeg: -1, plug: -1,
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

    // ---------------- DEFENDERS (from the shared order-of-battle plan) ----------------
    const cit = L.citadel;
    const openBailey = (): [number, number, number] => {
      let x = 0, z = 0;
      for (let t = 0; t < 50; t++) {
        x = R(-(W - T - 2), W - T - 2); z = R(-(D - T - 2), D - T - 2);
        if (!insideCastle(x, z)) continue; // the bbox lies in the notches of an irregular trace
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
    const plan = defenderPlan(L, this.difficulty);
    const wallPts = plan.wallArchers, NT = TOWERS.length, garr = plan.garrison;
    const reserves = plan.reserves, citGuard = plan.citGuard, cPts = plan.citArchers;
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
      // Wider, airier grids: companies stand well apart so a big host reads as a
      // spread-out army encamped across the field, not a clump of dense columns.
      const across = Math.max(1, Math.round(Math.sqrt(Math.ceil(total / 40) * 2.0)));
      let left = total, k = 0, idx = 0;
      while (left > 0) {
        const c = Math.min(left, 30 + Math.floor(this.rnd() * 21));
        const col = k % across, row = Math.floor(k / across);
        const ax = cx + (col - (across - 1) / 2) * 23, az = cz + row * 19;
        const ccols = Math.max(3, Math.round(Math.sqrt(c) * 1.4));
        this.addUnit(Faction.Attacker, type, c, block(ax, az, ccols, gap), { name: `${name} ${++idx}`, cols: ccols, div: type });
        left -= c; k++;
      }
    };
    division(S(C.heavy), UType.Heavy, 0, F + 46, 2.0, 'Heavy Inf');
    division(S(C.light), UType.Light, -W * 0.9, F + 66, 1.8, 'Light Inf');
    division(S(C.archer), UType.Archer, 0, F + 88, 1.9, 'Archers');
    division(S(C.cavalry), UType.Cavalry, W * 1.0, F + 66, 2.7, 'Cavalry');
    // trebuchets form up in a battery of RANKS (a near-square block), not one long line
    if (C.siege) {
      const scols = siegeCols(C.siege);
      const battery = this.addUnit(Faction.Attacker, UType.Siege, C.siege, block(0, F + 112, scols, 14), { name: 'Trebuchets', cols: scols, div: UType.Siege });
      // every two engineers work one machine: kill the crew and the engine stands
      // idle for the rest of the battle. The crew marches with the battery.
      this.addUnit(Faction.Attacker, UType.Light, C.siege * 2, block(0, F + 122, Math.max(3, scols * 2), 1.8),
        { name: 'Engine Crews', div: UType.Siege, crewFor: battery.id });
    }

    // the purchased assault works roll up behind the host
    this.assaultWorks = [];
    for (let k = 0; k < this.equipTowers; k++) this.assaultWorks.push({ kind: 'tower', x: (k - (this.equipTowers - 1) / 2) * 34, z: F + 98, hp: 2800, maxhp: 2800, state: 'advance', seg: -1, ladders: [] });
    if (this.equipRam) this.assaultWorks.push({ kind: 'ram', x: L.gate.x, z: F + 92, hp: 2000, maxhp: 2000, state: 'advance', seg: -1, ladders: [] });

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
    // BARRICADES: timber barriers thrown across the lanes inside each gate — the
    // post-breach fight is house-to-house work, not an open sprint to the keep.
    // They ride the GATE mechanics (bashed through by a crew in ~10s, defenders
    // pre-form behind them when threatened) but stand low and weak, and no
    // engine ever wastes a stone on one (filters check h > 3 for real gates).
    if (!L.palisade) {
      for (let s2 = CASTLE.length - 1; s2 >= 0; s2--) {
        const g = CASTLE[s2]; if (g.kind !== 'gate' || g.h <= 3) continue;
        const gcx = (g.x0 + g.x1) / 2, gcz = (g.z0 + g.z1) / 2;
        const kx = this.keepX - gcx, kz = this.keepZ - gcz, kl = Math.hypot(kx, kz) || 1;
        const bx = gcx + kx / kl * 13, bz = gcz + kz / kl * 13;
        if (blockedAt(bx, bz)) continue; // a house sits there — the lane is its own barricade
        const horiz = Math.abs(kx) < Math.abs(kz), w2 = Math.min(5, (g.x1 - g.x0) / 2 + 1);
        CASTLE.push(horiz
          ? { x0: bx - w2, x1: bx + w2, z0: bz - 0.7, z1: bz + 0.7, h: 2.2, kind: 'gate', hp: 300, maxhp: 300, dead: false }
          : { x0: bx - 0.7, x1: bx + 0.7, z0: bz - w2, z1: bz + w2, h: 2.2, kind: 'gate', hp: 300, maxhp: 300, dead: false });
      }
      rebuildBlocked();
    }
    // defensive ballistae from the layout (staggered initial reload)
    this.ballistae = LAYOUT.ballistae.map(b => ({ x: b.x, z: b.z, y: b.y, seg: b.seg, cd: this.rnd() * BALLISTA_CD, recoil: 0, horiz: b.horiz, outer: b.outer, aimX: b.x, aimZ: b.z + b.outer * 40 }));
    // ...each manned by a two-man crew standing at the piece on the battlements —
    // cut them down (escalade the wall) and the engine falls silent.
    if (this.ballistae.length) {
      this.ballistaCrewUnit = this.addUnit(Faction.Defender, UType.Light, this.ballistae.length * 2, (i) => {
        const e = this.ballistae[Math.floor(i / 2)];
        return [e.x + (i % 2 ? 1.4 : -1.4), e.z, e.y];
      }, { hold: true, name: 'Ballista Crews' });
    }
  }

  private setAnchor(u: Unit, x: number, z: number, facing: number, cols: number) {
    u.ax = Math.max(WORLD.minX + 2, Math.min(WORLD.maxX - 2, x));
    u.az = Math.max(WORLD.minZ + 2, Math.min(WORLD.maxZ - 2, z));
    u.facing = facing;
    // trebuchets draw up in a tidy battery of ranks (a near-square block), not one
    // long line strung across the field
    // honour the ordered formation width for every arm, trebuchets included, so a
    // battery fans out or ranks up with the drag (min 1 file for siege, 3 for foot)
    u.cols = u.type === UType.Siege ? Math.max(1, Math.min(u.count, Math.round(cols))) : Math.max(3, Math.min(u.count, Math.round(cols)));
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
      if (u.crewFor >= 0) continue; // engine crews support the battery — the card shows the ENGINES
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
    const isTap = w < 4;
    let facing: number, ox = x0, oz = z0;
    if (isTap) { // a tap: build a line centred on the point, facing the castle
      facing = Math.atan2(0 - x1, 0 - z1);
      const across0 = Math.max(1, Math.round(Math.sqrt(n))), lineW = across0 * 15;
      const rx = Math.cos(facing), rz = -Math.sin(facing);
      ox = x1 - rx * lineW / 2; oz = z1 - rz * lineW / 2; dx = rx * lineW; dz = rz * lineW; w = lineW;
    } else {
      let fx = -dz / w, fz = dx / w; const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      if (fx * (0 - mx) + fz * (0 - mz) < 0) { fx = -fx; fz = -fz; }
      facing = Math.atan2(fx, fz);
    }
    // Trebuchets are one battery, not a grid of companies — lay them across the whole
    // drawn line: a long drag → a wide firing line, a short drag → deep ranks, a tap →
    // a tidy near-square block. (Spreading "companies" wouldn't help — siege is one.)
    if (comps.some(u => u.type === UType.Siege)) {
      const engines = comps.filter(u => u.type === UType.Siege), crews = comps.filter(u => u.crewFor >= 0);
      const total = engines.reduce((s, u) => s + u.count, 0);
      const cols = isTap ? siegeCols(total) : Math.max(1, Math.min(total, Math.round(w / SPACING[UType.Siege]) + 1));
      const mx = ox + dx * 0.5, mz = oz + dz * 0.5;
      for (const u of engines) { u.assault = false; u.objKind = 'hold'; u.objSeg = -1; this.setAnchor(u, mx, mz, facing, cols); }
      for (const u of crews) { // the engineers fall in just behind their machines (away from the castle)
        const away = Math.hypot(mx, mz) || 1;
        u.assault = false; u.objKind = 'hold'; u.objSeg = -1;
        this.setAnchor(u, mx + mx / away * 9, mz + mz / away * 9, facing, Math.max(4, Math.round(Math.sqrt(u.count) * 1.8)));
      }
      return;
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
  // nearest living ENEMY soldier to a tapped point — backs the "Attack" command
  // (returns its position so the order targets the unit the player tapped).
  enemyPosNear(x: number, z: number, maxDist = 20): { x: number; z: number } | null {
    let bi = -1, bd = maxDist * maxDist;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i] || this.fac[i] !== Faction.Defender) continue;
      const d2 = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2;
      if (d2 < bd) { bd = d2; bi = i; }
    }
    return bi >= 0 ? { x: this.px[bi], z: this.pz[bi] } : null;
  }
  // Order an arm to ATTACK a point: ranged focus-fire it, melee march in and
  // engage (cavalry get a charge). Reuses the existing order plumbing.
  attackTargetDiv(div: number, x: number, z: number) {
    const cs = this.divCompanies(div); if (!cs.length) return;
    const ranged = cs[0].type === UType.Archer || cs[0].type === UType.Siege;
    if (ranged) { this.setFocusDiv(div, x, z); for (const u of cs) u.holdFire = false; }
    else { this.orderDivision(div, x, z, x, z); if (cs[0].type === UType.Cavalry) this.chargeDiv(div); }
  }
  // southernmost line you may muster on during deploy (just outside the walls)
  deployLine(): number { return LAYOUT.front + 8; }
  // Deploy ANYWHERE outside the castle (complex assaults from every quarter) —
  // refused only inside the enceinte or pressed right against it.
  deployOk(x: number, z: number): boolean {
    if (x < WORLD.minX + 6 || x > WORLD.maxX - 6 || z < WORLD.minZ + 6 || z > WORLD.maxZ - 6) return false;
    return !insideCastle(x, z) && !insideCastle(x + 12, z) && !insideCastle(x - 12, z) && !insideCastle(x, z + 12) && !insideCastle(x, z - 12);
  }
  // A battery ordered onto a target beyond its reach ADVANCES to firing range on
  // its own (with its crews in tow) — an order should never silently do nothing.
  private advanceBattery(div: number, tx: number, tz: number) {
    const engines = this.divCompanies(div).filter(u => u.type === UType.Siege);
    if (!engines.length) return;
    const rng = RANGE[UType.Siege] * this.aRng(UType.Siege) * 0.88;
    for (const u of engines) {
      const d = Math.hypot(tx - u.cx, tz - u.cz);
      if (d <= rng) continue;
      const nx = u.cx + (tx - u.cx) * (1 - rng / d), nz = u.cz + (tz - u.cz) * (1 - rng / d);
      this.setAnchor(u, nx, nz, Math.atan2(tx - nx, tz - nz), u.cols);
      for (const cu of this.divCompanies(div)) { // the engineers keep pace, just behind
        if (cu.crewFor !== u.id) continue;
        const away = Math.hypot(nx, nz) || 1;
        this.setAnchor(cu, nx + nx / away * 9, nz + nz / away * 9, u.facing, Math.max(4, Math.round(Math.sqrt(cu.count) * 1.8)));
      }
    }
  }
  setSiegeTargetDiv(div: number, segIdx: number) { for (const u of this.divCompanies(div)) { u.siegeTargetSeg = segIdx; u.hasFocus = false; u.holdFire = false; } const [cx, cz] = this.segCenter(segIdx); this.advanceBattery(div, cx, cz); }
  setFocusDiv(div: number, x: number, z: number) { for (const u of this.divCompanies(div)) { u.hasFocus = true; u.focusX = x; u.focusZ = z; } }
  // Order a trebuchet battery to BOMBARD a ground point (anti-personnel) instead of a
  // wall — so the player chooses: batter the walls, or rain stone on massed infantry.
  setSiegeBombardDiv(div: number, x: number, z: number) { for (const u of this.divCompanies(div)) { u.siegeTargetSeg = -1; u.hasFocus = true; u.focusX = x; u.focusZ = z; u.holdFire = false; } this.advanceBattery(div, x, z); }
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
      if (u.type === UType.Siege || u.crewFor >= 0 || u.routing) continue; // engine crews stay with their battery
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
      if (u.type === UType.Siege || u.crewFor >= 0 || u.routing) continue; // engine crews stay with their battery
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
  // Did a tap land INSIDE the castle footprint (the bailey/courtyard)? Tapping in
  // there means "get inside" — issue a storm rather than forming up at the wall.
  insideWalls(x: number, z: number): boolean { return insideCastle(x, z); }
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
  chargeDiv(div: number) { const dur = CHARGE_DUR + (this.atk.chargeDur ?? 0), cd = CHARGE_CD * (this.atk.chargeCd ?? 1); for (const u of this.divCompanies(div)) if (u.type === UType.Cavalry && u.chargeCd <= 0 && !u.routing) { u.chargeT = dur; u.chargeCd = dur + cd; } }
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
  // dev assault diagnostics: event counters (incremented at the decision points,
  // read+reset as a rate per window) + a live snapshot of where the attacker host is.
  _diag = { aMove: 0, engWall: 0, engGate: 0, useLadder: 0, ladMade: 0, ladCap: 0, ladReuse: 0, noWall: 0 };
  assaultDiag() {
    const F = Faction.Attacker;
    let total = 0, hold = 0, rout = 0, climbing = 0, onWall = 0, storm = 0, breach = 0, move = 0, atFoot = 0, defWall = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      if (this.fac[i] !== F) { if (this.py[i] > 5) defWall++; continue; } // defenders manning the battlements
      total++;
      if (this.climbState[i] > 0) { climbing++; continue; }
      if (this.py[i] > 5) { onWall++; continue; }
      const u = this.units[this.unit[i]];
      if (u.routing) { rout++; continue; }
      if (u.hold) { hold++; continue; }
      const ok = u.objKind;
      if (ok === 'storm') storm++; else if (ok === 'breach') breach++; else move++;
      // standing right at a wall (grid-cheap: a BLOCKED cell within ~5m)?
      if (this.py[i] < 1) {
        const px = this.px[i], pz = this.pz[i];
        if (BLOCKED[cellOf(px + 5, pz)] || BLOCKED[cellOf(px - 5, pz)] || BLOCKED[cellOf(px, pz + 5)] || BLOCKED[cellOf(px, pz - 5)]) atFoot++;
      }
    }
    let secs = 0; for (let s = 0; s < this.wallAtt.length; s++) if (this.wallAtt[s] > 0) secs++;  // sections under escalade
    const d = this._diag;
    const ev = { aMove: d.aMove, engWall: d.engWall, engGate: d.engGate, useLadder: d.useLadder, ladMade: d.ladMade, ladCap: d.ladCap, ladReuse: d.ladReuse, noWall: d.noWall };
    this._diag = { aMove: 0, engWall: 0, engGate: 0, useLadder: 0, ladMade: 0, ladCap: 0, ladReuse: 0, noWall: 0 };
    return { total, hold, rout, storm, breach, move, atFoot, climbing, onWall, defWall, secs, ladders: this.ladders.length, ev };
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

    // centroids + live ammo per unit
    for (const u of this.units) {
      let ax = 0, az = 0, a = 0, am = 0;
      for (let i = u.s0; i < u.s0 + u.count; i++) if (this.alive[i]) { ax += this.px[i]; az += this.pz[i]; a++; am += this.ammo[i]; }
      u.alive = a; u.ammo = am;
      if (a > 0) { u.cx = ax / a; u.cz = az / a; }
      if (u.chargeT > 0) u.chargeT = Math.max(0, u.chargeT - dt);   // cavalry charge timers
      if (u.chargeCd > 0) u.chargeCd = Math.max(0, u.chargeCd - dt);
      if (u.rallyCd > 0) u.rallyCd = Math.max(0, u.rallyCd - dt);
    }
    // ---- MORALE: nerve, fear and rally (second pass — needs all centroids) ----
    if (!deploy) {
      const decay = Math.exp(-dt / 2.5);
      for (const u of this.units) {
        if (u.alive <= 0) continue;
        u.recentLoss *= decay;
        const inContact = u.recentLoss > 0.15;
        // fear is contagious: routing friends nearby drain nerve — but capped, so a
        // mass rout frightens, it doesn't automatically sweep the whole garrison
        let fear = 0;
        for (const v of this.units) {
          if (v === u || v.faction !== u.faction || !v.routing || v.alive <= 0) continue;
          if ((v.cx - u.cx) ** 2 + (v.cz - u.cz) ** 2 < 25 * 25 && ++fear >= 3) break;
        }
        if (u.bearer >= 0) fear *= 0.6; else if (u.count >= 12 && u.type !== UType.Siege && u.crewFor < 0) fear *= 1.3; // the standard steadies men; its absence haunts them
        if (!u.routing) {
          u.morale = Math.min(100, Math.max(0, u.morale - fear * MOR_FEAR * dt + (inContact ? 0 : MOR_RECOVER * dt)));
          u.shaken = u.morale < MOR_SHAKEN;
          // break: nerve gone while under real pressure, or shattered outright
          if ((u.morale < MOR_BREAK + this.cmd.moraleGrit * (u.faction === Faction.Defender ? -1 : 0) && inContact)
              || u.alive / u.count < ROUT_FRAC) { u.routing = true; u.shaken = true; u.plug = -1; u.tight = false; } // a broken plug leaves the gap open for a fresh company
        } else {
          // broken: nerve returns once the pursuit stops; an ATTACKING company that
          // steadies itself re-forms on its own (defenders who break are done — they
          // stream for the gates, which is how a castle falls)
          if (!inContact) u.morale = Math.min(60, u.morale + MOR_RECOVER * 0.8 * dt);
          if (u.faction === Faction.Attacker && u.morale >= MOR_RALLY + 8 && u.alive / u.count >= ROUT_FRAC + 0.05) {
            u.routing = false; u.shaken = true; u.rallyCd = 8;
            this.setAnchor(u, u.cx, u.cz, u.facing, Math.max(3, Math.round(Math.sqrt(u.alive) * 1.4)));
            u.assault = false; u.objKind = 'hold'; u.objSeg = -1;
          }
        }
      }
    }
    if (!deploy) {
      // The castle falls only when you actually win it: either raise your banner
      // over the keep (hold its ground while the garrison there is cleared) or
      // grind the garrison down to a shattered remnant. Count who holds the keep.
      let defAlive = 0, attInside = 0, attKeep = 0, defKeep = 0, aix = 0, aiz = 0;
      const kr2 = this.captureR * this.captureR;
      if (this.wallAtt.length !== CASTLE.length) { this.wallAtt = new Int16Array(CASTLE.length); this.wallDef = new Int16Array(CASTLE.length); }
      else { this.wallAtt.fill(0); this.wallDef.fill(0); }
      for (let i = 0; i < this.n; i++) {
        if (!this.alive[i]) continue;
        const nearKeep = (this.px[i] - this.keepX) ** 2 + (this.pz[i] - this.keepZ) ** 2 < kr2 && this.py[i] < 7;
        const cs = this.climbState[i], seg = this.climbSeg[i];
        if (this.fac[i] === Faction.Defender) {
          defAlive++;
          if (nearKeep) defKeep++;
          if (cs === 4 && seg >= 0) this.wallDef[seg]++;          // defender holding the battlements
        } else if (this.typ[i] !== UType.Siege) {
          if (cs === 0 && this.py[i] < 2 && insideCastle(this.px[i], this.pz[i])) { attInside++; aix += this.px[i]; aiz += this.pz[i]; }
          if (nearKeep) attKeep++;
          if ((cs === 1 || cs === 2) && seg >= 0) this.wallAtt[seg]++; // attacker scaling / on the battlements
        }
      }
      if (attInside > 0) { this.attInX = aix / attInside; this.attInZ = aiz / attInside; }
      const defFrac = defAlive / Math.max(1, this.defenderAliveStart);
      this.attInsideCount = attInside; // wall defenders abandon the walls once this is high
      this._wallThreat = false; for (let s = 0; s < this.wallAtt.length; s++) if (this.wallAtt[s] > 0) { this._wallThreat = true; break; }
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
      const spd = SPEED[t] * this.speedMul(u) * (u.faction === Faction.Attacker ? this.aSpd(t) : 1) * (this.py[i] < 1 ? this.footing(this.px[i], this.pz[i]) : 1);
      let dx = 0, dz = 0;       // desired direction
      this.cd[i] -= dt;

      const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((this.px[i] - WORLD.minX) / this.hCell)));
      const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((this.pz[i] - WORLD.minZ) / this.hCell)));

      // ---- nearest reachable enemy (skipped during deploy & for siege) ----
      let nearest = -1; const senseR = SENSE[t] * (this.weather === 'mist' && t === UType.Archer ? MIST_RANGE : 1); let nd2 = senseR * senseR;
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
          // Archers must SEE every enemy they can SHOOT: scan out to their firing
          // range (RANGE=40 → ~7 buckets), not the melee-contact cap of 4 buckets
          // (24m) that left in-range foes beyond ~24m completely untargeted.
          const sr = t === UType.Archer ? 7 : Math.min(SRAD[t], 4); let done = false;
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
          // engaged -> stay sharp; nothing found -> coast. Archers scan a far wider
          // ring, so they coast a little longer (the cheap cached-target check below
          // keeps them firing every frame between rescans).
          this._scanCd[i] = nearest >= 0 ? (t === UType.Archer ? 7 : 4) : (t === UType.Archer ? 10 : 8);
        }
      }

      // soldiers on a ladder / wall-top are handled by climbStep (unless routing,
      // in which case they bail off the wall and flee)
      if (!deploy && this.climbState[i] > 0 && !u.routing) { this.climbStep(i, u, t, dt, nearest); continue; }

      // Defenders abandon the wall-tops and come DOWN to fight once the attackers
      // hold the courtyard (or they're out of arrows) — they can't keep shooting
      // from above a fight they can't join.
      if (!deploy && !u.routing && u.faction === Faction.Defender && this.py[i] > 2 && this.climbState[i] === 0
          && (this.attInsideCount > this.cmd.wallAbandon || (t === UType.Archer && this.ammo[i] <= 0))) {
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
          const sr = RANGE[t] * this.aRng(t); if (((CASTLE[seg].x0 + CASTLE[seg].x1) / 2 - this.px[i]) ** 2 + ((CASTLE[seg].z0 + CASTLE[seg].z1) / 2 - this.pz[i]) ** 2 > sr * sr) seg = -1;
        } else if (!u.holdFire && !u.hasFocus) {
          // no specific orders and not stood down → batter the nearest wall on their own
          seg = this.nearestWall(this.px[i], this.pz[i], RANGE[t]);
        }
        const canFire = this.cd[i] <= 0 && this.ammo[i] > 0 && !u.holdFire && this.engineCrewed(u, i);
        if (seg >= 0 && canFire) { this.lobBoulder(i, seg, u); this.cd[i] = ATKCD[t] * this.aCd(t); this.ammo[i]--; }
        else if (seg < 0 && u.hasFocus && canFire) {
          // anti-personnel bombardment of the ordered ground point (if it's in range)
          const br = RANGE[t] * this.aRng(t); if ((u.focusX - this.px[i]) ** 2 + (u.focusZ - this.pz[i]) ** 2 <= br * br) { this.lobBoulderAt(i, u.focusX, u.focusZ, u); this.cd[i] = ATKCD[t] * this.aCd(t); this.ammo[i]--; }
        }
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
          const abuff = u.faction === Faction.Attacker;
          if (settled && this.cd[i] <= 0 && nearest >= 0 && dist <= RANGE[t] * (vol ? 1.28 : 1) * (abuff ? this.aRng(t) : 1) * (this.weather === 'mist' ? MIST_RANGE : 1) && !u.holdFire && this.focusOk(u, nearest) && this.losClear(i, nearest)) {
            this.shoot(i, nearest, vol ? 1.7 : 1); this.cd[i] = ATKCD[t] * (vol ? 1.85 : 1) * (abuff ? this.aCd(t) : 1); this.ammo[i]--;
          }
        } else {
          // melee — including archers who've spent all their arrows
          // Defender reserves rush to PLUG a wall section under escalade: the nearest
          // free melee company marches to the threatened stretch and climbs its interior
          // stairs to meet the attackers at the ladder-top before they spread.
          if (this._wallThreat && u.hold && u.faction === Faction.Defender && t === UType.Light && this.py[i] < 3 && !u.routing) {
            const seg = this.nearestThreatenedWall(this.px[i], this.pz[i], 45);
            if (seg >= 0) {
              const g = CASTLE[seg], cpx = Math.max(g.x0, Math.min(g.x1, this.px[i])), cpz = Math.max(g.z0, Math.min(g.z1, this.pz[i]));
              const ddx = cpx - this.px[i], ddz = cpz - this.pz[i], dwall = Math.hypot(ddx, ddz);
              if (dwall <= this.CLIMB + 2) { this.startClimb(i, seg); continue; } // at the wall → up the stairs to fight
              dx = ddx / (dwall || 1); dz = ddz / (dwall || 1);                    // else march to the threatened section
              this.px[i] += dx * SPEED[t] * dt; this.pz[i] += dz * SPEED[t] * dt; continue;
            }
          }
          const mrng = t === UType.Archer ? RANGE[UType.Light] : RANGE[t];
          // An attacker still fighting its way IN (storming/breaching, not yet inside the
          // walls) must keep scaling — it does not get dragged off to chase a defender,
          // which is what left whole arms swirling at the foot of the wall instead of
          // going up it. It still trades blows with anyone right in its face (melee), and
          // once it's inside it fights/chases normally to clear the bailey.
          const assaultingOut = u.faction === Faction.Attacker && (u.objKind === 'storm' || u.objKind === 'breach') && !this.insideWalls(this.px[i], this.pz[i]);
          if (nearest >= 0 && dist <= mrng) {
            if (this.cd[i] <= 0) this.meleeStrike(i, nearest, u, t);
            if (!this.alive[i]) continue; // the horse balked into spearpoints and fell
            if (assaultingOut) { this.assaultMove(i, u, t); dx = this._dir[0]; dz = this._dir[1]; } // press on up the wall even while trading blows
          } else if (nearest >= 0 && dist < ENGAGE && !u.hold && !assaultingOut && !pathBlocked(this.px[i], this.pz[i], this.px[nearest], this.pz[nearest])
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
            } else if (nearest >= 0 && dist < (town ? 75 : this.cmd.sortieRange) && !pathBlocked(this.px[i], this.pz[i], this.px[nearest], this.pz[nearest])) {
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
      // personal space: a touch wider than before so the sprites read as BODIES
      // with depth, not a flat pile — close-order (breach plug) files stand tighter
      const rad = RADIUS[t] * (u.tight ? 1.4 : 1.9), rad2 = rad * rad;
      const eBlockR = ENEMY_BLOCK_R + RADIUS[t] * 0.4, eBlock2 = eBlockR * eBlockR;
      const reach = Math.max(rad, eBlockR);
      const lx = (this.px[i] - WORLD.minX) - hc * this.hCell;
      const lz = (this.pz[i] - WORLD.minZ) - hr * this.hCell;
      const cLo = lx < reach ? hc - 1 : hc, cHi = lx > this.hCell - reach ? hc + 1 : hc;
      const rLo = lz < reach ? hr - 1 : hr, rHi = lz > this.hCell - reach ? hr + 1 : hr;
      const my2 = this.py[i];
      for (let rr = rLo; rr <= rHi; rr++) for (let cc = cLo; cc <= cHi; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const k = rr * this.hCols + cc, bs = this.hStart[k];
        // cap neighbours sampled per bucket — separation is a soft force, so a
        // sample suffices and it keeps the gate pile from melting the frame-rate
        const cap = Math.min(this.hStart[k + 1] - bs, 22);
        for (let bi = 0; bi < cap; bi++) {
          const j = this.hItems[bs + bi]; if (j === i || this.climbState[j] > 0) continue;
          const ex = this.px[i] - this.px[j], ez = this.pz[i] - this.pz[j];
          const d2 = ex * ex + ez * ez;
          if (d2 <= 0.0001) continue;
          if (this.fac[j] !== this.fac[i]) {
            // enemies are SOLID: a strong short-range block, so a formed line is a
            // wall of men you must cut through — never a crowd you jog through.
            if (d2 < eBlock2 && Math.abs(this.py[j] - my2) < 2.5) {
              const d = Math.sqrt(d2), f = (1 - d / eBlockR) * ENEMY_BLOCK_F;
              sx += ex / d * f; sz += ez / d * f;
            }
          } else if (d2 < rad2) {
            // separation radius kept BELOW formation spacing so soldiers settled
            // in their ranks don't shove each other (that caused the vibrating).
            const d = Math.sqrt(d2); sx += ex / d * (1 - d / rad); sz += ez / d * (1 - d / rad);
          }
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
    if (!deploy) { this.battleT += dt; if (this.pushT > 0) this.pushT = Math.max(0, this.pushT - dt); this.stepWorks(dt); this.stepBurning(dt); this.stepDefence(dt); this.stepRams(dt); this.stepBallistae(dt); this.stepProjectiles(dt); this.checkVictory(); }
    _p.post += performance.now() - _t; _p.steps++;
  }

  // Arrows are stopped by stone. A GROUND archer can't shoot through a wall or a
  // house; an ELEVATED shooter (battlements, towers) arcs over cover near himself
  // but not over cover hugging the target (we test the last 40% of the flight).
  // Shooting UP at the battlements stays legal — the wall face is the target's floor.
  private losClear(i: number, j: number): boolean {
    const sy = this.py[i], ty = this.py[j];
    if (ty >= 2.5) return true;
    if (sy < 2.5) return !pathBlocked(this.px[i], this.pz[i], this.px[j], this.pz[j]);
    const mx = this.px[i] + (this.px[j] - this.px[i]) * 0.6, mz = this.pz[i] + (this.pz[j] - this.pz[i]) * 0.6;
    return !pathBlocked(mx, mz, this.px[j], this.pz[j]);
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

  private kill(i: number, u: Unit) {
    this.alive[i] = 0;
    if (u) {
      u.alive = Math.max(0, u.alive - 1);
      u.morale = Math.max(0, u.morale - MOR_LOSS_K / u.count); // every fallen friend chips the company's nerve
      u.recentLoss += 1;
      if (i === u.bearer) { u.bearer = -1; u.morale = Math.max(0, u.morale - 18); u.recentLoss += 2; } // the STANDARD falls
    }
  }

  // One melee blow, with everything that makes combat читаться as COMBAT:
  // facing (flank/rear hurt more and shake nerve), the counter-triangle
  // (spears beat horses; a braced shield-wall breaks a charge), charge impact
  // (knockback + stagger), wounds and wavering nerves weakening the arm.
  private meleeStrike(i: number, j: number, u: Unit, t: UType) {
    const vu = this.units[this.unit[j]], vt = this.typ[j] as UType;
    let dmg = (t === UType.Archer ? MELEE[UType.Light] : MELEE[t]) * (u.faction === Faction.Attacker ? this.atk.melee * (this.atk.dmgA?.[t] ?? 1) * this.vetMul[t] : 1);
    if (this.pushT > 0 && u.faction === Faction.Attacker) dmg *= 1.15; // the General's Push — blood is up
    if (u.shaken) dmg *= 0.85;                                     // a wavering man strikes half-heartedly
    if (this.hp[i] < HP[t] * WOUND_FRAC) dmg *= WOUND_MULT;        // a wounded man, weaker still
    // facing: which way is the blow arriving relative to the victim company's front?
    let adx = this.px[j] - this.px[i], adz = this.pz[j] - this.pz[i];
    const al = Math.hypot(adx, adz) || 1; adx /= al; adz /= al;
    const fdot = adx * Math.sin(vu.facing) + adz * Math.cos(vu.facing); // -1 = from the front, +1 = from behind
    let mult = fdot > 0.55 ? REAR_MULT : fdot > -0.25 ? FLANK_MULT : 1;
    if (t === UType.Light && mult > 1) mult *= (u.faction === Faction.Attacker ? this.atk.lightFlank ?? LIGHT_FLANK : LIGHT_FLANK); // skirmishers live for the flank
    const braced = vu.stance === 'shield' && vt === UType.Heavy;
    const charging = t === UType.Cavalry && u.chargeT > 0;
    if (t === UType.Heavy && vt === UType.Cavalry) mult *= vu.stance === 'shield' ? 1 : HEAVY_VS_CAV; // spears among the heavies
    if (u.type === UType.Heavy && u.stance === 'shield' && vt === UType.Cavalry) mult *= (u.faction === Faction.Attacker ? this.atk.braceMul ?? BRACE_VS_CAV : BRACE_VS_CAV); // a set wall punishes horse
    if (charging) {
      if (braced) {
        u.chargeT = 0;                                             // the horses BALK at a braced wall —
        this.hp[i] -= MELEE[UType.Heavy] * 0.9;                    // — and take the spearpoints for trying
        if (this.hp[i] <= 0) { this.kill(i, u); return; }
      } else {
        const boggy = this.footing(this.px[i], this.pz[i]) < 0.95; // heavy ground robs the charge of its weight
        dmg *= (u.faction === Faction.Attacker ? this.atk.chargeMul ?? CHARGE_DMG : CHARGE_DMG) * (boggy ? 0.55 : 1);
        if (!boggy) { // impact: the struck man is hurled back and staggered
          this.vx[j] += adx * CHARGE_KNOCK; this.vz[j] += adz * CHARGE_KNOCK;
          this.cd[j] = Math.max(this.cd[j], CHARGE_STUN);
        }
        u.chargeT = Math.max(0, u.chargeT - 0.25);                 // momentum spent on each body
      }
    }
    if (mult > 1) vu.morale = Math.max(0, vu.morale - MOR_REAR_HIT); // blows from the flank shake nerve beyond the wound
    this.hp[j] -= dmg * mult * this.defenseMul(j);
    this.cd[i] = ATKCD[t];
    this.sfx.melee++;
    if (this.clashes.length < 96) this.clashes.push(this.px[j], this.pz[j]);
    if (t === UType.Cavalry && u.faction === Faction.Attacker) this.sfx.cavalry++;
    if (this.hp[j] <= 0) { this.kill(j, vu); if (u.faction === Faction.Attacker && u.crewFor < 0) this.creditAtkKill(t); }
  }

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
  // Nearest wall section currently under escalade (attackers climbing/atop it), or -1.
  // Drives the defender rush to plug a threatened section.
  private nearestThreatenedWall(x: number, z: number, maxD: number): number {
    let best = -1, bd = maxD * maxD;
    for (let s = 0; s < CASTLE.length; s++) {
      if (this.wallAtt[s] <= 0) continue;
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
      const L = this.ladders[l]; if (L.seg !== seg || L.dead) continue;
      onSeg++; const d = Math.abs(L.along - myAlong); if (d < bd) { bd = d; best = l; }
    }
    if (best >= 0 && bd < 5) { this._diag.ladReuse++; return best; }      // reuse a nearby ladder
    const segLen = horiz ? g.x1 - g.x0 : g.z1 - g.z0;
    const cap = Math.max(1, Math.floor(segLen / 4));
    if (onSeg >= cap || this.ladders.length >= this.LADDER_CAP) { this._diag.ladCap++; return best; } // at cap → share the nearest
    this._diag.ladMade++;
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
    this._diag.aMove++;
    // A "break in HERE" order: smash the named section until it's open, even if a
    // way already exists elsewhere — the player chose this wall.
    if (u.objKind === 'breach') {
      if (u.objSeg >= 0 && CASTLE[u.objSeg] && !CASTLE[u.objSeg].dead) {
        const g = CASTLE[u.objSeg];
        const cpx = Math.max(g.x0, Math.min(g.x1, this.px[i])), cpz = Math.max(g.z0, Math.min(g.z1, this.pz[i]));
        const dxw = cpx - this.px[i], dzw = cpz - this.pz[i], dw = Math.hypot(dxw, dzw);
        if (dw <= this.CLIMB + 1.5) { this.engageWall(i, u, t, u.objSeg); return; } // at the ordered wall → force it
        // Another standing wall between us and the target (e.g. the OUTER curtain when
        // the order is on the inner citadel)? Scale THAT one first — otherwise the
        // company presses uselessly against a wall it was never told to climb.
        const dirx = dxw / (dw || 1), dirz = dzw / (dw || 1), probe = this.CLIMB + 2;
        const ahead = this.wallSegAtPoint(this.px[i] + dirx * probe, this.pz[i] + dirz * probe);
        if (ahead >= 0 && ahead !== u.objSeg && !CASTLE[ahead].dead) { this.engageWall(i, u, t, ahead); return; }
        this._dir[0] = dirx; this._dir[1] = dirz; return; // clear path → march to the ordered wall
      }
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
        this._diag.engGate++;
        if (u.faction === Faction.Attacker) g.ramCrew = (g.ramCrew || 0) + 1;
        const l = dw || 1; this._dir[0] = dxw / l * 0.18; this._dir[1] = dzw / l * 0.18;
      } else if (t === UType.Cavalry) {        // horse can't scale — wait at the foot for a gap
        const l = dw || 1; this._dir[0] = dxw / l * 0.25; this._dir[1] = dzw / l * 0.25;
      } else { this._diag.engWall++; this.useLadder(i, seg); }   // scale the wall (never battered)
    } else { const l = dw || 1; this._dir[0] = dxw / l; this._dir[1] = dzw / l; } // march to its foot
  }
  // Fixed-rate gate ram: once a crew is on a gate it loses HP at RAM_DPS, no faster
  // for a mob than for a company. Run once per tick after movement has counted crews.
  // A MANNED gatehouse answers: while defenders still stand on the wall above the
  // gate, boiling oil comes down on the ram crew on a timer — silence the gatehouse
  // (archer volleys, a trebuchet, escalade) before you commit the ram, or pay in men.
  private oilCds = new Map<number, number>();
  // ---- mobile assault works (per-siege equipment): siege towers & the covered ram.
  // Pushed by the host (they need attackers alongside to move), burnable, and
  // priority targets for the wall ballistae.
  assaultWorks: { kind: 'tower' | 'ram'; x: number; z: number; hp: number; maxhp: number; state: 'advance' | 'working' | 'dead'; seg: number; ladders: number[] }[] = [];
  // Is this spot sheltered by the covered ram? (its hide roof turns arrows and oil)
  private underCover(x: number, z: number): boolean {
    for (const e of this.assaultWorks) if (e.kind === 'ram' && e.state !== 'dead' && (e.x - x) ** 2 + (e.z - z) ** 2 < 4.2 * 4.2) return true;
    return false;
  }
  private stepWorks(dt: number) {
    for (const e of this.assaultWorks) {
      if (e.state === 'dead') continue;
      if (e.hp <= 0) { e.state = 'dead'; for (const l of e.ladders) if (this.ladders[l]) this.ladders[l].dead = true; this.sfx.breaches++; continue; }
      if (e.state === 'working') {
        const g = CASTLE[e.seg];
        if (e.kind === 'ram') {
          if (!g || g.dead) { e.state = 'advance'; e.seg = -1; continue; }     // gate's down — find another (or rest)
          g.ramCrew = (g.ramCrew || 0) + RAM_CREW;                              // the ram IS a crew
          g.hp -= RAM_DPS * 0.55 * dt; g.ramT = this._frame;                    // and it hits harder than shoulders
          if (g.hp <= 0) this.breach(e.seg);
        } else if (g && g.dead) { for (const l of e.ladders) if (this.ladders[l]) this.ladders[l].dead = true; } // docked on rubble — the breach serves now
        continue;
      }
      // advancing: find the work — towers make for a standing WALL, the ram for a GATE
      if (e.seg < 0 || !CASTLE[e.seg] || CASTLE[e.seg].dead) {
        let best = -1, bd = 1e9;
        for (let s2 = 0; s2 < CASTLE.length; s2++) {
          const g = CASTLE[s2]; if (g.dead || g.kind !== (e.kind === 'ram' ? 'gate' : 'wall') || (e.kind === 'ram' && g.h <= 3)) continue;
          const cx = Math.max(g.x0, Math.min(g.x1, e.x)), cz = Math.max(g.z0, Math.min(g.z1, e.z));
          const d2 = (cx - e.x) ** 2 + (cz - e.z) ** 2; if (d2 < bd) { bd = d2; best = s2; }
        }
        e.seg = best; if (best < 0) continue; // nothing left to assault
      }
      // it only rolls while the host pushes: needs 5 attackers alongside
      let pushers = 0;
      const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((e.x - WORLD.minX) / this.hCell)));
      const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((e.z - WORLD.minZ) / this.hCell)));
      for (let rr = hr - 3; rr <= hr + 3 && pushers < 3; rr++) for (let cc = hc - 3; cc <= hc + 3 && pushers < 3; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const k = rr * this.hCols + cc, ke = this.hStart[k + 1];
        for (let bi = this.hStart[k]; bi < ke; bi++) { const j = this.hItems[bi]; if (this.fac[j] === Faction.Attacker && this.py[j] < 1 && (this.px[j] - e.x) ** 2 + (this.pz[j] - e.z) ** 2 < 14 * 14) { if (++pushers >= 3) break; } }
      }
      const g = CASTLE[e.seg];
      const cx = Math.max(g.x0, Math.min(g.x1, e.x)), cz = Math.max(g.z0, Math.min(g.z1, e.z));
      const dx = cx - e.x, dz = cz - e.z, d = Math.hypot(dx, dz);
      if (d <= T / 2 + 2.6) { // DOCK
        e.state = 'working';
        if (e.kind === 'tower') { // the ramp drops: a three-abreast permanent escalade
          const horiz = (g.x1 - g.x0) >= (g.z1 - g.z0);
          const along0 = horiz ? e.x : e.z;
          for (const off of [-2.2, 0, 2.2]) {
            const along = Math.max((horiz ? g.x0 : g.z0) + 1.2, Math.min((horiz ? g.x1 : g.z1) - 1.2, along0 + off));
            this.ladders.push({ seg: e.seg, along, bx: horiz ? along : e.x, bz: horiz ? e.z : along, horiz, outer: (horiz ? Math.sign(e.z - (g.z0 + g.z1) / 2) : Math.sign(e.x - (g.x0 + g.x1) / 2)) || 1, raise: 1 });
            e.ladders.push(this.ladders.length - 1);
          }
        }
      } else {
        // full pace with the host alongside; a grinding crawl without (it always arrives — escort makes it SOON)
        const spd = (e.kind === 'ram' ? 2.9 : 2.3) * (pushers >= 3 ? 1 : 0.45) * this.footing(e.x, e.z) * dt;
        e.x += dx / d * spd; e.z += dz / d * spd;
      }
    }
  }
  oilPours: number[] = []; // x,z pairs this frame (render: steam + scald FX)
  // incendiary ground fire: patches of burning pitch that deny the ground they cover
  burnPatches: { x: number; z: number; life: number }[] = [];
  pushT = 0; pushUsed = false; // the General's Push — once per battle
  battleT = 0; // seconds of fighting (for the field report)
  drainOilPours() { const o = this.oilPours; this.oilPours = []; return o; }
  private stepRams(dt: number) {
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s]; if (g.kind !== 'gate') continue;
      if (!g.dead && (g.ramCrew || 0) >= RAM_CREW) {
        if (g.h <= 3) { g.hp -= RAM_DPS * 1.6 * dt; g.ramT = this._frame; if (g.hp <= 0) this.breach(s); g.ramCrew = 0; continue; } // a barricade is TORN DOWN fast, no oil overhead
        g.hp -= RAM_DPS * (0.7 + 0.3 * this.atk.melee) * dt; g.ramT = this._frame; this.sfx.melee++;
        if (g.hp <= 0) { this.breach(s); continue; }
        // murder holes: timer per gate, only while the gatehouse is manned
        const cd = (this.oilCds.get(s) ?? this.cmd.oilCd * 0.5) - dt;
        if (cd <= 0) {
          const gcx = (g.x0 + g.x1) / 2, gcz = (g.z0 + g.z1) / 2;
          let manned = false;
          for (let i = 0; i < this.n && !manned; i++)
            if (this.alive[i] && this.fac[i] === Faction.Defender && this.py[i] > 4 && (this.px[i] - gcx) ** 2 + (this.pz[i] - gcz) ** 2 < 15 * 15) manned = true;
          if (manned) {
            let scalded = 0;
            for (let i = 0; i < this.n && scalded < 9; i++) {
              if (!this.alive[i] || this.fac[i] !== Faction.Attacker || this.py[i] > 2) continue;
              if ((this.px[i] - gcx) ** 2 + (this.pz[i] - gcz) ** 2 > 6 * 6) continue;
              if (this.underCover(this.px[i], this.pz[i])) continue; // sheltered under the ram's roof
              scalded++;
              const vu = this.units[this.unit[i]];
              vu.morale = Math.max(0, vu.morale - 2.5);           // scalding breaks nerve as much as skin
              this.hp[i] -= 62 * HP_SCALE * 0.5;
              if (this.hp[i] <= 0) this.kill(i, vu);
            }
            if (scalded) { this.sfx.oil++; this.oilPours.push(gcx, gcz); }
            this.oilCds.set(s, this.cmd.oilCd);
          } else this.oilCds.set(s, 1.2); // gatehouse silenced — check again shortly
        } else this.oilCds.set(s, cd);
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
  // The nearest standing ladder within reach (any section), or -1.
  private nearestLadder(x: number, z: number, maxD: number): number {
    let best = -1, bd = maxD * maxD;
    for (let l = 0; l < this.ladders.length; l++) { const L = this.ladders[l]; if (L.dead) continue; const d = (L.bx - x) ** 2 + (L.bz - z) ** 2; if (d < bd) { bd = d; best = l; } }
    return best;
  }
  private useLadder(i: number, seg = this.wallTowardGoal(i)) {
    this._diag.useLadder++;
    // A raised ladder is a fixed path: head for the NEAREST one already standing and
    // queue at its foot, rather than every man raising his own where he stands. Only
    // raise a fresh ladder if none is within reach — so they form spread along the
    // wall and the host funnels up the existing ones in order.
    let L = this.nearestLadder(this.px[i], this.pz[i], 6);
    if (L >= 0) this._diag.ladReuse++;
    else {
      if (seg < 0) { this._diag.noWall++; this._dir[0] = 0; this._dir[1] = 0; return; } // wallTowardGoal found no wall
      L = this.findOrMakeLadder(seg, i);
    }
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
        this.climbState[i] = 1; this.climbSeg[i] = lad.seg; this.climbLadder[i] = L;
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
      if (dd < 2.2 && this.cd[i] <= 0) { const dmg = (MELEE[t] || 7) * 1.4 * (u.faction === Faction.Attacker ? this.atk.melee * this.vetMul[t] : 1); this.hp[nearest] -= dmg; this.cd[i] = ATKCD[t]; if (this.hp[nearest] <= 0) { this.kill(nearest, this.units[this.unit[nearest]]); if (u.faction === Faction.Attacker) this.creditAtkKill(t); } }
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
    } else if (st === 2) {                // attacker ON the battlements
      this.py[i] = WH;
      const ci = this.climbSeg[i], seg = CASTLE[ci];
      const foeNear = nearest >= 0 && Math.abs(this.py[nearest] - WH) < 2.5
        && (this.px[nearest] - this.px[i]) ** 2 + (this.pz[nearest] - this.pz[i]) ** 2 < 5 * 5;
      if (seg && !seg.dead && foeNear) {
        // FOOTHOLD FIGHT: a defender is holding the ground right at the ladder-top — cut
        // him down before pouring past (the wall-top melee above lands the blows). Once
        // the lip is clear we descend; we don't get pinned chasing distant archers.
        const horiz = (seg.x1 - seg.x0) >= (seg.z1 - seg.z0);
        const wallPerp = horiz ? (seg.z0 + seg.z1) / 2 : (seg.x0 + seg.x1) / 2;
        const aMin = (horiz ? seg.x0 : seg.z0) + 0.5, aMax = (horiz ? seg.x1 : seg.z1) - 0.5;
        const along = Math.max(aMin, Math.min(aMax, horiz ? this.px[nearest] : this.pz[nearest]));
        this.moveXZ(i, horiz ? along : wallPerp, horiz ? wallPerp : along, 2.0 * dt);
        return;
      }
      // lip clear → climb straight DOWN the inner face where we crested. (We used to
      // traverse the wall-top to the nearest tower, which sent men "flying" in a line
      // at wall height across open ground when the tower lay past a breach.)
      this.climbState[i] = 3;
    } else if (st === 3) {                // climb down the inner face into the bailey
      // step inward toward the keep as we descend, so we land just INSIDE the wall
      // (never drifting back outside), then fight on the ground from there.
      const kdx = this.keepX - this.px[i], kdz = this.keepZ - this.pz[i], kl = Math.hypot(kdx, kdz) || 1;
      this.moveXZ(i, this.px[i] + kdx / kl * 4, this.pz[i] + kdz / kl * 4, 2.4 * dt);
      this.py[i] = Math.max(0, this.py[i] - 5.5 * dt);
      if (this.py[i] <= 0.05) { this.climbState[i] = 0; this.py[i] = 0; }
    } else {                              // st 4: defender holds the wall-top — intercept climbers
      const seg = CASTLE[this.climbSeg[i]];
      if (!seg || seg.dead) { this.climbState[i] = 0; this.py[i] = 0; return; }
      const horiz = (seg.x1 - seg.x0) >= (seg.z1 - seg.z0);
      const wallPerp = horiz ? (seg.z0 + seg.z1) / 2 : (seg.x0 + seg.x1) / 2;
      const aMin = (horiz ? seg.x0 : seg.z0) + 0.5, aMax = (horiz ? seg.x1 : seg.z1) - 0.5;
      // close on the nearest attacker who has gained the wall (meet him at the ladder-top); else hold the line
      let along = (nearest >= 0 && Math.abs(this.py[nearest] - WH) < 2.5) ? (horiz ? this.px[nearest] : this.pz[nearest]) : (horiz ? this.px[i] : this.pz[i]);
      along = Math.max(aMin, Math.min(aMax, along));
      this.moveXZ(i, horiz ? along : wallPerp, horiz ? wallPerp : along, 2.2 * dt);
    }
  }

  private shoot(i: number, target: number, dmgMul = 1) {
    this.sfx.arrows++;
    const p = this.getProj();
    const atkShot = this.fac[i] === Faction.Attacker;
    const fire = (this.units[this.unit[i]].fireArrows || (atkShot && this.atk.fire)) && this.weather !== 'rain'; // wet shafts won't take a flame
    const sx = this.px[i], sz = this.pz[i], sy = this.py[i] + 1.6;
    const tx0 = this.px[target], tz0 = this.pz[target], ty = this.py[target] + 1.0; // aim at the body, at its height
    const d = Math.hypot(tx0 - sx, tz0 - sz) || 1;
    // Spread + scatter: nudge each arrow off the exact mark (a little up close,
    // more at long range) so a volley fans across the enemies instead of every
    // shaft piling onto one man — and some fall short or wide and simply miss.
    const sc = 0.6 + d * 0.05;
    const drift = this.weather === 'wind' ? d * 0.045 : 0; // a crosswind carries every shaft eastward
    const tx = tx0 + (this.rnd() - 0.5) * 2 * sc + drift, tz = tz0 + (this.rnd() - 0.5) * 2 * sc + drift * 0.3;
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
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.ty = ty; p.fac = this.fac[i] as Faction; p.src = this.typ[i];
    let wmul = this.weather === 'rain' ? RAIN_BOW : 1;               // wet strings
    if (this.py[i] > 4) wmul *= HIGH_GROUND;                          // plunging fire from the battlements
    p.dmg = (fire ? ARCHER_PROJ_DMG * 1.7 : ARCHER_PROJ_DMG) * (atkShot ? this.aDmg(UType.Archer) * this.vetMul[this.typ[i]] : 1.25) * dmgMul * wmul; p.wall = -1; p.big = false; p.fire = fire; p.splash = 0; p.bolt = false;
    p.vx = (tx - sx) / tof; p.vz = (tz - sz) / tof; p.vy = (ty - sy) / tof + 0.5 * PROJ_G * tof; // ballistic arc to target height
  }

  // Nearest still-standing wall/gate section within a trebuchet's range.
  private nearestWall(x: number, z: number, range: number): number {
    let best = -1, bd = range * range;
    for (let s = 0; s < CASTLE.length; s++) {
      const seg = CASTLE[s];
      if (seg.dead || (seg.kind !== 'wall' && seg.kind !== 'gate') || (seg.kind === 'gate' && seg.h <= 3)) continue;
      const cx = (seg.x0 + seg.x1) / 2, cz = (seg.z0 + seg.z1) / 2;
      const d2 = (cx - x) ** 2 + (cz - z) ** 2;
      if (d2 < bd) { bd = d2; best = s; }
    }
    return best;
  }

  private lobBoulder(i: number, segIdx: number, u?: Unit) {
    this.sfx.boulders++;
    const seg = CASTLE[segIdx];
    const p = this.getProj();
    const sx = this.px[i], sz = this.pz[i], sy = 3;
    // aim at the section centre with a little scatter (siege isn't pinpoint)
    const tx = (seg.x0 + seg.x1) / 2 + (this.rnd() - 0.5) * 5, tz = (seg.z0 + seg.z1) / 2 + (this.rnd() - 0.5) * 4;
    const d = Math.hypot(tx - sx, tz - sz) || 1;
    const tof = d / BOULDER_SPEED;
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.fac = this.fac[i] as Faction; p.src = this.typ[i];
    const pot = !!(u?.firepot && this.atk.firepot);
    p.dmg = BOULDER_DMG * this.aDmg(UType.Siege) * this.vetMul[this.typ[i]] * (pot ? 0.45 : 1); p.wall = segIdx; p.big = true; p.fire = pot; p.splash = ARTY_SPLASH; p.bolt = false;
    p.vx = (tx - sx) / tof; p.vz = (tz - sz) / tof; p.vy = (0 - sy) / tof + 0.5 * PROJ_G * tof;
  }
  // Anti-personnel bombardment: a boulder onto open ground (no wall), scattering and
  // crushing whatever infantry it lands among (wider scatter than a wall shot).
  private lobBoulderAt(i: number, gx: number, gz: number, u?: Unit) {
    this.sfx.boulders++;
    const p = this.getProj();
    const sx = this.px[i], sz = this.pz[i], sy = 3;
    const tx = gx + (this.rnd() - 0.5) * 8, tz = gz + (this.rnd() - 0.5) * 8;
    const d = Math.hypot(tx - sx, tz - sz) || 1;
    const tof = d / BOULDER_SPEED;
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.fac = this.fac[i] as Faction; p.src = this.typ[i];
    const pot = !!(u?.firepot && this.atk.firepot);
    p.dmg = BOULDER_DMG * HP_SCALE * this.aDmg(UType.Siege) * this.vetMul[this.typ[i]] * (pot ? 0.6 : 1); p.wall = -1; p.big = true; p.fire = pot; p.splash = ARTY_SPLASH; p.bolt = false; // vs men: scaled to still pulp a cluster
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
    this.assignPlugs(segIdx, LAYOUT.palisade ? 1 : this.cmd.plugCompanies); // the defenders throw their reserves into the gap AT ONCE
  }

  // When a section falls, free companies re-form IN the gap — a tight, close-order
  // line just inside it that attackers must cut through, never jog past. The
  // defence director (stepDefence) keeps every open breach plugged for the whole
  // battle, replacing companies as they break, and masses the garrison against
  // attackers once they're inside in force.
  private assignPlugs(segIdx: number, n: number) {
    const g = CASTLE[segIdx];
    const gcx = (g.x0 + g.x1) / 2, gcz = (g.z0 + g.z1) / 2;
    const kx = this.keepX - gcx, kz = this.keepZ - gcz, kl = Math.hypot(kx, kz) || 1;
    const tx = gcx + kx / kl * 4, tz = gcz + kz / kl * 4;             // muster point just inside the gap
    // free = defender ground foot, holding, steady, not already committed to a gap
    const free = this.units.filter(u => u.faction === Faction.Defender && u.alive > 6 && u.hold && !u.routing
      && (u.type === UType.Light || u.type === UType.Heavy)
      && ((u.cx - tx) ** 2 + (u.cz - tz) ** 2) < 115 * 115
      && ((u.cx - this.keepX) ** 2 + (u.cz - this.keepZ) ** 2) > 30 * 30 // the keep guard never leaves the prize
      && u.plug < 0);
    free.sort((a, b) => ((a.cx - tx) ** 2 + (a.cz - tz) ** 2) - ((b.cx - tx) ** 2 + (b.cz - tz) ** 2));
    const facing = Math.atan2(gcx - this.keepX, gcz - this.keepZ);    // face outward, toward the incomers
    const gapW = Math.max(g.x1 - g.x0, g.z1 - g.z0);
    for (let k = 0; k < Math.min(n, free.length); k++) {
      const u = free[k]; u.plug = segIdx; u.tight = true;             // close order: a wall of shields in the gap
      const cols = Math.max(4, Math.min(u.alive, Math.round(gapW / (SPACING[u.type] * 0.8))));
      // ranks stack back toward the keep so the plug has DEPTH, not one thin file
      this.setAnchor(u, tx + kx / kl * k * 4.5, tz + kz / kl * k * 4.5, facing, cols);
    }
  }

  // Burning pitch denies the ground it covers — fire has no allegiance.
  private stepBurning(dt: number) {
    for (let b = this.burnPatches.length - 1; b >= 0; b--) {
      const p = this.burnPatches[b]; p.life -= dt;
      if (p.life <= 0) { this.burnPatches.splice(b, 1); continue; }
      const r = 3.6, r2 = r * r, dps = 9 * HP_SCALE * dt;
      const hc = Math.min(this.hCols - 1, Math.max(0, Math.floor((p.x - WORLD.minX) / this.hCell)));
      const hr = Math.min(this.hRows - 1, Math.max(0, Math.floor((p.z - WORLD.minZ) / this.hCell)));
      for (let rr = hr - 1; rr <= hr + 1; rr++) for (let cc = hc - 1; cc <= hc + 1; cc++) {
        if (rr < 0 || cc < 0 || rr >= this.hRows || cc >= this.hCols) continue;
        const k = rr * this.hCols + cc, ke = this.hStart[k + 1];
        for (let bi = this.hStart[k]; bi < ke; bi++) {
          const j = this.hItems[bi];
          if (!this.alive[j] || this.py[j] > 2) continue;
          if ((this.px[j] - p.x) ** 2 + (this.pz[j] - p.z) ** 2 > r2) continue;
          this.hp[j] -= dps;
          if (this.hp[j] <= 0) this.kill(j, this.units[this.unit[j]]);
        }
      }
    }
  }

  // ---- command moments ----
  // Sound the rally for one arm: broken companies steady and re-form where they
  // stand (if they aren't shattered); shaken ones find their nerve.
  rallyDiv(div: number): boolean {
    let any = false;
    for (const u of this.divCompanies(div)) {
      if (u.rallyCd > 0) continue;
      if (u.routing && u.alive / u.count >= ROUT_FRAC) {
        u.routing = false; u.shaken = true; u.morale = Math.max(u.morale, MOR_RALLY); u.rallyCd = 18; any = true;
        u.assault = false; u.objKind = 'hold'; u.objSeg = -1;
        this.setAnchor(u, u.cx, u.cz, u.facing, Math.max(3, Math.round(Math.sqrt(Math.max(1, u.alive)) * 1.4)));
      } else if (!u.routing && u.shaken) { u.morale = Math.max(u.morale, MOR_SHAKEN + 14); u.shaken = false; u.rallyCd = 12; any = true; }
    }
    return any;
  }
  // The state an arm's nerve is in — for the HUD card.
  divMoraleState(div: number): 'steady' | 'shaken' | 'routing' {
    let shaken = false, routing = false, steady = false;
    for (const u of this.divCompanies(div)) { if (u.routing) routing = true; else if (u.shaken) shaken = true; else steady = true; }
    return routing && !steady ? 'routing' : shaken || routing ? 'shaken' : 'steady';
  }
  // The General's Push — once per battle, the whole host finds its blood.
  generalsPush(): boolean {
    if (this.pushUsed || this.phase !== 'battle') return false;
    this.pushUsed = true; this.pushT = 10;
    for (const u of this.units) if (u.faction === Faction.Attacker) { u.morale = Math.min(100, u.morale + 35); u.shaken = false; }
    return true;
  }
  // Wheel an arm in place: every company pivots on its centre by delta radians
  // (facing matters now — flanks and rears bleed). No effect on storming arms.
  faceDiv(div: number, delta: number) {
    for (const u of this.divCompanies(div)) {
      if (u.type === UType.Siege || u.crewFor >= 0 || u.routing || u.assault) continue;
      this.setAnchor(u, u.cx, u.cz, u.facing + delta, u.cols);
    }
  }
  // Load (or unload) incendiaries across a trebuchet battery.
  setFirepotDiv(div: number, on: boolean) { for (const u of this.divCompanies(div)) if (u.type === UType.Siege) u.firepot = on; }
  firepotOnDiv(div: number): boolean { return this.divCompanies(div).some(u => u.type === UType.Siege && u.firepot); }

  // ---- THE DEFENCE DIRECTOR: how the castellan actually fights ----
  // Runs a few times a second. Keeps breaches plugged (always — this is the
  // default response), counter-masses the garrison against attackers who get
  // inside, and (aggressive castellans) sorties at engines left unguarded.
  private defenceCd = 0;
  private sortieCd = 45; private sortieUntil = 0; private sortieIds: number[] = [];
  private attInX = 0; private attInZ = 0; // live centroid of attackers inside the walls
  private stepDefence(dt: number) {
    this.defenceCd -= dt; if (this.defenceCd > 0) return;
    this.defenceCd = 0.7;
    // 1) every open breach stays plugged — AND every section about to give way
    //    (a gate under the ram, a wall battered under 62%) gets its plug EARLY,
    //    so the attackers burst through into a formed line, never an empty yard
    for (let s = 0; s < CASTLE.length; s++) {
      const g = CASTLE[s]; if (g.kind !== 'wall' && g.kind !== 'gate') continue;
      const threatened = !g.dead && (g.hp < g.maxhp * 0.62 || (g.ramT !== undefined && this._frame - g.ramT < 45));
      if (!g.dead && !threatened) continue;
      const barricade = g.kind === 'gate' && g.h <= 3; // a second line rates ONE company, not the whole reserve
      let assigned = 0;
      for (const u of this.units) if (u.faction === Faction.Defender && u.plug === s && u.alive > 6 && !u.routing) assigned++;
      const want = barricade || LAYOUT.palisade ? 1 : this.cmd.plugCompanies;
      if (assigned < want) this.assignPlugs(s, want - assigned);
    }
    // 1.5) the SALLY: an aggressive or cunning castellan, once a way is open,
    //      sends light companies OUT through it to burn the siege engines —
    //      picket your battery or lose it
    if ((this.cmd.kind === 'aggressive' || this.cmd.kind === 'cunning') && this.battleT > this.sortieCd) {
      if (this.sortieIds.length) { // recall when the raid has run its course
        if (this.battleT > this.sortieUntil) {
          for (const id of this.sortieIds) { const u = this.units[id]; if (u.alive > 0 && !u.routing) { this.setAnchor(u, this.keepX, this.keepZ, u.facing, u.cols); } }
          this.sortieIds = []; this.sortieCd = this.battleT + 55;
        }
      } else {
        const open = CASTLE.some(g => g.dead && (g.kind === 'wall' || g.kind === 'gate'));
        // the prize: the nearest living siege engine or assault work
        let tx = 0, tz = 0, found = false;
        for (const e of this.assaultWorks) if (e.state !== 'dead') { tx = e.x; tz = e.z; found = true; break; }
        if (!found) for (const u of this.units) if (u.faction === Faction.Attacker && u.type === UType.Siege && u.alive > 0) { tx = u.cx; tz = u.cz; found = true; break; }
        if (open && found) {
          const party = this.units.filter(u => u.faction === Faction.Defender && u.type === UType.Light && u.hold && !u.routing && u.plug < 0 && u.alive > 12).slice(0, 2);
          if (party.length) {
            for (const u of party) { this.setAnchor(u, tx, tz, Math.atan2(tx - u.cx, tz - u.cz), Math.max(4, Math.round(Math.sqrt(u.alive) * 1.4))); this.sortieIds.push(u.id); }
            this.sortieUntil = this.battleT + 26;
          } else this.sortieCd = this.battleT + 30;
        } else this.sortieCd = this.battleT + 15;
      }
    }
    // 2) attackers inside in force → mass the free garrison onto their centroid
    //    (the breach fight the player has to win, not walk past)
    if (this.attInsideCount > 20) {
      const cx = this.attInX, cz = this.attInZ;
      const responders = this.units.filter(u => u.faction === Faction.Defender && u.alive > 8 && u.hold && !u.routing
        && (u.type === UType.Heavy || u.type === UType.Light) && u.plug < 0 && this.py[u.s0] < 2
        && ((u.cx - cx) ** 2 + (u.cz - cz) ** 2) < 130 * 130
        && ((u.cx - this.keepX) ** 2 + (u.cz - this.keepZ) ** 2) > 30 * 30); // the keep guard never leaves the prize
      responders.sort((a, b) => ((a.cx - cx) ** 2 + (a.cz - cz) ** 2) - ((b.cx - cx) ** 2 + (b.cz - cz) ** 2));
      const nResp = Math.min(responders.length, Math.ceil(this.attInsideCount / 28) + 1);
      const facing = Math.atan2(cx - this.keepX, cz - this.keepZ);
      for (let k = 0; k < nResp; k++) {
        const u = responders[k];
        this.setAnchor(u, cx, cz, facing, Math.max(4, Math.round(Math.sqrt(u.alive) * 1.4)));
      }
    }
  }

  private getProj(): Projectile {
    for (const p of this.projectiles) if (!p.active) return p;
    const p: Projectile = { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, tz: 0, ty: 0, dmg: 0, fac: 0, src: -1, wall: -1, big: false, fire: false, splash: 0, bolt: false };
    this.projectiles.push(p); return p;
  }
  // Anti-personnel blast: the man at the point of impact is killed outright; a
  // very small radius around him takes a fraction (so it's a precise strike, not
  // a fireball). Trebuchets won't friendly-fire (skips its own faction).
  // Apply a ranged hit, with SHIELDS for ground attackers: a storming column raises
  // shields against the plunging fire from the walls, so an assault isn't simply
  // annihilated crossing the killing ground before it can force an entry. (Melee is
  // unaffected — this only blunts arrows and bolts, and only for attackers on foot.)
  private applyRangedHit(j: number, dmg: number, bolt: boolean, fire = false) {
    if (this.fac[j] === Faction.Attacker && this.py[j] < 2.5) dmg *= bolt ? 0.68 : 0.5;
    if (this.fac[j] === Faction.Attacker && this.py[j] < 2.5 && this.underCover(this.px[j], this.pz[j])) dmg *= 0.45; // the ram's hide roof over them
    if (fire && this.typ[j] === UType.Siege) dmg *= 3; // timber engines BURN under flaming shafts
    dmg *= this.defenseMul(j); // a shield wall turns arrows too
    this.hp[j] -= dmg;
    if (this.hp[j] <= 0) { this.kill(j, this.units[this.unit[j]]); if (this._shotCredit >= 0) this.creditAtkKill(this._shotCredit); }
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
  private fireBolt(e: Emplacement, target: number) { this.fireBoltXY(e, this.px[target], this.pz[target]); }
  private fireBoltXY(e: Emplacement, gx: number, gz: number) {
    this.sfx.bolts++;
    const p = this.getProj();
    const sx = e.x, sz = e.z, sy = e.y + 1.2;
    const d0 = Math.hypot(gx - sx, gz - sz) || 1;
    // a tiny bit of scatter so a ballista doesn't snipe a man with every bolt
    const sc = 0.8 + d0 * 0.03;
    const tx = gx + (this.rnd() - 0.5) * 2 * sc, tz = gz + (this.rnd() - 0.5) * 2 * sc, ty = 1;
    const d = Math.hypot(tx - sx, tz - sz) || 1, tof = d / BOLT_SPEED;
    p.active = true; p.x = sx; p.y = sy; p.z = sz; p.tx = tx; p.tz = tz; p.ty = ty; p.fac = Faction.Defender; p.src = -1;
    p.dmg = BALLISTA_DMG; p.wall = -1; p.big = false; p.fire = false; p.bolt = true; p.splash = ARTY_SPLASH;
    p.vx = (tx - sx) / tof; p.vz = (tz - sz) / tof; p.vy = (ty - sy) / tof + 0.5 * PROJ_G * tof;
    e.aimX = tx; e.aimZ = tz;
  }
  // A ballista fires only while a living crewman stands at it — cut the crew
  // down (wall-top escalade!) and the engine falls silent for the battle.
  ballistaManned(e: Emplacement): boolean {
    const cu = this.ballistaCrewUnit; if (!cu) return true; // no crew unit (palisade towns) — legacy behaviour
    for (let i = cu.s0; i < cu.s0 + cu.count; i++) {
      if (!this.alive[i]) continue;
      if ((this.px[i] - e.x) ** 2 + (this.pz[i] - e.z) ** 2 < 6 * 6) return true;
    }
    return false;
  }
  private ballistaCrewUnit: Unit | null = null;
  // Each trebuchet needs two living engineers: crews die (arrows, sorties) and
  // their engines stand idle — protect the battery or it goes silent.
  private crewCache = new Map<number, Unit | null>();
  private engineCrewed(u: Unit, i: number): boolean {
    let cu = this.crewCache.get(u.id);
    if (cu === undefined) { cu = this.units.find(v => v.crewFor === u.id) ?? null; this.crewCache.set(u.id, cu); }
    if (!cu) return true; // no crew attached (legacy/defender engines)
    const operable = Math.floor(cu.alive / 2);
    if (operable <= 0) return false;
    let rank = 0; for (let k = u.s0; k < i; k++) if (this.alive[k]) rank++; // engines are crewed in file order
    return rank < operable;
  }
  private stepBallistae(dt: number) {
    for (const e of this.ballistae) {
      if (CASTLE[e.seg].dead) continue;          // wall breached -> engine destroyed
      if (e.recoil > 0) e.recoil = Math.max(0, e.recoil - dt);
      e.cd -= dt; if (e.cd > 0) continue;
      if (!this.ballistaManned(e)) { e.cd = 1.2; continue; } // crew dead — the engine stands idle
      { // an approaching tower or ram is the deadliest thing on the field — shoot IT first
        let bw = -1, bwd = BALLISTA_RANGE * BALLISTA_RANGE;
        for (let w = 0; w < this.assaultWorks.length; w++) {
          const aw = this.assaultWorks[w]; if (aw.state === 'dead') continue;
          const d2 = (aw.x - e.x) ** 2 + (aw.z - e.z) ** 2; if (d2 < bwd) { bwd = d2; bw = w; }
        }
        if (bw >= 0) {
          const aw = this.assaultWorks[bw];
          if (!pathBlocked(e.x + (aw.x - e.x) * 0.6, e.z + (aw.z - e.z) * 0.6, aw.x, aw.z)) { this.fireBoltXY(e, aw.x, aw.z); e.cd = BALLISTA_CD; e.recoil = 0.45; continue; }
        }
      }
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
      // bolts obey line-of-sight too: elevated shooter, so only cover hugging the target blocks
      if (best >= 0 && !pathBlocked(e.x + (this.px[best] - e.x) * 0.6, e.z + (this.pz[best] - e.z) * 0.6, this.px[best], this.pz[best])) { this.fireBolt(e, best); e.cd = BALLISTA_CD; e.recoil = 0.45; }
      else e.cd = 0.6; // nothing in range (or no clear shot) — look again shortly
    }
  }
  private stepProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.vy -= PROJ_G * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const dxz = Math.hypot(p.x - p.tx, p.z - p.tz);
      if (p.y <= 0 || dxz < 1.4) {
        this._shotCredit = p.fac === Faction.Attacker ? p.src : -1; // credit this shot's felling blows to the arm that loosed it
        if (p.fac === Faction.Defender) for (const e of this.assaultWorks) { // shafts and bolts falling on the assault works
          if (e.state === 'dead') continue;
          if ((e.x - p.x) ** 2 + (e.z - p.z) ** 2 < 2.6 * 2.6) { e.hp -= p.dmg * (p.fire ? 3 : 1) * (p.bolt ? 1.2 : 0.5); break; }
        }
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
          if (best >= 0) this.applyRangedHit(best, p.dmg, false, p.fire);
        }
        this._shotCredit = -1;
        if (p.fire && this.fireLands.length < 24) this.fireLands.push(p.x, p.z); // a burning shaft came down
        if (p.fire && p.big) this.burnPatches.push({ x: p.x, z: p.z, life: 7 * (this.atk.burnMul ?? 1) * (this.weather === 'rain' ? 0.4 : 1) }); // an incendiary pot shatters into burning pitch (rain drowns it fast)
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
      else if (!u.routing && u.type !== UType.Siege && u.crewFor < 0) attActive += u.alive; // engines & their crews alone can't carry an assault
    }
    const defFrac = defAlive / Math.max(1, this.defenderAliveStart);
    if (this.captureProgress >= 1 || defFrac <= 0.1) { this.phase = 'over'; this.winner = Faction.Attacker; }
    else if (attActive === 0) { this.phase = 'over'; this.winner = Faction.Defender; }
  }
  // Sound the retreat — end now; survivors are saved, the castle stands.
  retreat() { if (this.phase === 'battle') { this.phase = 'over'; this.winner = Faction.Defender; this.retreated = true; } }
  // Attacker soldiers by unit type — committed (spawned) vs still alive.
  // NOTE: engine crews (crewFor >= 0) are battery equipment, not the standing army —
  // counting them here once let crew casualties wipe the player's SAVED light infantry.
  attackerSpawned(): number[] { const a = [0, 0, 0, 0, 0]; for (const u of this.units) if (u.faction === Faction.Attacker && u.crewFor < 0) a[u.type] += u.count; return a; }
  attackerAlive(): number[] { const a = [0, 0, 0, 0, 0]; for (const u of this.units) if (u.faction === Faction.Attacker && u.crewFor < 0) a[u.type] += u.alive; return a; }

  // aggregate counts for HUD
  countAlive(faction: Faction): number { let n = 0; for (const u of this.units) if (u.faction === faction) n += u.alive; return n; }
  playerUnits(): Unit[] { return this.units.filter(u => u.faction === Faction.Attacker); }
}
