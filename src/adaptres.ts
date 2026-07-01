// Adaptive-resolution decision, isolated as a pure function so it can be reasoned
// about and tested on its own.
//
// Lowering render resolution only relieves the GPU. So we shed pixels ONLY when the
// frame is render-bound, and we hand quality back whenever the SIM is what's capping
// fps (a big infantry swarm is pure CPU work that resolution can't fix) or the GPU
// clearly has headroom. Without the sim-bound restore, a heavy battle would drop to
// low resolution and stay there — blurry for no framerate gain.
export function nextQuality(q: number, fps: number, simMs: number, gfxMs: number): number {
  const simBound = simMs > gfxMs * 2; // the CPU sim, not the GPU, is setting the pace
  if (fps < 30 && q > 0.45 && !simBound) return Math.max(0.45, q - 0.12); // render-bound → shed pixels
  if (q < 1 && (fps > 54 || simBound)) return Math.min(1, q + 0.1);        // headroom or futile → restore
  return q;
}
