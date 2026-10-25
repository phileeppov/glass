// The demo tune and the glass as an instrument, synthesized in the browser: a lo-fi loop of electric piano, a dusty kit
// and a record's crackle, and a glass handpan under your finger. No files, no one else's music.

// 24 kHz holds everything up to 12 kHz, past the tape's darker top, and renders twice as fast as 48; the browser
// resamples on playback.
const RATE = 24000;
const TAIL = 3; // s of ringing after the last bar, folded back onto the start
// The tune comes out at the loudness of a video in a feed, about -16 LUFS. The page plays it quieter (see sound.js).
const LOUD = -16;

const BPM = 80;
const BARS = 4;
const SWING = 0.32; // the off sixteenths come this share of a sixteenth late
export const LOOP = (BARS * 4 * 60) / BPM; // s: one loop, 12

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// A fixed sequence of small variations, so a hat isn't the same twice and the tune renders the same every time.
function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

// --- Instruments: a context, where the sound goes, when, and a few numbers of its own ---

// One sine with a quick attack and an exponential ring down to -60 dB. wob, if given, bends it with the tape.
function partial(ctx, out, t, f, gain, ring, attack = 0.002, wob = null) {
  if (f > ctx.sampleRate / 2.2 || gain <= 0) return;
  const osc = ctx.createOscillator();
  osc.frequency.value = f;
  wob?.(osc.detune);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + attack);
  env.gain.exponentialRampToValueAtTime(gain * 1e-3, t + attack + ring);
  osc.connect(env).connect(out);
  osc.start(t);
  osc.stop(t + attack + ring + 0.01);
}

function panned(ctx, out, pan) {
  if (!pan) return out;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  p.connect(out);
  return p;
}

// White noise, made once per context: hats, the snare, the striker's click, the finger's thump.
const noises = new WeakMap();
function noiseBuffer(ctx) {
  let buf = noises.get(ctx);
  if (!buf) {
    const rand = seeded(7);
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
    noises.set(ctx, buf);
  }
  return buf;
}

function noise(ctx, out, t, gain, { type = "highpass", f = 8000, q = 0.7, attack = 0.001, ring = 0.05, pan = 0, from = 0 } = {}) {
  if (gain <= 0) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const flt = biquad(ctx, type, f, q);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + attack);
  env.gain.exponentialRampToValueAtTime(gain * 1e-3, t + attack + ring);
  src.connect(flt).connect(env).connect(panned(ctx, out, pan));
  src.start(t, from % 1.9);
  src.stop(t + attack + ring + 0.01);
}

// Crystal: a struck wine glass. Its partials sit off the harmonic series (1, 2.32, 4.25, 6.63) and the higher ones die
// first; the fundamental is doubled a hair apart, so it beats slowly the way a real glass shimmers. bright scales the
// upper partials and the striker's click: 0 is a soft mallet, 1 a fingernail.
const CRYSTAL = [[1, 1, 1], [2.32, 0.26, 0.42], [4.25, 0.09, 0.2], [6.63, 0.03, 0.1]];
function crystal(ctx, out, t, freq, gain, { ring = 1.6, bright = 1, wob = null } = {}) {
  for (const [ratio, g, decay] of CRYSTAL) partial(ctx, out, t, freq * ratio, gain * g * (ratio > 1 ? 0.35 + 0.65 * bright : 1), ring * decay, 0.002, wob);
  partial(ctx, out, t, freq * 1.0017, gain * 0.45, ring * 0.85, 0.004, wob);
  noise(ctx, out, t, gain * 0.12 * bright, { type: "bandpass", f: Math.min(freq * 4, 9000), q: 1.4, ring: 0.006, from: freq });
}

// An electric piano with its tine and a damper: FM at 1:1 for the body, whose bark fades after the attack, a quick
// metallic partial for the tine, held for dur and then let go. The bus adds the tremolo and the tape.
function rhodes(ctx, out, t, freq, gain, { dur = 2, wob = null } = {}) {
  const ring = Math.min(5, 2.2 + 220 / freq); // low notes ring longer
  const end = t + Math.min(dur, ring) + 0.4;
  const car = ctx.createOscillator();
  car.frequency.value = freq;
  const mod = ctx.createOscillator();
  mod.frequency.value = freq;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0.95 * freq, t);
  depth.gain.setTargetAtTime(0.17 * freq, t, 0.3);
  mod.connect(depth).connect(car.frequency);
  wob?.(car.detune);
  wob?.(mod.detune);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.004);
  env.gain.setTargetAtTime(0, t + 0.004, ring / 6.9);
  env.gain.setTargetAtTime(0, t + dur, 0.07); // the damper
  car.connect(env).connect(out);
  for (const o of [car, mod]) {
    o.start(t);
    o.stop(end);
  }
  partial(ctx, out, t, freq * 14, gain * 0.022, 0.03);
}

// A round kick: a sine falling from 115 Hz, with a short click for the beater. The bus saturates it a little, so a
// phone speaker, which can't play 45 Hz, still hears its upper harmonics.
function kick(ctx, out, t, gain) {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(115, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.09);
  const env = ctx.createGain();
  env.gain.setValueAtTime(1e-4, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  env.gain.exponentialRampToValueAtTime(gain * 1e-3, t + 0.36);
  osc.connect(env).connect(out);
  osc.start(t);
  osc.stop(t + 0.38);
  noise(ctx, out, t, gain * 0.1, { type: "highpass", f: 2500, ring: 0.008, from: 0.3 });
}

function snare(ctx, out, t, gain) {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(230, t);
  osc.frequency.exponentialRampToValueAtTime(170, t + 0.06);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain * 0.45, t + 0.002);
  env.gain.exponentialRampToValueAtTime(gain * 1e-3, t + 0.16);
  osc.connect(env).connect(out);
  osc.start(t);
  osc.stop(t + 0.18);
  noise(ctx, out, t, gain, { type: "bandpass", f: 2400, q: 0.6, ring: 0.24, from: 1.1 });
}

// Sub bass with its octave and twelfth: phone speakers drop the fundamental, and the ear rebuilds it from those.
function bass(ctx, out, t, freq, dur, gain, wob = null) {
  for (const [ratio, g] of [[1, 1], [2, 0.32], [3, 0.08]]) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq * ratio;
    wob?.(osc.detune);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * g, t + 0.012);
    env.gain.setValueAtTime(gain * g, t + dur);
    env.gain.exponentialRampToValueAtTime(gain * g * 1e-3, t + dur + 0.14);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.16);
  }
}

// A record under the needle: soft hiss and sparse crackle, the same all the way through the loop.
function vinyl(ctx, out, length, gain) {
  const rand = seeded(23);
  const n = Math.round(length * ctx.sampleRate);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let hiss = 0;
    for (let i = 0; i < n; i++) {
      hiss += 0.12 * (rand() * 2 - 1 - hiss);
      d[i] += hiss * 0.12;
      if (rand() < 6 / ctx.sampleRate) {
        const a = (0.15 + 0.85 * rand() ** 3) * (rand() < 0.5 ? -1 : 1);
        for (let k = 0; k < 6 && i + k < n; k++) d[i + k] += a * Math.exp(-k / 1.4);
      }
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(biquad(ctx, "highpass", 500)).connect(biquad(ctx, "lowpass", 6500)).connect(g).connect(out);
  src.start(0);
}

// --- The room, the echo and the master ---

// Reverb from decaying noise that darkens as it fades, the way air and walls eat the highs first.
export function room(ctx, seconds) {
  const len = Math.round(seconds * ctx.sampleRate);
  const pre = Math.round(0.012 * ctx.sampleRate);
  const ir = ctx.createBuffer(2, len + pre, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const rand = seeded(11 + c * 7);
    const data = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      const k = 0.08 + 0.8 * Math.exp(-t * 2.2);
      lp += k * (rand() * 2 - 1 - lp);
      data[i + pre] = lp * Math.exp((-t * 6.9) / seconds);
    }
  }
  const node = ctx.createConvolver();
  node.buffer = ir;
  return node;
}

// A ping-pong echo: each repeat on the other side, a little darker than the last.
function echo(ctx, out, time, feedback) {
  const input = ctx.createGain();
  const left = ctx.createDelay(2);
  const right = ctx.createDelay(2);
  left.delayTime.value = right.delayTime.value = time;
  const fb = ctx.createGain();
  fb.gain.value = feedback;
  input.connect(left);
  left.connect(panned(ctx, out, -0.7));
  left.connect(biquad(ctx, "lowpass", 3800)).connect(right);
  right.connect(panned(ctx, out, 0.7));
  right.connect(fb).connect(left);
  return input;
}

function shaper(ctx, drive) {
  const node = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  node.curve = curve;
  return node;
}

function compressor(ctx, threshold, ratio, attack, release, knee = 6) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = threshold;
  c.ratio.value = ratio;
  c.attack.value = attack;
  c.release.value = release;
  c.knee.value = knee;
  return c;
}

function biquad(ctx, type, f, q = 0.7) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

// A slow sine for the tape and the tremolo. Its rate is a whole number of cycles per loop, so the loop has no seam in
// pitch or level.
function lfo(ctx, cycles, amount) {
  const osc = ctx.createOscillator();
  osc.frequency.value = cycles / LOOP;
  const g = ctx.createGain();
  g.gain.value = amount;
  osc.connect(g);
  osc.start(0);
  return g;
}

// Buses for one render, each with its own sends to the room and the echo, all through tape: pitch that drifts a few
// cents (wow and flutter), a darker top and a little saturation.
function desk(ctx) {
  const top = biquad(ctx, "highpass", 28);
  top
    .connect(biquad(ctx, "lowpass", 8500, 0.5))
    .connect(compressor(ctx, -18, 2.5, 0.012, 0.16))
    .connect(shaper(ctx, 1.3))
    .connect(compressor(ctx, -3, 20, 0.002, 0.06, 0))
    .connect(ctx.destination);
  const reverb = room(ctx, 1.8);
  reverb.connect(top);
  const echoIn = echo(ctx, top, (0.75 * 60) / BPM, 0.3);
  const bus = (wet = 0, ech = 0, ...chain) => {
    const input = ctx.createGain();
    let node = input;
    for (const c of chain) node = node.connect(c);
    node.connect(top);
    for (const [gain, to] of [[wet, reverb], [ech, echoIn]]) {
      if (!gain) continue;
      const g = ctx.createGain();
      g.gain.value = gain;
      node.connect(g).connect(to);
    }
    return input;
  };
  // Tape: wow at 6 cycles a loop and flutter at 75, summed into cents for every pitched voice.
  const tape = ctx.createGain();
  lfo(ctx, 6, 7).connect(tape);
  lfo(ctx, 75, 1.6).connect(tape);
  // Tremolo and a slow autopan on the electric piano, as on a suitcase amp.
  const trem = ctx.createGain();
  const auto = ctx.createStereoPanner();
  lfo(ctx, 54, 0.14).connect(trem.gain);
  lfo(ctx, 54, 0.3).connect(auto.pan);
  return {
    kick: bus(0, 0, biquad(ctx, "lowpass", 4200), shaper(ctx, 1.6)),
    bass: bus(0, 0, biquad(ctx, "lowpass", 700), shaper(ctx, 1.2)),
    hats: bus(0.1, 0, biquad(ctx, "lowpass", 7000)),
    snare: bus(0.22, 0, biquad(ctx, "lowpass", 6000)),
    glass: bus(0.35, 0.22, biquad(ctx, "lowpass", 5000)),
    keys: bus(0.22, 0, biquad(ctx, "lowpass", 2300), trem, auto),
    air: bus(0.5),
    wob: (param) => tape.connect(param),
  };
}

// --- The tune ---
// Lo-fi in D minor at 80: an electric piano strummed through a suitcase tremolo, a dusty swung kit, round bass, a
// record's crackle under it, and the glass sighing a few notes at the end of every other bar. Steps are sixteenths.

const at = (bar, step) => {
  const sixteenth = 60 / BPM / 4;
  // Swing goes by the step a note belongs to, so a strum or a hair off the grid doesn't swing it too.
  return Math.max(0, (bar * 16 + step) * sixteenth + (Math.round(step) % 2 ? SWING * sixteenth : 0));
};

const CHORDS = [[50, 53, 57, 60, 64], [46, 50, 53, 57, 60], [53, 57, 60, 64, 67], [52, 55, 60, 62, 67]]; // Dm9, Bbmaj9, Fmaj9, C/E
const ROOTS = [38, 34, 41, 40];
const KICKS = [[0, 7, 10], [0, 10], [0, 7, 10], [0, 10, 13]];
// The glass's one accent lands on the downbeat, and more softly on the kick after the "and" of three.
export const ACCENTS = Array.from({ length: BARS }, (_, bar) => [[at(bar, 0), 1], [at(bar, 10), 0.55]]).flat();

function score(d, ctx) {
  const rand = seeded(9);
  const human = () => (rand() - 0.5) * 0.12; // a few milliseconds off the grid, in steps
  for (let bar = 0; bar < BARS; bar++) {
    for (const s of KICKS[bar]) kick(ctx, d.kick, at(bar, s + human() * 0.3), s === 0 ? 0.75 : s === 7 ? 0.4 : 0.62);
    snare(ctx, d.snare, at(bar, 4 + human()), 0.5);
    snare(ctx, d.snare, at(bar, 12 + human()), 0.5);
    if (bar % 2 === 0) snare(ctx, d.snare, at(bar, 15), 0.08);
    for (let s = 0; s < 16; s += 2) noise(ctx, d.hats, at(bar, s + human()), s % 4 ? 0.09 : 0.14, { f: 6000, ring: 0.035, pan: 0.15, from: bar + s / 16 });
    if (bar === 3) noise(ctx, d.hats, at(bar, 14), 0.12, { f: 6000, ring: 0.2, pan: 0.15, from: 2.2 });
    bass(ctx, d.bass, at(bar, 0), hz(ROOTS[bar]), 0.9, 0.24, d.wob);
    bass(ctx, d.bass, at(bar, 7), hz(ROOTS[bar]), 0.2, 0.17, d.wob);
    bass(ctx, d.bass, at(bar, 10), hz(ROOTS[bar] + 7), 0.55, 0.2, d.wob);
    // The chord, strummed upward, then answered softly on the "a" of two.
    CHORDS[bar].forEach((m, i) => rhodes(ctx, d.keys, at(bar, i * 0.09 + human()), hz(m), 0.25 - i * 0.018, { dur: 1.6, wob: d.wob }));
    CHORDS[bar].slice(1).forEach((m, i) => rhodes(ctx, d.keys, at(bar, 7 + i * 0.07), hz(m), 0.12, { dur: 0.9, wob: d.wob }));
  }
  for (const [bar, s, m] of [[1, 12, 81], [1, 14, 79], [3, 10, 76], [3, 12, 77], [3, 14, 74]]) {
    crystal(ctx, d.glass, at(bar, s), hz(m), 0.1, { ring: 1.6, bright: 0.4, wob: d.wob });
  }
  vinyl(ctx, d.air, LOOP, 0.05); // just the loop: the tail folds back onto the start
}

// One loop plus its tail; the tail is folded back onto the start, so the last bar rings into the first and the loop
// has no seam. No AudioContext needed, so it can render before the first tap on Demo.
export async function renderTune() {
  const ctx = new OfflineAudioContext(2, Math.ceil((LOOP + TAIL) * RATE), RATE);
  score(desk(ctx), ctx);
  const full = await ctx.startRendering();
  const len = Math.round(LOOP * RATE);
  const out = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: RATE });
  const chans = [0, 1].map((c) => {
    const src = full.getChannelData(c);
    const dst = src.slice(0, len);
    for (let i = len; i < src.length; i++) dst[i - len] += src[i];
    return dst;
  });
  // Level: loudness to LOUD, unless the peaks would go past -1 dBFS first.
  const peak = Math.max(...chans.map((ch) => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
  const gain = Math.min(10 ** ((LOUD - loudness(chans, RATE)) / 20), 0.89 / peak);
  chans.forEach((ch, c) => out.copyToChannel(ch.map((v) => v * gain), c));
  return out;
}

// Loudness in LUFS, close enough: K-weighting (a high shelf and a low cut) and the mean power, without gating.
function loudness(chans, rate) {
  const [a, b] = kWeight(rate);
  let sum = 0;
  for (const ch of chans) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, w1 = 0, w2 = 0;
    let power = 0;
    for (const x of ch) {
      const y = a.b0 * x + a.b1 * x1 + a.b2 * x2 - a.a1 * y1 - a.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      const z = b.b0 * y + b.b1 * w1 + b.b2 * w2 - b.a1 * z1 - b.a2 * z2;
      w2 = w1;
      w1 = y;
      z2 = z1;
      z1 = z;
      power += z * z;
    }
    sum += power / ch.length;
  }
  return -0.691 + 10 * Math.log10(sum + 1e-12);
}

// The two K-weighting biquads of ITU-R BS.1770 for any sample rate.
function kWeight(rate) {
  let K = Math.tan((Math.PI * 1681.974450955533) / rate);
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  const Q1 = 0.7071752369554196;
  let a0 = 1 + K / Q1 + K * K;
  const shelf = { b0: (Vh + (Vb * K) / Q1 + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q1 + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q1 + K * K) / a0 };
  K = Math.tan((Math.PI * 38.13547087602444) / rate);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const cut = { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q2 + K * K) / a0 };
  return [shelf, cut];
}

// --- The glass as an instrument ---

// A glass handpan. The middle is the low ding; eight fields sit around it and climb from the bottom up, left and right
// in turn, the way a real handpan is laid out, and lower notes get bigger fields. Celtic D minor (D | A C D E F G A C)
// has no sixth, so whatever you play sits over every chord of the tune, and a few taps already make a phrase.
// r is a field's radius in the glass.
const PAN_ANGLES = [-90, -135, -45, 180, 0, 135, 45, 90]; // degrees, bottom first
export const PAN = [{ x: 0, y: 0, midi: 50, r: 0.3 }, ...[57, 60, 62, 64, 65, 67, 69, 72].map((midi, i) => {
  const a = (PAN_ANGLES[i] * Math.PI) / 180;
  return { x: 0.62 * Math.cos(a), y: 0.62 * Math.sin(a), midi, r: 0.27 - 0.009 * i };
})];

// The field under a point of the glass: the ding in the middle, otherwise the nearest of the eight.
export function fieldAt(x, y) {
  if (Math.hypot(x, y) < PAN[0].r) return PAN[0];
  let best = PAN[1];
  for (const f of PAN.slice(1)) if (Math.hypot(x - f.x, y - f.y) < Math.hypot(x - best.x, y - best.y)) best = f;
  return best;
}

// A handpan note: the fundamental, its octave and its compound fifth, the three a handpan is tuned to, then a few
// higher ones that only live in the strike, and a hair of glass on top; the pitch settles a few cents as the note
// blooms, and a soft thump of the finger. It returns the note, so a resting finger can damp it.
function handpan(ctx, out, t, freq, gain, { pan = 0, ding = false, attack = 0.008 } = {}) {
  const damper = ctx.createGain();
  damper.connect(panned(ctx, out, pan));
  const ring = ding ? 3.2 : 2.4;
  const parts = [[1, 1, 1], [2, ding ? 0.55 : 0.45, 0.7], [3, 0.2, 0.45], [4, 0.07, 0.22], [5.02, 0.045, 0.13], [6.1, 0.025, 0.08], [4.25, 0.03, 0.08]];
  for (const [ratio, g, decay] of parts) {
    if (freq * ratio > ctx.sampleRate / 2.2) continue;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(freq * ratio * 1.004, t);
    osc.frequency.exponentialRampToValueAtTime(freq * ratio, t + 0.08);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * g, t + attack);
    env.gain.exponentialRampToValueAtTime(gain * g * 1e-3, t + attack + ring * decay);
    osc.connect(env).connect(damper);
    osc.start(t);
    osc.stop(t + attack + ring * decay + 0.02);
  }
  partial(ctx, damper, t, freq * 1.0012, gain * 0.35, ring * 0.9, attack + 0.004);
  noise(ctx, damper, t, gain * (ding ? 0.2 : 0.12), { type: "lowpass", f: 1400, ring: 0.03, from: freq / 50 });
  return {
    // A finger resting on the field takes the ring out of it in a few hundredths of a second.
    damp(when) {
      damper.gain.setTargetAtTime(0, when, 0.05);
    },
  };
}

// A touch at x, y of the glass plays its field. The same note in another octave answers, very quietly and a moment
// late, as the fields of a real handpan do.
export function strike(ctx, out, t, x, y) {
  const f = fieldAt(x, y);
  const pan = Math.max(-1, Math.min(1, x)) * 0.6;
  const note = handpan(ctx, out, t, hz(f.midi), f === PAN[0] ? 0.3 : 0.24, { pan, ding: f === PAN[0] });
  const twin = PAN.find((o) => o !== f && o.midi % 12 === f.midi % 12);
  if (twin) handpan(ctx, out, t + 0.04, hz(twin.midi), 0.03, { pan: twin.x * 0.6, attack: 0.06 });
  return note;
}

// A wet finger around the rim of a wine glass: one held tone that swells with how fast the finger moves, two sines a
// hair apart so it beats, and the glass's second mode above it. It sings the field's note an octave up, the way a
// glass's rim sings above its knock.
export class Singer {
  constructor(ctx, out, t, x, y) {
    const freq = hz(fieldAt(x, y).midi + 12);
    this.level = ctx.createGain();
    this.level.gain.setValueAtTime(0, t);
    this.level.gain.setTargetAtTime(0.035, t, 0.2);
    this.level.connect(panned(ctx, out, Math.max(-1, Math.min(1, x)) * 0.5));
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.6;
    this.oscs = [vib];
    for (const [ratio, g] of [[1, 1], [1.0013, 0.8], [2.32, 0.1]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq * ratio;
      const depth = ctx.createGain();
      depth.gain.value = freq * ratio * 0.0012;
      vib.connect(depth).connect(osc.frequency);
      const amp = ctx.createGain();
      amp.gain.value = g;
      osc.connect(amp).connect(this.level);
      this.oscs.push(osc);
    }
    for (const o of this.oscs) o.start(t);
  }

  // Called every frame; only a real change in speed schedules anything.
  rub(t, speed) {
    const level = 0.03 + 0.1 * Math.min(1, speed);
    if (Math.abs(level - (this.last ?? 0)) < 0.004) return;
    this.last = level;
    this.level.gain.setTargetAtTime(level, t, 0.12);
  }

  stop(t) {
    this.level.gain.cancelScheduledValues(t);
    this.level.gain.setTargetAtTime(0, t, 0.22);
    for (const o of this.oscs) o.stop(t + 1.6);
  }
}
