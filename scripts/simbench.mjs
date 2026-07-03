// Headless battle bench — the balance instrument for combat work.
// Bundles the (DOM-free) sim and fights scripted battles across seeds:
//   node scripts/simbench.mjs [battles=8] [maxMinutes=6]
// Prints per-battle result + aggregate win rate, duration, losses — run it
// BEFORE and AFTER combat changes so tuning is measured, not vibes.
import { execSync } from 'child_process';
import fs from 'fs';

const OUT = 'scripts/.simbundle.mjs';
execSync(`npx esbuild src/sim.ts --bundle --format=esm --outfile=${OUT}`, { stdio: 'pipe' });
const { Sim } = await import('../' + OUT + '?v=' + Date.now());

const N = +(process.argv[2] ?? 8);
const MAXS = (+(process.argv[3] ?? 6)) * 60;
const comp = { heavy: 600, light: 480, archer: 460, cavalry: 220, siege: 8 };

const rows = [];
for (let k = 0; k < N; k++) {
  const seed = 11337 + k * 991;
  const s = new Sim(seed, { ...comp }, 1.0);
  s.begin();
  s.assaultAll();
  let t = 0, next = 20;
  const att0 = s.countAlive(0), def0 = s.countAlive(1);
  while (s.phase !== 'over' && t < MAXS) {
    s.step(1 / 30); t += 1 / 30;
    if (t >= next) { s.assaultAll(); next += 20; } // a live player re-commits rallied arms
  }
  const att1 = s.countAlive(0), def1 = s.countAlive(1);
  const stalledLoss = s.phase !== 'over' && att1 < def1 * 0.6; // a spent assault that can't finish = a loss in practice
  rows.push({ seed, win: s.winner === 0, t: Math.round(t), attLoss: att0 - att1, att0, defLeft: def1, def0, timeout: s.phase !== 'over' });
  console.log(`seed ${seed}: ${s.phase !== 'over' ? (stalledLoss ? 'LOSS(stall)' : 'STALEMATE') : s.winner === 0 ? 'WIN ' : 'LOSS'} in ${Math.round(t)}s  att ${att1}/${att0}  def ${def1}/${def0}`);
}
const wins = rows.filter(r => r.win).length, tos = rows.filter(r => r.timeout).length;
const avg = (f) => Math.round(rows.reduce((s, r) => s + f(r), 0) / rows.length);
console.log(`\n== ${wins}/${N} wins, ${tos} timeouts | avg dur ${avg(r => r.t)}s | avg att losses ${avg(r => r.attLoss)}/${avg(r => r.att0)} | avg def left ${avg(r => r.defLeft)}/${avg(r => r.def0)}`);
fs.rmSync(OUT, { force: true });
