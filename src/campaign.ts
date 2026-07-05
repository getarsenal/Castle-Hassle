// Campaign data + saved progress. The map view itself lives in worldmap3d.ts.
import { REAL_CASTLES } from './castles';
import type { CastleStyle } from './sim';

export interface CampaignCastle { id: number; name: string; region: string; lat: number; lon: number; seed: number; tier: number; style: CastleStyle; }

// Hand-tuned architecture for the famous castles, so each is recognisable by its
// real-life signature: Krak's concentric crusader rings, Carcassonne's walled
// town of round towers, Caernarfon's polygonal-tower town, Dover's double
// baileys, Château Gaillard's compact spur keep, Castel del Monte's tight
// octagon, etc. Everything not listed falls back to a deterministic style below.
const NAMED: Record<string, Partial<CastleStyle>> = {
  'Krak des Chevaliers': { concentric: true, round: true, strongKeep: true, scale: 1.3, aspect: 1.1, town: 0.3 , form: 'crag'},
  'Margat':              { concentric: true, round: true, strongKeep: true, scale: 1.2, town: 0.35 , form: 'crag'},
  'Dover':               { concentric: true, round: false, strongKeep: true, scale: 1.35, aspect: 1.2, town: 0.55 , form: 'bastion'},
  'Caerphilly':          { concentric: true, round: true, scale: 1.3, aspect: 1.5, town: 0.4 , form: 'bastion'},
  'Harlech':             { concentric: true, round: true, scale: 1.0, aspect: 1.0, town: 0.3 , form: 'shell'},
  'Beaufort':            { concentric: true, round: true, strongKeep: true, scale: 0.95, town: 0.25 , form: 'crag'},
  'Château Gaillard':    { concentric: true, round: true, scale: 0.95, aspect: 1.1, town: 0.25 , form: 'crag'},
  'Carcassonne':         { concentric: true, round: true, scale: 1.3, aspect: 1.6, town: 0.85 , form: 'sprawl'},
  'Caernarfon':          { round: true, strongKeep: true, scale: 1.3, aspect: 1.7, town: 0.8 , form: 'sprawl'},
  'Conwy':               { round: true, scale: 1.15, aspect: 1.6, town: 0.85 , form: 'sprawl'},
  'Coucy':               { round: true, strongKeep: true, scale: 1.15, aspect: 1.0, town: 0.4 , form: 'bastion'},
  'Pembroke':            { round: true, strongKeep: true, scale: 1.0, town: 0.45 , form: 'crag'},
  'Pierrefonds':         { round: true, strongKeep: true, scale: 1.1, town: 0.4 , form: 'bastion'},
  'Rochester':           { round: false, strongKeep: true, scale: 0.85, aspect: 1.0, town: 0.35 , form: 'bastion'},
  'Windsor':             { round: true, strongKeep: true, scale: 1.2, aspect: 1.4, town: 0.7 , form: 'sprawl'},
  'Rhodes':              { concentric: true, round: true, scale: 1.35, aspect: 1.5, town: 0.85 , form: 'sprawl'},
  'Acre':                { round: true, scale: 1.35, aspect: 1.6, town: 0.9 , form: 'sprawl'},
  'Salzburg':            { strongKeep: true, round: false, scale: 1.1, town: 0.6 , form: 'crag'},
  'Castel del Monte':    { round: true, strongKeep: true, scale: 0.78, aspect: 1.0, town: 0.15 , form: 'shell'},
  'Jerusalem':           { round: false, strongKeep: true, scale: 1.4, aspect: 1.5, town: 0.9 , form: 'sprawl'},
  'Constantinople':      { concentric: true, round: true, scale: 1.4, aspect: 1.7, town: 0.9 , form: 'sprawl'},
};

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// A deterministic style per castle: varies by a name hash so neighbours differ,
// trends bigger/concentric later in the campaign, and leans on regional habits
// (round drum towers in France & the crusader states, square keeps in England),
// then any famous-castle override is layered on top.
export function styleFor(name: string, region: string, tier: number, seed: number): CastleStyle {
  const h = hashStr(name + ':' + seed);
  const u = (shift: number) => ((h >>> shift) & 0xff) / 255;
  const east = region === 'France' || region === 'The Holy Land' || region === 'Anatolia';
  // grows markedly toward Jerusalem; a non-square footprint on a good share of them
  const sh = u(12);
  const base: CastleStyle = {
    scale: Math.min(1.75, 0.9 + tier * 0.66 + u(0) * 0.16),
    aspect: 1 + u(8) * 0.6,
    concentric: u(16) < 0.14 + tier * 0.16,
    round: ((h >> 7) & 1) === 1 || east,
    strongKeep: u(24) < 0.42,
    town: 0.45 + u(4) * 0.3,
    shape: sh < 0.28 ? 'barbican' : sh < 0.46 ? 'twin' : 'rect',
  };
  return { ...base, ...(NAMED[name] || {}) };
}

// A marching distance in degrees (longitude shrunk toward the pole a little).
const marchDist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), a.lat - b.lat);

export function generateCastles(): CampaignCastle[] {
  // The crusade marches region by region (the authored region order), but WITHIN
  // each region the sieges are chained nearest-first from wherever the host last
  // stood — so the route reads as one army pressing on, never doubling back
  // across a country it has already crossed.
  type Row = { name: string; region: string; lat: number; lon: number };
  const rows: Row[] = REAL_CASTLES.map(([name, region, lat, lon]) => ({ name, region, lat, lon }));
  const finale = rows[rows.length - 1];                 // the authored last siege (Jerusalem) stays the campaign's end
  const regionOrder: string[] = []; const byRegion = new Map<string, Row[]>();
  for (const r of rows) { if (r === finale) continue; if (!byRegion.has(r.region)) { byRegion.set(r.region, []); regionOrder.push(r.region); } byRegion.get(r.region)!.push(r); }
  const ordered: Row[] = [];
  let cursor: Row | null = null;
  for (const reg of regionOrder) {
    const pool = [...byRegion.get(reg)!];
    // the first region keeps its authored opening siege (the campaign's first step)
    const start = cursor ? pool.reduce((b, r) => marchDist(r, cursor!) < marchDist(b, cursor!) ? r : b, pool[0]) : pool[0];
    const chain: Row[] = [start]; pool.splice(pool.indexOf(start), 1);
    while (pool.length) { const cur = chain[chain.length - 1]; const nxt = pool.reduce((b, r) => marchDist(r, cur) < marchDist(b, cur) ? r : b, pool[0]); chain.push(nxt); pool.splice(pool.indexOf(nxt), 1); }
    // 2-opt: untwist the greedy chain (fixed start, free end) until no reversal
    // of any middle stretch shortens the march — kills the doubling-back loops
    for (let improved = true; improved;) {
      improved = false;
      for (let i = 1; i < chain.length - 1; i++) for (let j = i + 1; j < chain.length; j++) {
        const before = marchDist(chain[i - 1], chain[i]) + (j + 1 < chain.length ? marchDist(chain[j], chain[j + 1]) : 0);
        const after = marchDist(chain[i - 1], chain[j]) + (j + 1 < chain.length ? marchDist(chain[i], chain[j + 1]) : 0);
        if (after < before - 1e-9) { let a = i, b = j; while (a < b) { const t = chain[a]; chain[a] = chain[b]; chain[b] = t; a++; b--; } improved = true; }
      }
    }
    ordered.push(...chain);
    cursor = ordered[ordered.length - 1];
  }
  ordered.push(finale);
  const n = ordered.length;
  return ordered.map((r, i) => {
    const seed = 1000 + i * 7919, tier = n > 1 ? i / (n - 1) : 0;
    return { id: i, name: r.name, region: r.region, lat: r.lat, lon: r.lon, seed, tier, style: styleFor(r.name, r.region, tier, seed) };
  });
}

// ---- the persistent, gold-funded army ----
export interface Army { heavy: number; light: number; archer: number; cavalry: number; siege: number; }
export type ArmyKey = keyof Army;
export const ARMY_KEYS: ArmyKey[] = ['heavy', 'light', 'archer', 'cavalry', 'siege'];
// You start as a minor lord with a small founding warband — enough to raid with,
// not to storm a great castle. The campaign is about BUILDING the host: raid for
// coin, recruit, and watch your banner swell. (Tuned against the dev balance readout.)
export const STARTING_ARMY: Army = { heavy: 300, light: 220, archer: 260, cavalry: 100, siege: 4 };
export const STARTING_GOLD = 300;
// gold to raise one soldier / engine of each kind. Tiered so a purchase carries
// weight: light foot are cheap fodder, archers and horse sit in the middle, and
// the heavy men-at-arms and the great siege engines are the big-ticket buys you
// save up for — so kitting out a wall-breaking battery or a wall of plate feels
// like a real investment.
export const RECRUIT_COST: Army = { heavy: 1.4, light: 0.35, archer: 0.7, cavalry: 1.0, siege: 200 };
// you can always field a free peasant levy of this many light foot, so a wiped
// army never softlocks the campaign — but they're conscript fodder.
export const LEVY_LIGHT = 250;

// ---- veterancy: each ARM (not each man) is a standing corps that earns honours ----
// Castle Hassle has no persistent identity below the arm, so the arm is what ranks
// up: every battle an arm fights feeds it experience (men it fells, blood shed,
// fields won), and as that experience mounts the whole corps grows hardier and
// deadlier. One rank lifts both vigour and bite a little, so a long-served arm is
// meaningfully better than a freshly-raised one without eclipsing the War Council.
export interface Vet { xp: number; battles: number; kills: number; }
export type VetRoll = Record<ArmyKey, Vet>;
export const freshVet = (): VetRoll => ({ heavy: z(), light: z(), archer: z(), cavalry: z(), siege: z() });
function z(): Vet { return { xp: 0, battles: 0, kills: 0 }; }
// cumulative XP for each rank, lowest → highest. Five grades.
export const RANK_XP = [0, 150, 450, 1000, 2000];
export const RANK_TITLES = ['Raw Levy', 'Blooded', 'Seasoned', 'Veteran', 'Legendary'];
export function vetRank(xp: number): number { let r = 0; for (let i = 0; i < RANK_XP.length; i++) if (xp >= RANK_XP[i]) r = i; return r; }
// the combat edge a rank confers — applied to the arm's vigour AND its bite/sting.
export function vetMultiplier(rank: number): number { return 1 + 0.05 * rank; }
// progress (0..1) toward the next rank, and the XP span of the current band.
export function vetProgress(xp: number): { rank: number; frac: number; cur: number; next: number | null } {
  const rank = vetRank(xp), cur = RANK_XP[rank], next = rank + 1 < RANK_XP.length ? RANK_XP[rank + 1] : null;
  return { rank, cur, next, frac: next === null ? 1 : Math.max(0, Math.min(1, (xp - cur) / (next - cur))) };
}
// XP an arm earns from a single battle. Only an arm that actually fought (engaged)
// earns anything — kills are the bulk of it, with a modest bonus for taking the
// field and seeing the day won; an arm left in reserve earns nothing.
export function battleXP(opts: { engaged: boolean; kills: number; survivalRate: number; won: boolean }): number {
  if (!opts.engaged) return 0;
  return Math.round(10 + opts.kills + (opts.won ? 25 : 0) + opts.survivalRate * 15);
}

export interface Progress { unlocked: number; completed: number[]; gold: number; upg: Record<string, number>; army: Army; vet: VetRoll; started?: number; name?: string; }

// ---- save slots: several independent campaigns, plus the single lifetime profile ----
export const NUM_SLOTS = 3;
const SLOT_KEY = (n: number) => `castlehassle.slot${n}.v1`;
const LEGACY_KEY = 'castlehassle.campaign.v1';
let activeSlot = 0;
export function setActiveSlot(n: number) { activeSlot = Math.max(0, Math.min(NUM_SLOTS - 1, n | 0)); }
export function getActiveSlot() { return activeSlot; }

// a name for the commander of the crusade — rolled at campaign start, editable there
const GENERAL_FIRST = ['Baldwin', 'Godfrey', 'Raymond', 'Tancred', 'Bohemond', 'Roger', 'Fulk', 'Hugh', 'Stephen', 'Robert', 'Eleanor', 'Matilda', 'Isabella', 'Adela', 'Sibylla'];
const GENERAL_EPITHET = ['the Bold', 'of the March', 'Ironhand', 'the Pious', 'the Lion', 'the Unbowed', 'of the Long Road', 'the Stern', 'Greymantle', 'the Younger', 'the Steadfast', 'of the Broken Tower'];
export function rollGeneralName(): string {
  return `${GENERAL_FIRST[Math.floor(Math.random() * GENERAL_FIRST.length)]} ${GENERAL_EPITHET[Math.floor(Math.random() * GENERAL_EPITHET.length)]}`;
}
// the rival whose slander sets the whole crusade in motion — named at campaign start
const RIVAL_FIRST = ['Guy', 'Reynald', 'Amaury', 'Gilbert', 'Warin', 'Osbert', 'Rufus', 'Drogo', 'Aldous', 'Ivo'];
const RIVAL_HOLD = ['de Mortain', 'of Ashford', 'de Nogent', 'of Blackmoor', 'de Craon', 'of Thornbury', 'de Lusignan', 'of Greywater', 'de Rançon', 'of Coldharbour'];
export function rollRivalName(): string {
  return `${RIVAL_FIRST[Math.floor(Math.random() * RIVAL_FIRST.length)]} ${RIVAL_HOLD[Math.floor(Math.random() * RIVAL_HOLD.length)]}`;
}
export function freshProgress(): Progress { return { unlocked: 0, completed: [], gold: STARTING_GOLD, upg: {}, army: { ...STARTING_ARMY }, vet: freshVet() }; }
// bring any saved blob up to the current shape (army/vet added over the campaign)
function normalize(p: any): Progress | null {
  if (!p || typeof p.unlocked !== 'number') return null;
  return {
    unlocked: p.unlocked, completed: p.completed || [], gold: typeof p.gold === 'number' ? p.gold : STARTING_GOLD,
    upg: p.upg || {}, army: { ...STARTING_ARMY, ...(p.army || {}) }, vet: { ...freshVet(), ...(p.vet || {}) }, started: p.started, name: typeof p.name === 'string' ? p.name : undefined,
  };
}
function rawSlot(n: number): Progress | null {
  try { const s = localStorage.getItem(SLOT_KEY(n)); if (s) return normalize(JSON.parse(s)); } catch { /* ignore */ }
  // one-time migration: the old single save becomes slot 0
  if (n === 0) { try { const s = localStorage.getItem(LEGACY_KEY); if (s) { localStorage.setItem(SLOT_KEY(0), s); return normalize(JSON.parse(s)); } } catch { /* ignore */ } }
  return null;
}
// load the ACTIVE slot (used throughout the game); empty slot → a fresh campaign
export function loadProgress(): Progress { return rawSlot(activeSlot) || freshProgress(); }
export function saveProgress(p: Progress) { try { localStorage.setItem(SLOT_KEY(activeSlot), JSON.stringify(p)); } catch { /* ignore */ } }
export function slotExists(n: number): boolean { return !!rawSlot(n); }
export function deleteSlot(n: number) { try { localStorage.removeItem(SLOT_KEY(n)); if (n === 0) localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ } }
// a compact summary for the slot-select menu (null if the slot is empty)
export interface SlotSummary { slot: number; realm: string; taken: number; total: number; gold: number; men: number; won: boolean; }
export function slotSummary(n: number, castles: CampaignCastle[]): SlotSummary | null {
  const p = rawSlot(n); if (!p) return null;
  const cc = currentCountry(p, castles);
  const men = p.army.heavy + p.army.light + p.army.archer + p.army.cavalry;
  const won = p.completed.length >= castles.length;
  return { slot: n, realm: won ? 'Crusade won' : cc.name, taken: p.completed.length, total: castles.length, gold: p.gold, men, won };
}
// recruitment price, with the Quartermaster discount applied
export function recruitPrice(key: ArmyKey, n: number, discount: number): number { return Math.ceil(RECRUIT_COST[key] * n * discount); }

// (The castle info card's garrison count now comes from sim.surveyCastle(), which
// shares the exact order-of-battle the siege spawns — so the card can't drift from
// the real fight the way the old style-only estimate did.)

// The difficulty multiplier a castle fights at, by campaign position (tier 0→1).
// A steep ramp: the first holds are small garrisons a founding warband can storm,
// the crusader fortresses many times larger — so the campaign is about GROWING the
// host, not steamrolling with your starting army. Drives garrison size, archer
// damage and keep guard in the sim (and the map card / balance readout).
// global difficulty-mode scalars (Squire/Knight/Warlord), set from the profile
let diffGarrison = 1, diffReward = 1;
export function setDifficultyScalars(garrison: number, reward: number) { diffGarrison = garrison; diffReward = reward; }
export function castleDifficulty(tier: number): number { return (0.45 + tier * 1.75) * diffGarrison; }

// Gold awarded for taking a castle — scales with how late/hard it is (and the mode).
export function goldReward(tier: number): number { return Math.round((160 + 560 * tier) * diffReward); }

// ---- Siege scenery: which biome surrounds the battlefield, and is it on a coast ----
// Drives the battle map's horizon (hills/mountains/dunes), ground tint and sky so a
// siege LOOKS like where it is on the campaign map.
export type Biome = 'britain' | 'france' | 'alpine' | 'med' | 'desert';
export function biomeFor(region: string): Biome {
  switch (region) {
    case 'France': return 'france';
    case 'The Empire': return 'alpine';     // Rhine/Alps: green valleys under snowy peaks
    case 'Italy': case 'Byzantium': case 'Anatolia': return 'med';  // dry golden hills, cypress
    case 'The Holy Land': return 'desert';  // sand, dunes, palms
    default: return 'britain';              // Wales / England — lush green hills
  }
}
// The genuinely sea-girt strongholds — they get an ocean flank behind the castle.
const COASTAL_CASTLES = new Set(['Caernarfon', 'Conwy', 'Harlech', 'Dover', 'Rhodes', 'Acre']);
export function isCoastal(name: string): boolean { return COASTAL_CASTLES.has(name); }

// ---- The Crusade: a country-by-country campaign to Jerusalem ----
// The realms are crossed west→east in order. Each is its own chapter with its
// own character of war, and CONQUERING one (taking every stronghold in it)
// earns a permanent boon that joins your host — so the army you lead into the
// Holy Land is forged by everything you broke to get there.
export interface CountryBoon { hp?: number; melee?: number; archer?: number; siege?: number; trebs?: number; gold?: number; }
export interface Country { key: string; name: string; twist: string; boonLabel: string; boonDesc: string; boon: CountryBoon; }
export const COUNTRIES: Country[] = [
  { key: 'Wales', name: 'Wales', twist: 'High keeps on the crags — small garrisons, but tall walls to scale.',
    boonLabel: 'Welsh Longbowmen', boonDesc: 'Archers strike harder', boon: { archer: 0.15 } },
  { key: 'England', name: 'England', twist: 'Textbook concentric stone. Learn the siege here.',
    boonLabel: "King's Treasury", boonDesc: '+300 gold and hardier troops', boon: { hp: 0.06, gold: 300 } },
  { key: 'France', name: 'France', twist: 'Norman knights sally out — the open field is as much theirs as the wall.',
    boonLabel: 'Norman Destriers', boonDesc: 'Your men-at-arms hit harder', boon: { melee: 0.10 } },
  { key: 'The Empire', name: 'The Empire', twist: 'Rhine fortresses, thick and high. Bring engines.',
    boonLabel: 'Imperial Engineers', boonDesc: 'Stronger siege + a free trebuchet', boon: { siege: 0.22, trebs: 1 } },
  { key: 'Italy', name: 'Italy', twist: 'City-states behind twin walls, crossbows on every parapet.',
    boonLabel: 'Genoese Crossbows', boonDesc: 'Archers strike harder still', boon: { archer: 0.15 } },
  { key: 'Byzantium', name: 'Byzantium', twist: 'Sea-girt strongholds and the dread of Greek fire.',
    boonLabel: 'Varangian Guard', boonDesc: 'Heavy foot — harder, hardier', boon: { melee: 0.10, hp: 0.06 } },
  { key: 'Anatolia', name: 'Anatolia', twist: 'Seljuk horse-archers harry the long march across the plateau.',
    boonLabel: 'Turcopole Outriders', boonDesc: 'Your charge bites deeper', boon: { melee: 0.08 } },
  { key: 'The Holy Land', name: 'The Holy Land', twist: 'Crusader fortresses — the hardest walls on earth — and, at their heart, Jerusalem.',
    boonLabel: 'Jerusalem', boonDesc: 'The Holy City', boon: {} },
];
export function countryIndex(region: string): number { const i = COUNTRIES.findIndex(c => c.key === region); return i < 0 ? 99 : i; }

export interface CountryStatus extends Country { idx: number; total: number; taken: number; conquered: boolean; ids: number[]; }
// Per-country tally of strongholds taken, in campaign order.
export function countriesWithStatus(progress: Progress, castles: CampaignCastle[]): CountryStatus[] {
  return COUNTRIES.map((c, idx) => {
    const ids = castles.filter(x => x.region === c.key).map(x => x.id);
    const taken = ids.filter(id => progress.completed.includes(id)).length;
    return { ...c, idx, ids, total: ids.length, taken, conquered: ids.length > 0 && taken === ids.length };
  });
}
// The realm currently being fought through (first not-yet-conquered), or the last.
export function currentCountry(progress: Progress, castles: CampaignCastle[]): CountryStatus {
  const cs = countriesWithStatus(progress, castles);
  return cs.find(c => !c.conquered) || cs[cs.length - 1];
}
// Sum of the boons from every realm already conquered — folded into the war buff.
export function countryBoons(progress: Progress, castles: CampaignCastle[]): Required<Omit<CountryBoon, 'gold'>> {
  const acc = { hp: 0, melee: 0, archer: 0, siege: 0, trebs: 0 };
  for (const c of countriesWithStatus(progress, castles)) if (c.conquered) {
    acc.hp += c.boon.hp || 0; acc.melee += c.boon.melee || 0; acc.archer += c.boon.archer || 0;
    acc.siege += c.boon.siege || 0; acc.trebs += c.boon.trebs || 0;
  }
  return acc;
}
// If taking `castleId` just completed its realm, return that Country (else null).
// Call AFTER pushing castleId into progress.completed.
export function countryJustConquered(castleId: number, progress: Progress, castles: CampaignCastle[]): CountryStatus | null {
  const c = castles.find(x => x.id === castleId); if (!c) return null;
  const st = countriesWithStatus(progress, castles).find(s => s.key === c.region);
  return st && st.conquered ? st : null;
}

// ---- Raids: optional, repeatable side-battles to fund the army ----
// Smaller, weaker holdings you can choose to storm for gold. They cost you the
// same permanent casualties as a siege, so they're a risk/reward grind, not a
// free purse — but a careful raider can fatten the war chest before a hard siege.
export interface Raid { id: number; name: string; blurb: string; difficulty: number; reward: number; seedBase: number; style: CastleStyle; }
// A risk/reward ladder that sits BELOW the castles: each raid is a lighter fight
// than a siege of the same era but pays real silver, so raiding is how a small
// warband funds its growth. Rewards are generous — a couple of raids should buy a
// meaningful block of troops.
export function generateRaids(): Raid[] {
  return [
    // A rising ladder: difficulty ASCENDS with the reward, so the listed
    // resistance always matches the fight the player actually gets.
    { id: 0, name: 'Bandit Stockade', difficulty: 0.40, reward: 140, seedBase: 50101,
      blurb: 'A village behind a low timber stockade — no stone, no towers, just a brigand militia. Send in your foot and take it. (No siege train needed.)',
      style: { scale: 0.66, aspect: 1.25, concentric: false, round: false, strongKeep: false, town: 0.32, shape: 'rect', palisade: true } },
    { id: 1, name: "Rival Baron's Keep", difficulty: 0.55, reward: 280, seedBase: 50102,
      blurb: 'A minor lord who will not bend the knee. Break his keep and take his silver.',
      style: { scale: 0.72, aspect: 1.1, concentric: false, round: true, strongKeep: true, town: 0.2, shape: 'rect' } },
    { id: 2, name: 'Fortified Caravanserai', difficulty: 0.72, reward: 480, seedBase: 50103,
      blurb: 'A walled trading post heavy with silver — and the hired guards to match.',
      style: { scale: 0.82, aspect: 1.3, concentric: false, round: true, strongKeep: false, town: 0.45, shape: 'twin' } },
  ];
}
export function raidResistance(d: number): string { return d < 0.48 ? 'Light' : d < 0.65 ? 'Moderate' : 'Heavy'; }
