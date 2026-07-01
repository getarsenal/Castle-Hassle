// The player PROFILE: one per device, persisting ACROSS campaigns and save-slot
// wipes. Holds settings, lifetime tallies, and unlocked achievements — the meta
// layer above the per-campaign save.

export type Difficulty = 'squire' | 'knight' | 'warlord';
// global difficulty scalars: garrison size and the spoils they yield.
export const DIFFICULTY: Record<Difficulty, { label: string; blurb: string; garrison: number; reward: number }> = {
  squire:  { label: 'Squire',  blurb: 'Lighter garrisons, richer spoils — learn the art of siege.', garrison: 0.8, reward: 1.2 },
  knight:  { label: 'Knight',  blurb: 'The intended balance of the crusade.',                        garrison: 1.0, reward: 1.0 },
  warlord: { label: 'Warlord', blurb: 'Heavier garrisons, leaner spoils — for the hardened.',        garrison: 1.25, reward: 0.85 },
};

export interface Settings { volume: number; muted: boolean; difficulty: Difficulty; }
export interface Lifetime {
  castlesTaken: number; kills: number; battlesWon: number; battlesLost: number;
  raidsWon: number; campaignsWon: number; goldEarned: number; menLost: number;
}
export interface Profile { settings: Settings; lifetime: Lifetime; achievements: string[]; }

const KEY = 'castlehassle.profile.v1';
const LEGACY_MUTE = 'ch.muted';

function freshLifetime(): Lifetime {
  return { castlesTaken: 0, kills: 0, battlesWon: 0, battlesLost: 0, raidsWon: 0, campaignsWon: 0, goldEarned: 0, menLost: 0 };
}
export function freshProfile(): Profile {
  let muted = false; try { muted = localStorage.getItem(LEGACY_MUTE) === '1'; } catch { /* ignore */ }
  return { settings: { volume: 0.8, muted, difficulty: 'knight' }, lifetime: freshLifetime(), achievements: [] };
}
export function loadProfile(): Profile {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (p && p.settings) {
      const f = freshProfile();
      return { settings: { ...f.settings, ...p.settings }, lifetime: { ...freshLifetime(), ...(p.lifetime || {}) }, achievements: p.achievements || [] };
    }
  } catch { /* ignore */ }
  return freshProfile();
}
export function saveProfile(p: Profile) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }

// ---- achievements: id → {name, desc, test(lifetime)} ----
export interface Achievement { id: string; name: string; desc: string; test: (l: Lifetime) => boolean; }
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_blood', name: 'First Blood', desc: 'Win your first battle.', test: l => l.battlesWon >= 1 },
  { id: 'first_castle', name: 'Castellan', desc: 'Take your first castle.', test: l => l.castlesTaken >= 1 },
  { id: 'raider', name: 'Reaver', desc: 'Win 5 raids.', test: l => l.raidsWon >= 5 },
  { id: 'butcher', name: 'The Butcher', desc: 'Slay 10,000 men.', test: l => l.kills >= 10000 },
  { id: 'warchest', name: 'War Chest', desc: 'Earn 5,000 gold in spoils.', test: l => l.goldEarned >= 5000 },
  { id: 'ten_castles', name: 'Conqueror', desc: 'Take 10 castles.', test: l => l.castlesTaken >= 10 },
  { id: 'crusade', name: 'Crusader', desc: 'Complete the crusade to Jerusalem.', test: l => l.campaignsWon >= 1 },
];
// fold a battle's results into the lifetime tally + newly-earned achievements.
export function recordBattle(p: Profile, r: { won: boolean; castleTaken: boolean; raidWon: boolean; kills: number; gold: number; menLost: number; campaignWon: boolean }): string[] {
  const l = p.lifetime;
  if (r.won) l.battlesWon++; else l.battlesLost++;
  if (r.castleTaken) l.castlesTaken++;
  if (r.raidWon) l.raidsWon++;
  if (r.campaignWon) l.campaignsWon++;
  l.kills += r.kills; l.goldEarned += r.gold; l.menLost += r.menLost;
  const newly: string[] = [];
  for (const a of ACHIEVEMENTS) if (!p.achievements.includes(a.id) && a.test(l)) { p.achievements.push(a.id); newly.push(a.id); }
  return newly;
}
