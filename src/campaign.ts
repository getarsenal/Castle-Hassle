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

export interface Progress { unlocked: number; completed: number[]; gold: number; upg: Record<string, number>; }
const KEY = 'castlehassle.campaign.v1';
export function loadProgress(): Progress {
  try { const p = JSON.parse(localStorage.getItem(KEY) || ''); if (p && typeof p.unlocked === 'number') return { unlocked: p.unlocked, completed: p.completed || [], gold: p.gold || 0, upg: p.upg || {} }; } catch { /* ignore */ }
  return { unlocked: 0, completed: [], gold: 0, upg: {} };
}
export function saveProgress(p: Progress) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }

// Defender strength shown on the castle panel — mirrors the sim's garrison
// formula (garrison + reserves + a citadel guard + wall/tower archers) using the
// castle's size from its style, so the number tracks what you'll actually face.
export function garrisonStrength(style: CastleStyle, difficulty: number): number {
  const W = Math.max(40, Math.min(90, 59 * style.scale * Math.sqrt(style.aspect)));
  const D = Math.max(36, Math.min(78, 52 * style.scale / Math.sqrt(style.aspect)));
  const garr = Math.max(280, Math.min(560, W * D / 14)) * difficulty;
  const citadel = style.concentric || style.strongKeep || W * D > 3200;
  return Math.round(garr * 1.6 + (citadel ? 220 * difficulty : 0) + 260);
}

// Gold awarded for taking a castle — scales with how late/hard it is.
export function goldReward(tier: number): number { return Math.round(90 + 360 * tier); }
