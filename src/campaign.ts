// Campaign data + saved progress. The map view itself lives in worldmap3d.ts.
import { REAL_CASTLES } from './castles';

export interface CampaignCastle { id: number; name: string; region: string; lat: number; lon: number; seed: number; tier: number; }

export function generateCastles(): CampaignCastle[] {
  const n = REAL_CASTLES.length;
  return REAL_CASTLES.map(([name, region, lat, lon], i) => ({ id: i, name, region, lat, lon, seed: 1000 + i * 7919, tier: n > 1 ? i / (n - 1) : 0 }));
}

export interface Progress { unlocked: number; completed: number[]; }
const KEY = 'castlehassle.campaign.v1';
export function loadProgress(): Progress {
  try { const p = JSON.parse(localStorage.getItem(KEY) || ''); if (p && typeof p.unlocked === 'number') return { unlocked: p.unlocked, completed: p.completed || [] }; } catch { /* ignore */ }
  return { unlocked: 0, completed: [] };
}
export function saveProgress(p: Progress) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }
