// Procedural battle audio (Web Audio API). Every effect is synthesised from
// oscillators and filtered noise — no sound files — so it ships self-contained
// and reacts to the live sim. Thousands of arrows/clashes a second are
// aggregated into representative one-shots + a swelling battle din.
//
// Design follows how pro weapon SFX are built: metal hits are LAYERED — a low
// body/thud for weight, a metallic RING from inharmonic sine partials (modal
// synthesis, never buzzy square waves), and a high "shing" of narrow-band noise
// — and everything is fed to a shared REVERB so the render sits in a space
// instead of sounding dry and synthetic.

export interface SfxTally { arrows: number; bolts: number; boulders: number; breaches: number; melee: number; deaths: number; hits: number; cavalry: number; oil: number; }

function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * seconds)), buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
  return buf;
}

class BattleAudioImpl {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverbIn!: GainNode;
  private noiseBuf!: AudioBuffer;
  private ambGain!: GainNode;
  private ambBase = 0;
  private heat = 0;
  private last: Record<string, number> = {};
  private vol = 0.9;

  // Real recorded battle SFX — once decoded these REPLACE the synthesised
  // one-shots and din (the synthesis stays as the fallback until they load, or
  // if a file is missing). Paths are relative, like the menu music, so they
  // resolve against wherever the game is served from.
  private buffers: Record<string, AudioBuffer> = {};
  private SAMPLES: Record<string, string> = {
    swords1: './battle-swords-1.mp3', swords2: './battle-swords-2.mp3',
    archers: './archers-shot.mp3', trebFire: './trebuchet-firing.mp3',
    trebHit: './trebuchet-hit-crash.mp3', cavalry: './cavalry-charge-loop.mp3',
    cries: './battle-cries.mp3', drum: './siege-background-drum.mp3',
  };
  private samplesReq = false;
  private dinStarted = false;
  private procDin!: GainNode;   // synthesised crowd din (fallback)
  private sampleDin!: GainNode; // recorded battle-cries + siege-drum loop
  // adaptive-score layers: the drums follow the BOMBARDMENT, the cries follow the
  // MELEE — so the bed swells with what's actually happening on the field
  private criesGain?: GainNode; private drumGain?: GainNode;
  private siegeHeat = 0;

  private _t0 = 0; // scheduling offset, used only when rendering an offline preview

  ensure() {
    if (!this.ctx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.build();
    }
    this.loadSamples();
    this.kick();
  }
  // Fetch + decode the recorded SFX once (after a context exists). Each file is
  // best-effort: a failure just leaves that sound on its synthesised fallback.
  private loadSamples() {
    if (this.samplesReq || !this.ctx) return; this.samplesReq = true;
    const ctx = this.ctx;
    for (const [k, url] of Object.entries(this.SAMPLES)) {
      fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(url)))
        .then(ab => ctx.decodeAudioData(ab))
        .then(buf => { this.buffers[k] = buf; if (k === 'cries' || k === 'drum') this.startDin(); })
        .catch(() => { /* keep the synthesised fallback for this one */ });
    }
  }
  // Once the looping recordings are decoded, start them and crossfade off the
  // synthesised din so the bed is real crowd noise + siege drums.
  private startDin() {
    if (this.dinStarted || !this.ctx) return;
    const cries = this.buffers.cries, drum = this.buffers.drum;
    if (!cries || !drum) return;                 // wait until both are ready
    this.dinStarted = true; const t = this.now();
    this.criesGain = this.gWith(0.75, this.sampleDin); this.drumGain = this.gWith(0.42, this.sampleDin);
    const cs = this.ctx.createBufferSource(); cs.buffer = cries; cs.loop = true; cs.connect(this.criesGain); cs.start(t);
    const ds = this.ctx.createBufferSource(); ds.buffer = drum; ds.loop = true; ds.connect(this.drumGain); ds.start(t);
    this.procDin.gain.setTargetAtTime(0, t, 0.5);
    this.sampleDin.gain.setTargetAtTime(1, t, 0.5);
  }
  // Build the master/reverb/din graph on the current context (live or offline).
  private build() {
    const ctx = this.ctx!;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 26; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.28;
    this.master = ctx.createGain(); this.master.gain.value = this.vol;
    this.master.connect(comp).connect(ctx.destination);
    // shared reverb send — gives every hit a tail/space (the big "render" upgrade)
    const conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, 1.7, 3.2);
    const wet = this.g(0.5); this.reverbIn = this.g(1);
    this.reverbIn.connect(conv).connect(wet).connect(this.master);
    // 2s of white noise, reused everywhere
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    // --- battle din: a LOW crowd roar + rumble, slowly moving so it reads as a
    // living mass of men, not static hiss ---
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const roar = this.bq('bandpass', 320, 0.6), rumble = this.bq('lowpass', 120);
    const mix = this.g(1), rg = this.g(0.7), lg = this.g(0.85);
    src.connect(roar).connect(rg).connect(mix); src.connect(rumble).connect(lg).connect(mix);
    const fl = ctx.createOscillator(); fl.frequency.value = 0.07; const flg = this.g(110); fl.connect(flg).connect(roar.frequency); fl.start(); // roam the roar band
    const breathe = this.g(0.8);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11; const lfoG = this.g(0.2); lfo.connect(lfoG).connect(breathe.gain); lfo.start();
    this.ambGain = this.g(0);
    // Two interchangeable beds under the ambience level: the synthesised din
    // (default) and the recorded loops, crossfaded once the samples decode.
    this.procDin = this.g(1); this.sampleDin = this.g(0);
    mix.connect(breathe).connect(this.procDin).connect(this.ambGain);
    this.sampleDin.connect(this.ambGain);
    this.ambGain.connect(this.master);
    src.start();
  }
  // Render a montage of every battle sound to an AudioBuffer (offline), for
  // auditioning the synthesis without a device. Restores live state afterward.
  async renderMontage(seconds = 9): Promise<AudioBuffer | null> {
    const OAC = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    if (!OAC) return null;
    const off: OfflineAudioContext = new OAC(2, Math.ceil(44100 * seconds), 44100);
    const save = { ctx: this.ctx, master: this.master, reverbIn: this.reverbIn, noiseBuf: this.noiseBuf, ambGain: this.ambGain, ambBase: this.ambBase, heat: this.heat, last: this.last };
    this.ctx = off as unknown as AudioContext; this.last = {}; this.build();
    const at = (s: number, fn: () => void) => { this._t0 = s; this.last = {}; fn(); }; // schedule at time s (rate-limiter reset per event)
    this.ambGain.gain.setValueAtTime(0.0001, 0); this.ambGain.gain.linearRampToValueAtTime(0.22, 1.2); this.ambGain.gain.setValueAtTime(0.22, 7.2); this.ambGain.gain.linearRampToValueAtTime(0, 8.6);
    at(0.1, () => this.horn('call'));
    let s = 1.4; for (let i = 0; i < 8; i++) { at(s, () => this.clang(0.85)); s += 0.16 + Math.random() * 0.14; }
    at(2.1, () => this.arrow(1)); at(2.7, () => this.volley(1));
    at(3.7, () => this.trebFire(1)); at(4.45, () => this.impact(1));
    for (let i = 0; i < 5; i++) at(4.7 + i * 0.16, () => this.clang(0.7));
    at(5.7, () => this.bolt(1));
    at(6.3, () => this.breach(1));
    at(7.7, () => this.victory());
    this._t0 = 0;
    const rendered = await off.startRendering();
    Object.assign(this, save);
    return rendered;
  }
  // ---- campaign-map ambience: a soft wind bed + distant gulls, faded with the screen ----
  private mapAmb?: { gain: GainNode; stop: () => void };
  mapAmbience(on: boolean) {
    if (!on) {
      const amb = this.mapAmb; if (!amb) return; this.mapAmb = undefined;
      if (this.ctx) amb.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.35);
      setTimeout(() => amb.stop(), 1600);
      return;
    }
    this.ensure(); const ctx = this.ctx; if (!ctx || this.mapAmb) return;
    // wind: looped noise through a slowly-roaming bandpass, gently breathing
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const band = this.bq('bandpass', 360, 0.55), lp = this.bq('lowpass', 950);
    const g = this.g(0);
    const roam = ctx.createOscillator(); roam.frequency.value = 0.08; const roamG = this.g(90); roam.connect(roamG).connect(band.frequency); roam.start();
    const bre = ctx.createOscillator(); bre.frequency.value = 0.13; const breG = this.g(0.022); bre.connect(breG).connect(g.gain); bre.start();
    src.connect(band); band.connect(lp); lp.connect(g); g.connect(this.master); src.start();
    g.gain.setTargetAtTime(0.07, ctx.currentTime, 0.9);
    // gulls: every so often a little falling two-or-three-note cry, off to one side
    const iv = setInterval(() => { if (this.mapAmb && Math.random() < 0.65) this.gullCry(); }, 6500);
    this.mapAmb = {
      gain: g,
      stop: () => { clearInterval(iv); try { src.stop(); roam.stop(); bre.stop(); src.disconnect(); band.disconnect(); lp.disconnect(); g.disconnect(); roamG.disconnect(); breG.disconnect(); } catch { /* ctx closed */ } },
    };
  }
  // ---- battle weather ambience: rain patter / wind gusts / mist hush ----
  private wxAmb?: { gain: GainNode; stop: () => void };
  wxAmbience(kind: 'clear' | 'rain' | 'mist' | 'wind' | null) {
    if (this.wxAmb) { // stop whatever sky was playing
      const a = this.wxAmb; this.wxAmb = undefined;
      if (this.ctx) a.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
      setTimeout(() => a.stop(), 1800);
    }
    if (!kind || kind === 'clear') return;
    this.ensure(); const ctx = this.ctx; if (!ctx) return;
    const g = this.g(0); g.connect(this.master);
    const nodes: (AudioNode | OscillatorNode | AudioBufferSourceNode)[] = [g];
    if (kind === 'rain') {
      // patter: bright hissy noise band; body: a low washing rumble that breathes
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const hp = this.bq('highpass', 1500), lp = this.bq('lowpass', 6400), pg = this.g(0.55);
      src.connect(hp).connect(lp).connect(pg).connect(g);
      const src2 = ctx.createBufferSource(); src2.buffer = this.noiseBuf; src2.loop = true;
      const rum = this.bq('lowpass', 130), rg = this.g(0.5);
      src2.connect(rum).connect(rg).connect(g);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09; const lg = this.g(0.14);
      lfo.connect(lg).connect(rg.gain); lfo.start();
      src.start(); src2.start(0, Math.random() * 1.9); // offset INTO the buffer so the rumble layer decorrelates from the patter
      g.gain.setTargetAtTime(0.075, ctx.currentTime, 1.2);
      nodes.push(src, src2, hp, lp, pg, rum, rg, lfo, lg);
    } else {
      // wind (and the mist's hush — the same air, softer and lower)
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const band = this.bq('bandpass', kind === 'mist' ? 240 : 330, 0.5), lp = this.bq('lowpass', kind === 'mist' ? 620 : 1100);
      src.connect(band).connect(lp).connect(g);
      const roam = ctx.createOscillator(); roam.frequency.value = 0.06; const roamG = this.g(kind === 'mist' ? 60 : 130);
      roam.connect(roamG).connect(band.frequency); roam.start();
      const gust = ctx.createOscillator(); gust.frequency.value = kind === 'mist' ? 0.1 : 0.16; const gustG = this.g(kind === 'mist' ? 0.012 : 0.03);
      gust.connect(gustG).connect(g.gain); gust.start();
      src.start(0, Math.random() * 1.9);
      g.gain.setTargetAtTime(kind === 'mist' ? 0.035 : 0.06, ctx.currentTime, 1.4);
      nodes.push(src, band, lp, roam, roamG, gust, gustG);
    }
    this.wxAmb = { gain: g, stop: () => { for (const n of nodes) { try { (n as OscillatorNode).stop?.(); } catch { /* not a source */ } try { n.disconnect(); } catch { /* ctx closed */ } } } };
  }
  private gullCry() {
    const ctx = this.ctx; if (!ctx) return;
    const out = this.bus(0.16, (Math.random() - 0.5) * 1.1, 0.3);
    const n = 2 + (Math.random() < 0.4 ? 1 : 0); let t = this.now() + 0.02;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(); o.type = 'triangle';
      const f0 = 1350 + Math.random() * 250;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.17);
      const eg = this.g(0); o.connect(eg); eg.connect(out);
      this.env(eg.gain, t, 0.5, 0.025, 0.19);
      o.start(t); o.stop(t + 0.24); t += 0.21 + Math.random() * 0.08;
    }
  }

  // iOS/Safari: resume + a silent buffer inside a gesture, until it sticks.
  private kick() {
    const ctx = this.ctx; if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => { /* ignore */ });
      try { const b = ctx.createBufferSource(); b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); b.connect(ctx.destination); b.start(0); } catch { /* ignore */ }
    }
  }
  installUnlock() {
    const kick = () => this.ensure();
    for (const ev of ['touchend', 'pointerup', 'pointerdown', 'mousedown', 'click', 'keydown']) window.addEventListener(ev, kick, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => { /* ignore */ }); });
  }
  setVolume(v: number) { this.vol = v; if (this.master && !this._muted) this.master.gain.value = v; }
  private _muted = false;
  get muted() { return this._muted; }
  setMuted(m: boolean) { this._muted = m; if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.vol, this.ctx.currentTime, 0.05); }

  // ---- helpers ----
  private now() { return this.ctx!.currentTime + this._t0; }
  private g(v = 0) { const n = this.ctx!.createGain(); n.gain.value = v; return n; }
  private bq(type: BiquadFilterType, f: number, q = 1) { const n = this.ctx!.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; }
  private pan(p: number): AudioNode { const c = this.ctx!; if (c.createStereoPanner) { const n = c.createStereoPanner(); n.pan.value = p; return n; } return this.g(1); }
  // a per-sound output bus: dry → master, plus an optional reverb send
  private bus(vol: number, panv = 0, send = 0) {
    const out = this.g(vol); const p = this.pan(panv); out.connect(p); p.connect(this.master);
    let s: GainNode | undefined;
    if (send > 0 && this.reverbIn) { s = this.g(send); p.connect(s); s.connect(this.reverbIn); }
    // one-shot bus: tear the chain down once the sound (and its reverb tail) is
    // spent, or every sfx leaks a gain+panner wired to the master forever
    setTimeout(() => { try { out.disconnect(); p.disconnect(); s?.disconnect(); } catch { /* ctx closed */ } }, 4000);
    return out;
  }
  private rl(key: string, minS: number) { const t = this.now(); if ((this.last[key] ?? -9) + minS > t) return false; this.last[key] = t; return true; }
  private noise(dur: number) { const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; const t = this.now(); s.start(t); s.stop(t + dur); return s; }
  private osc(type: OscillatorType, f: number, t: number, dur: number) { const o = this.ctx!.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(t + dur); return o; }
  private env(p: AudioParam, t: number, peak: number, a: number, d: number) { p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(peak, t + a); p.exponentialRampToValueAtTime(0.0005, t + a + d); }
  private gWith(v: number, dest: AudioNode) { const n = this.g(v); n.connect(dest); return n; }

  // ---- recorded-sample playback ----
  // A short slice (random start) of a continuous recording — for clashes/arrows,
  // so each trigger is a fresh hit and the long files never pile up. Falls back
  // (returns false) when the sample isn't decoded yet.
  private slice(key: string, dur: number, vol: number, panv = 0, send = 0, rate = 1): boolean {
    const buf = this.buffers[key]; if (!buf || !this.ctx) return false;
    const t = this.now();
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    const off = Math.random() * Math.max(0, buf.duration - dur - 0.05);
    const eg = this.g(0); src.connect(eg); eg.connect(this.bus(vol, panv, send));
    eg.gain.setValueAtTime(0.0001, t); eg.gain.linearRampToValueAtTime(1, t + 0.006);
    eg.gain.setValueAtTime(1, t + Math.max(0.05, dur - 0.05)); eg.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.start(t, off, dur + 0.03);
    return true;
  }
  // A discrete event recording played from its start (a whole treb fire / crash).
  private oneshot(key: string, vol: number, panv = 0, send = 0, rate = 1): boolean {
    const buf = this.buffers[key]; if (!buf || !this.ctx) return false;
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    src.connect(this.bus(vol, panv, send)); src.start(this.now());
    return true;
  }

  // ---- battle one-shots ----
  clang(vol = 1) {                        // sword/shield: body thud + metal ring + shing
    if (!this.ctx || !this.rl('clang', 0.1)) return;
    if (this.slice(Math.random() < 0.5 ? 'swords1' : 'swords2', 0.3, 0.85 * vol, (Math.random() - 0.5) * 0.6, 0.2, 0.97 + Math.random() * 0.06)) return;
    const t = this.now();
    const out = this.bus(0.5 * vol, (Math.random() - 0.5) * 0.6, 0.26);
    const base = 1050 + Math.random() * 650;
    // metallic ring — inharmonic sine partials, each ringing out (modal synthesis)
    for (const [r, a, dec] of [[1, 0.3, 0.26], [2.05, 0.22, 0.2], [3.16, 0.16, 0.15], [4.42, 0.1, 0.1], [5.9, 0.06, 0.06]] as const) {
      const eg = this.g(0); eg.connect(out);
      this.osc('sine', base * r * (0.99 + Math.random() * 0.02), t, dec + 0.03).connect(eg);
      this.env(eg.gain, t, a, 0.001, dec);
    }
    // high "shing" — a narrow band of high noise, brief
    const sh = this.g(0); sh.connect(out); this.noise(0.07).connect(this.bq('bandpass', 5400, 9)).connect(sh); this.env(sh.gain, t, 0.16, 0.001, 0.06);
    // body — a soft low contact thud so it has weight, not just a thin ting
    const bd = this.g(0); bd.connect(out); this.noise(0.05).connect(this.bq('lowpass', 320)).connect(bd); this.env(bd.gain, t, 0.4, 0.001, 0.045);
  }
  arrow(vol = 1) {                        // a few arrows — an airy thwip
    if (!this.ctx || !this.rl('arrow', 0.06)) return;
    if (this.slice('archers', 0.4, 0.4 * vol, (Math.random() - 0.5) * 0.7, 0.12)) return;
    const t = this.now();
    const out = this.bus(0.16 * vol, (Math.random() - 0.5) * 0.7, 0.12); const eg = this.g(0); eg.connect(out);
    const bp = this.bq('bandpass', 1600, 1.3); this.noise(0.18).connect(bp).connect(eg);
    bp.frequency.setValueAtTime(900, t); bp.frequency.exponentialRampToValueAtTime(2800, t + 0.05); bp.frequency.exponentialRampToValueAtTime(700, t + 0.17);
    this.env(eg.gain, t, 1, 0.008, 0.15);
  }
  volley(vol = 1) {                       // a salvo — two airy noise layers (different lengths)
    if (!this.ctx || !this.rl('volley', 0.16)) return;
    if (this.slice('archers', 1.1, 0.55 * vol, (Math.random() - 0.5) * 0.3, 0.18)) return;
    const t = this.now();
    const out = this.bus(0.24 * vol, 0, 0.2);
    for (const [dur, fc, q, pk] of [[0.5, 2300, 0.7, 0.7], [0.36, 1300, 1.0, 0.4]] as const) {
      const eg = this.g(0); eg.connect(out); const bp = this.bq('bandpass', fc, q); this.noise(dur).connect(bp).connect(eg);
      bp.frequency.setValueAtTime(fc * 1.4, t); bp.frequency.exponentialRampToValueAtTime(fc * 0.4, t + dur * 0.9);
      this.env(eg.gain, t, pk, 0.05, dur * 0.85);
    }
  }
  bolt(vol = 1) {                         // ballista — a thunk-whip (no buzzy saw)
    if (!this.ctx || !this.rl('bolt', 0.06)) return; const t = this.now();
    const out = this.bus(0.32 * vol, (Math.random() - 0.5) * 0.6, 0.16);
    const o = this.osc('triangle', 700, t, 0.13); o.frequency.exponentialRampToValueAtTime(160, t + 0.1);
    const og = this.g(0); o.connect(this.bq('lowpass', 1700)).connect(og); og.connect(out); this.env(og.gain, t, 0.5, 0.002, 0.11);
    const ng = this.g(0); ng.connect(out); const bp = this.bq('bandpass', 2200, 1.2); this.noise(0.1).connect(bp).connect(ng);
    bp.frequency.setValueAtTime(3000, t); bp.frequency.exponentialRampToValueAtTime(1100, t + 0.09); this.env(ng.gain, t, 0.4, 0.003, 0.09);
  }
  oilHiss(vol = 1) {                      // boiling oil — a scalding hiss + screams carried by the din
    if (!this.ctx || !this.rl('oil', 1.2)) return; const t = this.now();
    const out = this.bus(0.5 * vol, 0, 0.3); const eg = this.g(0); eg.connect(out);
    const bp = this.bq('bandpass', 3400, 0.7); this.noise(0.9).connect(bp).connect(eg);
    bp.frequency.setValueAtTime(4200, t); bp.frequency.exponentialRampToValueAtTime(1400, t + 0.8);
    this.env(eg.gain, t, 1, 0.03, 0.8);
  }
  trebFire(vol = 1) {                     // trebuchet — groaning arm + release thunk
    if (!this.ctx || !this.rl('treb', 0.12)) return;
    if (this.oneshot('trebFire', 0.8 * vol, (Math.random() - 0.5) * 0.4, 0.2)) return;
    const t = this.now();
    const out = this.bus(0.6 * vol, (Math.random() - 0.5) * 0.4, 0.22);
    const creak = this.g(0); creak.connect(out);
    const o = this.osc('sawtooth', 58, t, 0.4); o.frequency.linearRampToValueAtTime(112, t + 0.26);
    o.connect(this.bq('lowpass', 460)).connect(creak); this.env(creak.gain, t, 0.32, 0.06, 0.34);
    const t2 = t + 0.27, thunk = this.g(0); thunk.connect(out);
    const th = this.osc('sine', 150, t2, 0.24); th.frequency.exponentialRampToValueAtTime(56, t2 + 0.2);
    th.connect(thunk); this.env(thunk.gain, t2, 0.75, 0.003, 0.2);
    this.noise(0.12).connect(this.bq('bandpass', 800, 1)).connect(this.gWith(0.28, out));
  }
  impact(vol = 1) {                       // boulder strikes stone — boom + crack + rubble
    if (!this.ctx || !this.rl('impact', 0.05)) return;
    if (this.oneshot('trebHit', 0.85 * vol, (Math.random() - 0.5) * 0.5, 0.3)) return;
    const t = this.now();
    const out = this.bus(0.9 * vol, (Math.random() - 0.5) * 0.5, 0.34);
    const bg = this.g(0); bg.connect(out); const o = this.osc('sine', 130, t, 0.45); o.frequency.exponentialRampToValueAtTime(40, t + 0.32); o.connect(bg); this.env(bg.gain, t, 0.7, 0.002, 0.36);
    const cg = this.g(0); cg.connect(out); this.noise(0.04).connect(this.bq('bandpass', 1800, 1.4)).connect(cg); this.env(cg.gain, t, 0.32, 0.001, 0.04);
    const rg = this.g(0); rg.connect(out); const lp = this.bq('lowpass', 1800); this.noise(0.34).connect(lp).connect(rg); lp.frequency.setValueAtTime(2000, t); lp.frequency.exponentialRampToValueAtTime(360, t + 0.32); this.env(rg.gain, t, 0.42, 0.002, 0.32);
  }
  breach(vol = 1) {                       // a wall comes down — deep boom + long rubble + cracks
    if (!this.ctx) return;
    if (this.oneshot('trebHit', 1.0 * vol, (Math.random() - 0.5) * 0.4, 0.45, 0.8)) return; // pitched down = a bigger collapse
    const t = this.now();
    const out = this.bus(1.0 * vol, (Math.random() - 0.5) * 0.4, 0.5);
    const bg = this.g(0); bg.connect(out); const o = this.osc('sine', 95, t, 0.7); o.frequency.exponentialRampToValueAtTime(30, t + 0.5); o.connect(bg); this.env(bg.gain, t, 0.85, 0.003, 0.55);
    const rg = this.g(0); rg.connect(out); const lp = this.bq('lowpass', 1400); this.noise(0.9).connect(lp).connect(rg); lp.frequency.setValueAtTime(1600, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.8); this.env(rg.gain, t, 0.6, 0.004, 0.85);
    for (let i = 0; i < 6; i++) { const tc = t + 0.05 + Math.random() * 0.75; const cg = this.g(0); cg.connect(out);
      const n = this.ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; n.start(tc); n.stop(tc + 0.05);
      n.connect(this.bq('bandpass', 900 + Math.random() * 1800, 7)).connect(cg); this.env(cg.gain, tc, 0.42, 0.001, 0.05); }
  }
  cavalry(vol = 1) {                      // recorded charge — thundering hooves as horse hits home
    if (!this.ctx || !this.rl('cav', 1.6)) return;
    this.oneshot('cavalry', 0.7 * vol, (Math.random() - 0.5) * 0.4, 0.2); // no synth fallback — silent until loaded
  }
  // war horn — two slightly-detuned saw stacks through a lowpass (warm brass), with reverb
  horn(mood: 'call' | 'victory' | 'defeat' = 'call') {
    if (!this.ctx) return; this.ensure(); const t = this.now();
    const out = this.bus(0.5, 0, 0.32);
    const seq = mood === 'victory' ? [[174.6, 0, 0.4], [220, 0.32, 0.4], [261.6, 0.62, 0.95]]
      : mood === 'defeat' ? [[146.8, 0, 0.7], [110, 0.5, 1.15]]
      : [[146.8, 0, 0.55], [220, 0.42, 0.8]];
    for (const [f, off, len] of seq) {
      const tt = t + off, eg = this.g(0), lp = this.bq('lowpass', 1500); eg.connect(out); lp.connect(eg);
      for (const [m, a] of [[1, 1], [2, 0.5], [3, 0.28], [4, 0.14]] as const)
        for (const det of [0.997, 1.003]) { const o = this.osc('sawtooth', f * m * det, tt, len + 0.12); o.connect(this.gWith(a * 0.5, lp)); }
      this.env(eg.gain, tt, 1, 0.05, len);
    }
  }
  victory() { this.horn('victory'); }
  defeat() {
    if (!this.ctx) return; const t = this.now();
    const out = this.bus(0.8, 0, 0.4); const dg = this.g(0); dg.connect(out);
    const o = this.osc('sine', 90, t, 0.5); o.frequency.exponentialRampToValueAtTime(45, t + 0.4); o.connect(dg);
    this.env(dg.gain, t, 0.8, 0.002, 0.45); this.noise(0.12).connect(this.bq('lowpass', 700)).connect(this.gWith(0.3, out));
    this.horn('defeat');
  }

  // ---- UI feedback (menus) — each ensures the context so the FIRST tap unlocks audio ----
  tap(vol = 1) {
    this.ensure(); if (!this.ctx || !this.rl('tap', 0.02)) return; const t = this.now();
    const out = this.bus(0.12 * vol, 0); const eg = this.g(0); eg.connect(out);
    const o = this.osc('triangle', 560, t, 0.08); o.frequency.exponentialRampToValueAtTime(360, t + 0.06); o.connect(eg);
    this.noise(0.012).connect(this.bq('highpass', 2600)).connect(this.gWith(0.22, eg));
    this.env(eg.gain, t, 1, 0.001, 0.06);
  }
  select(vol = 1) {
    this.ensure(); if (!this.ctx || !this.rl('select', 0.02)) return; const t = this.now();
    const out = this.bus(0.13 * vol, 0); const eg = this.g(0); eg.connect(out);
    const o = this.osc('triangle', 860, t, 0.07); o.frequency.exponentialRampToValueAtTime(1200, t + 0.05); o.connect(eg);
    this.env(eg.gain, t, 1, 0.001, 0.06);
  }
  coin(vol = 1) {
    this.ensure(); if (!this.ctx || !this.rl('coin', 0.04)) return; const t = this.now();
    const out = this.bus(0.22 * vol, 0, 0.12);
    for (const [f, off] of [[1318.5, 0], [1975.5, 0.06]] as const) { const tt = t + off; const eg = this.g(0); eg.connect(out);
      for (const [m, a] of [[1, 1], [2.01, 0.4], [3.0, 0.16]] as const) this.osc('sine', f * m, tt, 0.22).connect(this.gWith(a, eg));
      this.env(eg.gain, tt, 1, 0.002, 0.18); }
  }
  reward(vol = 1) {
    this.ensure(); if (!this.ctx) return; const t = this.now();
    const out = this.bus(0.26 * vol, 0, 0.22);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => { const tt = t + i * 0.09; const eg = this.g(0); eg.connect(out);
      for (const [m, a] of [[1, 1], [2.0, 0.45], [3.01, 0.2], [4.2, 0.08]] as const) this.osc('sine', f * m, tt, 0.5).connect(this.gWith(a, eg));
      this.env(eg.gain, tt, 1, 0.003, 0.42); });
  }
  unlock(vol = 1) {
    this.ensure(); if (!this.ctx) return; const t = this.now();
    const out = this.bus(0.2 * vol, 0, 0.18);
    [784, 988, 1175, 1568].forEach((f, i) => { const tt = t + i * 0.06; const eg = this.g(0); eg.connect(out);
      this.osc('sine', f, tt, 0.3).connect(eg); this.osc('sine', f * 2.01, tt, 0.3).connect(this.gWith(0.3, eg));
      this.env(eg.gain, tt, 1, 0.002, 0.26); });
  }
  denied(vol = 1) {
    this.ensure(); if (!this.ctx || !this.rl('denied', 0.06)) return; const t = this.now();
    const out = this.bus(0.16 * vol, 0);
    for (const [f, off] of [[300, 0], [235, 0.1]] as const) { const tt = t + off; const eg = this.g(0); eg.connect(out);
      const o = this.osc('triangle', f, tt, 0.1); o.connect(this.bq('lowpass', 900)).connect(eg);
      this.env(eg.gain, tt, 1, 0.004, 0.09); }
  }
  commit(vol = 1) {
    this.ensure(); if (!this.ctx || !this.rl('commit', 0.05)) return; const t = this.now();
    const out = this.bus(0.32 * vol, 0, 0.2); const eg = this.g(0); eg.connect(out);
    const o = this.osc('sine', 150, t, 0.22); o.frequency.exponentialRampToValueAtTime(70, t + 0.2); o.connect(eg);
    this.noise(0.05).connect(this.bq('lowpass', 600)).connect(this.gWith(0.3, eg));
    this.env(eg.gain, t, 1, 0.003, 0.2);
  }
  whoosh(up = true, vol = 1) {
    this.ensure(); if (!this.ctx || !this.rl('whoosh', 0.05)) return; const t = this.now();
    const out = this.bus(0.14 * vol, 0); const eg = this.g(0); eg.connect(out);
    const bp = this.bq('bandpass', 600, 0.8); this.noise(0.26).connect(bp).connect(eg);
    bp.frequency.setValueAtTime(up ? 380 : 1500, t); bp.frequency.exponentialRampToValueAtTime(up ? 1700 : 320, t + 0.22);
    this.env(eg.gain, t, 1, 0.04, 0.2);
  }

  startAmbience(level = 0.22) { this.ambBase = level; }
  stopAmbience() { this.ambBase = 0; if (this.ctx) this.ambGain.gain.setTargetAtTime(0, this.now(), 0.4); }

  // Per frame: aggregate combat tallies into distinct clashes over a swelling din.
  update(dt: number, e: SfxTally, intensity: number) {
    if (!this.ctx) return;
    for (let i = 0; i < e.boulders; i++) this.trebFire();
    for (let i = 0; i < Math.min(e.hits, 3); i++) this.impact();
    for (let i = 0; i < e.breaches; i++) this.breach();
    if (e.bolts > 0) this.bolt();
    if (e.oil > 0) this.oilHiss();
    if (e.cavalry > 0) this.cavalry(Math.min(1, e.cavalry / 8));
    if (e.arrows >= 10) this.volley(Math.min(1, e.arrows / 30));
    else if (e.arrows > 0) this.arrow(Math.min(1, e.arrows / 5));
    // a melee is carried by the DIN; clangs punctuate it as distinct clashes
    // (the 0.1s rate-limit inside clang() keeps it to ~10/s, never a machine-gun)
    if (e.melee > 0) { this.clang(0.5 + Math.min(0.45, e.melee / 45)); if (e.melee > 55 && Math.random() < 0.4) this.clang(0.45); }
    if (e.melee > 0) this.heat = Math.min(1.2, this.heat + e.melee * 0.005);
    this.heat *= Math.pow(0.5, dt / 0.9);
    // the score follows the battle: siege heat (engines working) swells the DRUMS,
    // melee heat swells the CRIES — a bombardment thunders, a wall-fight roars
    this.siegeHeat = Math.min(1.2, this.siegeHeat + (e.boulders * 0.25 + e.hits * 0.18 + e.breaches * 0.6));
    this.siegeHeat *= Math.pow(0.5, dt / 2.4);
    if (this.criesGain && this.drumGain) {
      const t = this.now();
      this.criesGain.gain.setTargetAtTime(0.55 + 0.45 * Math.min(1, this.heat), t, 0.7);
      this.drumGain.gain.setTargetAtTime(0.3 + 0.6 * Math.min(1, this.siegeHeat), t, 0.9);
    }
    if (this.ambBase > 0) {
      const lvl = this.ambBase * (0.5 + 0.5 * Math.min(1, intensity)) + this.ambBase * Math.min(1, this.heat);
      this.ambGain.gain.setTargetAtTime(Math.max(0, lvl), this.now(), 0.35);
    }
  }
}

export const battleAudio = new BattleAudioImpl();
