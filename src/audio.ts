// Procedural battle audio (Web Audio API). Every effect is synthesised from
// oscillators and filtered noise — no sound files — so it ships self-contained
// and reacts to the live sim. Real recordings can be layered on later by
// calling the same hooks. Thousands of arrows/clashes a second are aggregated
// into representative one-shots + a swelling battle din, never one-per-event.

export interface SfxTally { arrows: number; bolts: number; boulders: number; breaches: number; melee: number; deaths: number; hits: number; }

class BattleAudioImpl {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private ambGain!: GainNode;   // overall din level (0 when off → never leaks)
  private ambBase = 0;          // base din while a battle is on
  private heat = 0;             // extra din from recent combat (decays)
  private last: Record<string, number> = {};
  private vol = 0.9;            // master sfx volume

  // Build the context + ambience graph. Must be called from a user gesture the
  // first time (browsers start audio suspended); idempotent and re-resumes.
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx: AudioContext = new AC(); this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 26; comp.ratio.value = 4.5; comp.attack.value = 0.003; comp.release.value = 0.25;
    this.master = ctx.createGain(); this.master.gain.value = this.vol;
    this.master.connect(comp).connect(ctx.destination);
    // 2s of white noise, reused everywhere
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    // --- battle din: looping noise → roar bandpass + low rumble → breathing LFO gain → level gain ---
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const roar = this.bq('bandpass', 500, 0.7), rumble = this.bq('lowpass', 150);
    const mix = this.g(1), rg = this.g(0.85), lg = this.g(0.6);
    src.connect(roar).connect(rg).connect(mix); src.connect(rumble).connect(lg).connect(mix);
    const breathe = this.g(0.85);          // LFO sits around 0.85 ± 0.15 so the din swells
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12; const lfoG = this.g(0.15);
    lfo.connect(lfoG).connect(breathe.gain); lfo.start();
    this.ambGain = this.g(0);
    mix.connect(breathe).connect(this.ambGain).connect(this.master);
    src.start();
    if (ctx.state === 'suspended') ctx.resume();
  }
  setVolume(v: number) { this.vol = v; if (this.master) this.master.gain.value = v; }

  // ---- tiny helpers ----
  private now() { return this.ctx!.currentTime; }
  private g(v = 0) { const n = this.ctx!.createGain(); n.gain.value = v; return n; }
  private bq(type: BiquadFilterType, f: number, q = 1) { const n = this.ctx!.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; }
  private pan(p: number): AudioNode { const c = this.ctx!; if (c.createStereoPanner) { const n = c.createStereoPanner(); n.pan.value = p; return n; } return this.g(1); }
  private bus(vol: number, panv = 0) { const out = this.g(vol); out.connect(this.pan(panv)).connect(this.master); return out; }
  private rl(key: string, minS: number) { const t = this.now(); if ((this.last[key] ?? -9) + minS > t) return false; this.last[key] = t; return true; }
  private noise(dur: number) { const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; const t = this.now(); s.start(t); s.stop(t + dur); return s; }
  private osc(type: OscillatorType, f: number, t: number, dur: number) { const o = this.ctx!.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); o.stop(t + dur); return o; }
  // attack/decay envelope on a gain node's param
  private env(p: AudioParam, t: number, peak: number, a: number, d: number) { p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(peak, t + a); p.exponentialRampToValueAtTime(0.0005, t + a + d); }

  // ---- one-shots ----
  clang(vol = 1) {                       // sword/shield ring
    if (!this.ctx || !this.rl('clang', 0.035)) return; const t = this.now();
    const out = this.bus(0.34 * vol, (Math.random() - 0.5) * 0.6); const eg = this.g(0); eg.connect(out);
    const det = 0.93 + Math.random() * 0.14;
    for (const [f, a] of [[2150, 1], [3300, 0.55], [4900, 0.38], [6600, 0.2]] as const) {
      const o = this.osc('square', f * det, t, 0.16); o.connect(this.gWith(a, eg));
    }
    this.noise(0.05).connect(this.bq('bandpass', 3600, 3)).connect(eg);
    this.env(eg.gain, t, 1, 0.001, 0.13);
  }
  arrow(vol = 1) {                        // a few arrows loosed
    if (!this.ctx || !this.rl('arrow', 0.05)) return; const t = this.now();
    const out = this.bus(0.13 * vol, (Math.random() - 0.5) * 0.7); const eg = this.g(0); eg.connect(out);
    const bp = this.bq('bandpass', 2400, 1.1); this.noise(0.17).connect(bp).connect(eg);
    bp.frequency.setValueAtTime(2700, t); bp.frequency.exponentialRampToValueAtTime(900, t + 0.16);
    this.env(eg.gain, t, 1, 0.01, 0.16);
  }
  volley(vol = 1) {                       // a whole salvo
    if (!this.ctx || !this.rl('volley', 0.16)) return; const t = this.now();
    const out = this.bus(0.22 * vol, 0); const eg = this.g(0); eg.connect(out);
    const bp = this.bq('bandpass', 2400, 0.8); this.noise(0.5).connect(bp).connect(eg);
    bp.frequency.setValueAtTime(3200, t); bp.frequency.exponentialRampToValueAtTime(700, t + 0.46);
    this.env(eg.gain, t, 1, 0.05, 0.44);
  }
  bolt(vol = 1) {                         // ballista — a sharp whip
    if (!this.ctx || !this.rl('bolt', 0.05)) return; const t = this.now();
    const out = this.bus(0.3 * vol, (Math.random() - 0.5) * 0.6); const eg = this.g(0); eg.connect(out);
    const o = this.ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(170, t + 0.12); o.start(t); o.stop(t + 0.14);
    o.connect(this.bq('lowpass', 2400)).connect(eg);
    this.noise(0.06).connect(this.bq('highpass', 2600)).connect(this.gWith(0.5, eg));
    this.env(eg.gain, t, 1, 0.002, 0.13);
  }
  trebFire(vol = 1) {                     // trebuchet — groaning arm + release thunk
    if (!this.ctx || !this.rl('treb', 0.12)) return; const t = this.now();
    const out = this.bus(0.7 * vol, (Math.random() - 0.5) * 0.4);
    const creak = this.g(0); creak.connect(out);
    const o = this.ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(58, t); o.frequency.linearRampToValueAtTime(112, t + 0.26); o.start(t); o.stop(t + 0.4);
    o.connect(this.bq('lowpass', 520)).connect(creak); this.env(creak.gain, t, 0.35, 0.06, 0.34);
    const t2 = t + 0.27, thunk = this.g(0); thunk.connect(out);
    const th = this.ctx.createOscillator(); th.type = 'sine';
    th.frequency.setValueAtTime(150, t2); th.frequency.exponentialRampToValueAtTime(58, t2 + 0.2); th.start(t2); th.stop(t2 + 0.24);
    th.connect(thunk); this.env(thunk.gain, t2, 0.8, 0.003, 0.2);
    this.noise(0.12).connect(this.bq('bandpass', 850, 1)).connect(this.gWith(0.3, out));
  }
  impact(vol = 1) {                       // boulder strikes stone
    if (!this.ctx || !this.rl('impact', 0.05)) return; const t = this.now();
    const out = this.bus(0.85 * vol, (Math.random() - 0.5) * 0.5);
    const boom = this.g(0); boom.connect(out);
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.3); o.start(t); o.stop(t + 0.4);
    o.connect(boom); this.env(boom.gain, t, 0.7, 0.002, 0.34);
    const rub = this.g(0); rub.connect(out); const lp = this.bq('lowpass', 1800);
    this.noise(0.34).connect(lp).connect(rub); lp.frequency.setValueAtTime(2200, t); lp.frequency.exponentialRampToValueAtTime(420, t + 0.3);
    this.env(rub.gain, t, 0.5, 0.001, 0.3);
  }
  breach(vol = 1) {                       // a wall comes down — boom + long rubble + crackle
    if (!this.ctx) return; const t = this.now();
    const out = this.bus(1.0 * vol, (Math.random() - 0.5) * 0.4);
    const boom = this.g(0); boom.connect(out);
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.5); o.start(t); o.stop(t + 0.7);
    o.connect(boom); this.env(boom.gain, t, 0.85, 0.003, 0.55);
    const rub = this.g(0); rub.connect(out); const lp = this.bq('lowpass', 1400);
    this.noise(0.9).connect(lp).connect(rub); lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.8);
    this.env(rub.gain, t, 0.6, 0.004, 0.85);
    // a few stony cracks scattered through the collapse
    for (let i = 0; i < 5; i++) { const tc = t + 0.06 + Math.random() * 0.7; const cg = this.g(0); cg.connect(out);
      const n = this.ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; n.start(tc); n.stop(tc + 0.05);
      n.connect(this.bq('bandpass', 1200 + Math.random() * 2200, 6)).connect(cg); this.env(cg.gain, tc, 0.5, 0.001, 0.05); }
  }
  // war horn — stacked saws through a lowpass; `mood` shifts the second note
  horn(mood: 'call' | 'victory' | 'defeat' = 'call') {
    if (!this.ctx) return; this.ensure(); const t = this.now();
    const out = this.bus(0.5, 0);
    const seq = mood === 'victory' ? [[174.6, 0, 0.4], [220, 0.32, 0.4], [261.6, 0.62, 0.9]]
      : mood === 'defeat' ? [[146.8, 0, 0.7], [110, 0.5, 1.1]]
      : [[146.8, 0, 0.5], [220, 0.4, 0.75]];
    for (const [f, off, len] of seq) {
      const tt = t + off, eg = this.g(0), lp = this.bq('lowpass', 1500); eg.connect(out); lp.connect(eg);
      for (const [m, a] of [[1, 1], [2, 0.5], [3, 0.3], [4, 0.16]] as const) { const o = this.osc('sawtooth', f * m, tt, len + 0.12); o.connect(this.gWith(a, lp)); }
      this.env(eg.gain, tt, 1, 0.05, len);
    }
  }
  victory() { this.horn('victory'); }
  defeat() {
    if (!this.ctx) return; const t = this.now();          // a low drum thud under the falling horn
    const out = this.bus(0.8, 0); const dg = this.g(0); dg.connect(out);
    const o = this.osc('sine', 90, t, 0.5); o.frequency.exponentialRampToValueAtTime(45, t + 0.4); o.connect(dg);
    this.env(dg.gain, t, 0.8, 0.002, 0.45); this.noise(0.12).connect(this.bq('lowpass', 700)).connect(this.gWith(0.3, out));
    this.horn('defeat');
  }

  // ---- UI feedback (menus) — each ensures the context so the FIRST tap unlocks audio ----
  tap(vol = 1) {                          // soft, premium button press
    this.ensure(); if (!this.ctx || !this.rl('tap', 0.02)) return; const t = this.now();
    const out = this.bus(0.12 * vol, 0); const eg = this.g(0); eg.connect(out);
    const o = this.osc('triangle', 560, t, 0.08); o.frequency.exponentialRampToValueAtTime(360, t + 0.06); o.connect(eg);
    this.noise(0.012).connect(this.bq('highpass', 2600)).connect(this.gWith(0.22, eg)); // a clean tick edge
    this.env(eg.gain, t, 1, 0.001, 0.06);
  }
  select(vol = 1) {                       // brighter tick for selecting a unit
    this.ensure(); if (!this.ctx || !this.rl('select', 0.02)) return; const t = this.now();
    const out = this.bus(0.13 * vol, 0); const eg = this.g(0); eg.connect(out);
    const o = this.osc('triangle', 860, t, 0.07); o.frequency.exponentialRampToValueAtTime(1200, t + 0.05); o.connect(eg);
    this.env(eg.gain, t, 1, 0.001, 0.06);
  }
  coin(vol = 1) {                         // bright two-note "ka-ching" for a purchase
    this.ensure(); if (!this.ctx || !this.rl('coin', 0.04)) return; const t = this.now();
    const out = this.bus(0.22 * vol, 0);
    for (const [f, off] of [[1318.5, 0], [1975.5, 0.06]] as const) { const tt = t + off; const eg = this.g(0); eg.connect(out);
      for (const [m, a] of [[1, 1], [2.01, 0.4], [3.0, 0.16]] as const) { const o = this.osc('sine', f * m, tt, 0.22); o.connect(this.gWith(a, eg)); }
      this.env(eg.gain, tt, 1, 0.002, 0.18); }
  }
  reward(vol = 1) {                       // celebratory ascending bell arpeggio (spoils/victory)
    this.ensure(); if (!this.ctx) return; const t = this.now();
    const out = this.bus(0.26 * vol, 0);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => { const tt = t + i * 0.09; const eg = this.g(0); eg.connect(out);
      for (const [m, a] of [[1, 1], [2.0, 0.45], [3.01, 0.2], [4.2, 0.08]] as const) { const o = this.osc('sine', f * m, tt, 0.5); o.connect(this.gWith(a, eg)); }
      this.env(eg.gain, tt, 1, 0.003, 0.42); });
  }
  unlock(vol = 1) {                       // sparkle when a new conquest opens up
    this.ensure(); if (!this.ctx) return; const t = this.now();
    const out = this.bus(0.2 * vol, 0);
    [784, 988, 1175, 1568].forEach((f, i) => { const tt = t + i * 0.06; const eg = this.g(0); eg.connect(out);
      this.osc('sine', f, tt, 0.3).connect(eg); this.osc('sine', f * 2.01, tt, 0.3).connect(this.gWith(0.3, eg));
      this.env(eg.gain, tt, 1, 0.002, 0.26); });
  }
  denied(vol = 1) {                       // soft "nuh-uh" for a blocked action
    this.ensure(); if (!this.ctx || !this.rl('denied', 0.06)) return; const t = this.now();
    const out = this.bus(0.16 * vol, 0);
    for (const [f, off] of [[300, 0], [235, 0.1]] as const) { const tt = t + off; const eg = this.g(0); eg.connect(out);
      const o = this.osc('square', f, tt, 0.1); o.connect(this.bq('lowpass', 900)).connect(eg);
      this.env(eg.gain, tt, 1, 0.004, 0.09); }
  }
  commit(vol = 1) {                       // determined low thud for "march / lay siege"
    this.ensure(); if (!this.ctx || !this.rl('commit', 0.05)) return; const t = this.now();
    const out = this.bus(0.32 * vol, 0); const eg = this.g(0); eg.connect(out);
    const o = this.osc('sine', 150, t, 0.22); o.frequency.exponentialRampToValueAtTime(70, t + 0.2); o.connect(eg);
    this.noise(0.05).connect(this.bq('lowpass', 600)).connect(this.gWith(0.3, eg));
    this.env(eg.gain, t, 1, 0.003, 0.2);
  }
  whoosh(up = true, vol = 1) {            // overlay open / close
    this.ensure(); if (!this.ctx || !this.rl('whoosh', 0.05)) return; const t = this.now();
    const out = this.bus(0.14 * vol, 0); const eg = this.g(0); eg.connect(out);
    const bp = this.bq('bandpass', 600, 0.8); this.noise(0.26).connect(bp).connect(eg);
    bp.frequency.setValueAtTime(up ? 380 : 1500, t); bp.frequency.exponentialRampToValueAtTime(up ? 1700 : 320, t + 0.22);
    this.env(eg.gain, t, 1, 0.04, 0.2);
  }

  // gain-of helper: make a gain with value v feeding `dest`, return it for connecting a source into
  private gWith(v: number, dest: AudioNode) { const n = this.g(v); n.connect(dest); return n; }

  startAmbience(level = 0.26) { this.ambBase = level; }
  stopAmbience() { this.ambBase = 0; if (this.ctx) this.ambGain.gain.setTargetAtTime(0, this.now(), 0.4); }

  // Per frame: turn aggregated combat tallies into representative sounds + din.
  update(dt: number, e: SfxTally, intensity: number) {
    if (!this.ctx) return;
    for (let i = 0; i < e.boulders; i++) this.trebFire();
    for (let i = 0; i < Math.min(e.hits, 3); i++) this.impact();
    for (let i = 0; i < e.breaches; i++) this.breach();
    if (e.bolts > 0) this.bolt();
    if (e.arrows >= 8) this.volley(Math.min(1, e.arrows / 28));
    else if (e.arrows > 0) this.arrow(Math.min(1, e.arrows / 4));
    if (e.melee > 0) {
      const n = e.melee > 30 ? 3 : e.melee > 10 ? 2 : 1;
      for (let i = 0; i < n; i++) this.clang(0.5 + Math.min(0.5, e.melee / 60));
      this.heat = Math.min(1.2, this.heat + e.melee * 0.004);
    }
    this.heat *= Math.pow(0.5, dt / 0.8);                 // ~0.8s half-life
    if (this.ambBase > 0) {
      const lvl = this.ambBase * (0.55 + 0.45 * Math.min(1, intensity)) + this.ambBase * Math.min(1, this.heat);
      this.ambGain.gain.setTargetAtTime(Math.max(0, lvl), this.now(), 0.3);
    }
  }
}

export const battleAudio = new BattleAudioImpl();
