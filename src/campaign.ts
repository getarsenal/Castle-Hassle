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
  'Krak des Chevaliers': { concentric: true, round: true, strongKeep: true, scale: 1.3, aspect: 1.1, town: 0.3 },
  'Margat':              { concentric: true, round: true, strongKeep: true, scale: 1.2, town: 0.35 },
  'Dover':               { concentric: true, round: false, strongKeep: true, scale: 1.35, aspect: 1.2, town: 0.55 },
  'Caerphilly':          { concentric: true, round: true, scale: 1.3, aspect: 1.5, town: 0.4 },
  'Harlech':             { concentric: true, round: true, scale: 1.0, aspect: 1.0, town: 0.3 },
  'Beaufort':            { concentric: true, round: true, strongKeep: true, scale: 0.95, town: 0.25 },
  'Château Gaillard':    { concentric: true, round: true, scale: 0.95, aspect: 1.1, town: 0.25 },
  'Carcassonne':         { concentric: true, round: true, scale: 1.3, aspect: 1.6, town: 0.85 },
  'Caernarfon':          { round: true, strongKeep: true, scale: 1.3, aspect: 1.7, town: 0.8 },
  'Conwy':               { round: true, scale: 1.15, aspect: 1.6, town: 0.85 },
  'Coucy':               { round: true, strongKeep: true, scale: 1.15, aspect: 1.0, town: 0.4 },
  'Pembroke':            { round: true, strongKeep: true, scale: 1.0, town: 0.45 },
  'Pierrefonds':         { round: true, strongKeep: true, scale: 1.1, town: 0.4 },
  'Rochester':           { round: false, strongKeep: true, scale: 0.85, aspect: 1.0, town: 0.35 },
  'Windsor':             { round: true, strongKeep: true, scale: 1.2, aspect: 1.4, town: 0.7 },
  'Rhodes':              { concentric: true, round: true, scale: 1.35, aspect: 1.5, town: 0.85 },
  'Acre':                { round: true, scale: 1.35, aspect: 1.6, town: 0.9 },
  'Salzburg':            { strongKeep: true, round: false, scale: 1.1, town: 0.6 },
  'Castel del Monte':    { round: true, strongKeep: true, scale: 0.78, aspect: 1.0, town: 0.15 },
  'Jerusalem':           { round: false, strongKeep: true, scale: 1.4, aspect: 1.5, town: 0.9 },
  'Constantinople':      { concentric: true, round: true, scale: 1.4, aspect: 1.7, town: 0.9 },
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

export function generateCastles(): CampaignCastle[] {
  const n = REAL_CASTLES.length;
  return REAL_CASTLES.map(([name, region, lat, lon], i) => {
    const seed = 1000 + i * 7919, tier = n > 1 ? i / (n - 1) : 0;
    return { id: i, name, region, lat, lon, seed, tier, style: styleFor(name, region, tier, seed) };
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
export const RECRUIT_COST: Army = { heavy: 1.4, light: 0.35, archer: 0.7, cavalry: 1.0, siege: 60 };
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

export interface Progress { unlocked: number; completed: number[]; gold: number; upg: Record<string, number>; army: Army; vet: VetRoll; }
const KEY = 'castlehassle.campaign.v1';
export function loadProgress(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || '');
    if (p && typeof p.unlocked === 'number') {
      const army: Army = { ...STARTING_ARMY, ...(p.army || {}) };           // migrate old saves → a fresh army
      const gold = typeof p.gold === 'number' ? p.gold : STARTING_GOLD;
      const vet: VetRoll = { ...freshVet(), ...(p.vet || {}) };             // older saves start their corps green
      return { unlocked: p.unlocked, completed: p.completed || [], gold, upg: p.upg || {}, army, vet };
    }
  } catch { /* ignore */ }
  return { unlocked: 0, completed: [], gold: STARTING_GOLD, upg: {}, army: { ...STARTING_ARMY }, vet: freshVet() };
}
export function saveProgress(p: Progress) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }
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
export function castleDifficulty(tier: number): number { return 0.45 + tier * 1.75; }

// Gold awarded for taking a castle — scales with how late/hard it is.
export function goldReward(tier: number): number { return Math.round(160 + 560 * tier); }

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
    { id: 0, name: 'Bandit Stockade', difficulty: 0.55, reward: 140, seedBase: 50101,
      blurb: 'A village behind a low timber stockade — no stone, no towers, just a brigand militia. Send in your foot and take it. (No siege train needed.)',
      style: { scale: 0.66, aspect: 1.25, concentric: false, round: false, strongKeep: false, town: 0.32, shape: 'rect', palisade: true } },
    { id: 1, name: "Rival Baron's Keep", difficulty: 0.42, reward: 280, seedBase: 50102,
      blurb: 'A minor lord who will not bend the knee. Break his keep and take his silver.',
      style: { scale: 0.72, aspect: 1.1, concentric: false, round: true, strongKeep: true, town: 0.2, shape: 'rect' } },
    { id: 2, name: 'Fortified Caravanserai', difficulty: 0.6, reward: 480, seedBase: 50103,
      blurb: 'A walled trading post heavy with silver — and the hired guards to match.',
      style: { scale: 0.82, aspect: 1.3, concentric: false, round: true, strongKeep: false, town: 0.45, shape: 'twin' } },
  ];
}
export function raidResistance(d: number): string { return d < 0.55 ? 'Light' : d < 0.85 ? 'Moderate' : 'Heavy'; }
