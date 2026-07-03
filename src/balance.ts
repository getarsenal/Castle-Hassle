// A fast, transparent force-ratio estimate for the campaign — NOT a battle sim, a
// tuning lens. It answers "roughly, can this host take this castle, and how hard?"
// so the difficulty curve can be read across all 99 sieges at once instead of by
// feel. Deliberately simple and pure so it's testable and cheap to run ×99.
//
// Model: each soldier has a field value ≈ HP × sustained DPS. Attacker value folds
// in veterancy + War Council buffs; defender value uses base stats (the AI gets no
// buffs) but their wall archers plunge. Walls handicap the attacker, and a siege
// train eases that handicap by breaching. ratio = attacker / defender.

export interface HostPower {
  arms: { heavy: number; light: number; archer: number; cavalry: number; siege: number };
  vetMul: number[];        // per-arm veterancy multiplier, UType order [H,L,A,C,S]
  hpBuff: number; meleeBuff: number; archerBuff: number; siegeBuff: number;
}
export interface CastleThreat {
  garrison: number; reserves: number; archers: number; citGuard: number; total: number;
  concentric: boolean; citadel: boolean; towers: number;
}
export interface Assessment { ratio: number; band: Band; hostValue: number; defValue: number }
export type Band = 'Rout' | 'Strong' | 'Even' | 'Costly' | 'Grim';

// mirrors src/sim.ts combat constants (kept in sync by hand — this is a dev estimate).
// NOTE: sim.ts multiplies HP and all RANGED damage by HP_SCALE; that scales both
// sides of the ratio equally, so these UNSCALED bases stay correct for the ratio.
// Deliberately NOT modelled (they mostly cancel or are player-skill dependent):
// morale/rout, flank/rear counters, weather, engine crews, siege works, doctrine
// path specials (charges, firepots, surgeons). If sim.ts's base HP/MELEE/ATKCD
// arrays change, update these to match.
const HP = [120, 70, 55, 95, 260], MELEE = [9, 7, 5, 15, 0], ATKCD = [0.8, 0.55, 1.3, 0.75, 6.5], ARCHER_DMG = 12;
// per-soldier field value ≈ HP × sustained DPS; ranged arms carry a safety premium,
// cavalry a grind penalty (brittle once the charge is spent).
export const ARM_VALUE = [
  HP[0] * (MELEE[0] / ATKCD[0]),          // heavy  ≈ 1350
  HP[1] * (MELEE[1] / ATKCD[1]),          // light  ≈ 891
  HP[2] * (ARCHER_DMG / ATKCD[2]) * 1.4,  // archer ≈ 711
  HP[3] * (MELEE[3] / ATKCD[3]) * 0.8,    // cavalry≈ 1520
  0,                                      // siege — valued via wall-breaking, not melee
];
const WALL_ARCHER_BONUS = 1.35; // defenders shoot from the walls with cover + plunging fire

export function bandOf(ratio: number): Band {
  return ratio >= 2.2 ? 'Rout' : ratio >= 1.5 ? 'Strong' : ratio >= 1.1 ? 'Even' : ratio >= 0.8 ? 'Costly' : 'Grim';
}

export function assessBattle(h: HostPower, t: CastleThreat): Assessment {
  const a = h.arms;
  const counts = [a.heavy, a.light, a.archer, a.cavalry];
  const dmgBuff = [h.meleeBuff, h.meleeBuff, h.archerBuff, h.meleeBuff];
  let troop = 0;
  for (let i = 0; i < 4; i++) troop += counts[i] * ARM_VALUE[i] * (h.vetMul[i] || 1) * h.hpBuff * dmgBuff[i];
  const siegeStr = a.siege * h.siegeBuff * (h.vetMul[4] || 1);
  // walls favour the defender; a siege train chips that away toward parity
  let wall = 0.9 * (t.concentric ? 0.78 : 1) * (t.citadel ? 0.88 : 1) * (1 - Math.min(0.18, t.towers * 0.005));
  wall = wall + (1 - wall) * Math.min(1, siegeStr / 10);
  const hostValue = troop * wall;
  const defValue = t.garrison * ARM_VALUE[0] + t.reserves * ARM_VALUE[1]
    + t.archers * ARM_VALUE[2] * WALL_ARCHER_BONUS + t.citGuard * ARM_VALUE[0];
  const ratio = defValue > 0 ? hostValue / defValue : 99;
  return { ratio, band: bandOf(ratio), hostValue, defValue };
}
