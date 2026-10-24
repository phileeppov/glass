// The demo tune and the touch chime: struck glass, synthesized in the browser. No files, no one else's music.

const BPM = 100;
export const BEAT = 60 / BPM; // s; a thump on every beat, a tick on every off-beat eighth
const BARS = 4;
export const TUNE_LENGTH = BARS * 4 * BEAT; // s, one loop: 9.6
const TAIL = 2.6; // s of ringing after the last bar, folded back onto the start
// 32 kHz holds everything up to 16 kHz and renders a third faster than 48; the browser resamples on playback.
const RATE = 32000;

// Struck glass: a few partials, the higher ones slightly off the harmonic series and quicker to fade.
// [ratio, gain, decay in s]
const GLASS = [
  [1, 1, 1.3],
  [2, 0.35, 0.8],
  [3.01, 0.12, 0.5],
  [4.18, 0.08, 0.3],
  [5.43, 0.05, 0.18],
];
const TOCK = [[1, 1, 0.03], [1.73, 0.6, 0.02]];
const TICK = [[1, 1, 0.018], [1.47, 0.6, 0.012]];
const CLINK = [[1, 1, 0.12], [1.71, 0.7, 0.09], [2.63, 0.4, 0.06]];

// A minor, F, C, G: one chord per bar.
const CHORDS = [[9, 0, 4], [5, 9, 0], [0, 4, 7], [7, 11, 2]];
const ROOTS = [45, 41, 48, 43]; // bass, MIDI
// The arpeggio walks the chord tones between E4 and C7, eight notes a bar.
const STEPS = [0, 2, 4, 5, 4, 2, 3, 1];

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function strike(ctx, out, t, freq, gain, partials = GLASS) {
  for (const [ratio, g, decay] of partials) {
    const f = freq * ratio;
    if (f > ctx.sampleRate / 2.2) continue;
    const osc = ctx.createOscillator();
    osc.frequency.value = f;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * g, t + 0.004);
    // Down to -60 dB and stop: each oscillator costs render time for as long as it runs.
    env.gain.exponentialRampToValueAtTime(gain * g * 1e-3, t + decay * 2);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + decay * 2 + 0.01);
  }
}

// A soft thump under each beat: a sine falling in pitch, plus a short glass tock for the attack.
function thump(ctx, out, t) {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(48, t + 0.12);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(0.9, t + 0.005);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
  osc.connect(env).connect(out);
  osc.start(t);
  osc.stop(t + 0.4);
  strike(ctx, out, t, 1800, 0.12, TOCK);
}

// Reverb from an impulse of decaying noise: the room the glass rings in.
function room(ctx, seconds) {
  const len = Math.round(seconds * ctx.sampleRate);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp((-i / ctx.sampleRate) * 2.6);
  }
  const node = ctx.createConvolver();
  node.buffer = ir;
  return node;
}

// One loop plus its ringing tail; the tail is folded back onto the start, so the last bar rings into the first and the loop has no seam.
// No AudioContext needed, so it can render before the first tap on Demo.
export async function renderTune() {
  const total = TUNE_LENGTH + TAIL;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * RATE), RATE);

  const master = ctx.createGain();
  master.gain.value = 0.55;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -14;
  glue.ratio.value = 3;
  glue.connect(master).connect(ctx.destination);
  const dry = ctx.createGain();
  dry.connect(glue);
  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  const reverb = room(ctx, 2.4);
  wet.connect(reverb).connect(glue);
  const bus = ctx.createGain(); // bells, ticks and clinks go to the room; the thump and the bass stay dry
  bus.connect(dry);
  bus.connect(wet);

  // Bass under the bar, ducking after each beat: the tune breathes between the hits.
  const bassGain = ctx.createGain();
  bassGain.gain.value = 0;
  bassGain.connect(dry);
  const bass = ctx.createOscillator();
  bass.type = "triangle";
  bass.connect(bassGain);
  bass.start(0);

  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * 4 * BEAT;
    const chord = CHORDS[bar];
    const tones = [];
    for (let m = 64; m <= 96; m++) if (chord.includes(m % 12)) tones.push(m);
    bass.frequency.setValueAtTime(hz(ROOTS[bar]), t0);
    for (let s = 0; s < 8; s++) {
      const t = t0 + s * (BEAT / 2);
      const accent = s % 2 === 0;
      // The last bar climbs at the end, leading back into the first.
      strike(ctx, bus, t, hz(tones[STEPS[s] + (bar === 3 && s > 5 ? 2 : 0)]), accent ? 0.16 : 0.1);
      if (!accent) strike(ctx, bus, t, 6200 + 300 * (s % 4), 0.065, TICK);
    }
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * BEAT;
      thump(ctx, dry, t);
      if (b % 2 === 1) strike(ctx, bus, t, 2350, 0.14, CLINK);
      bassGain.gain.setValueAtTime(0.05, t);
      bassGain.gain.linearRampToValueAtTime(0.22, t + 0.3);
    }
  }
  bassGain.gain.setValueAtTime(0.22, TUNE_LENGTH - 0.02);
  bassGain.gain.linearRampToValueAtTime(0, TUNE_LENGTH);
  bass.stop(TUNE_LENGTH + 0.01);

  const full = await ctx.startRendering();
  const len = Math.round(TUNE_LENGTH * RATE);
  const out = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: RATE });
  for (let c = 0; c < 2; c++) {
    const src = full.getChannelData(c);
    const dst = src.slice(0, len);
    for (let i = len; i < src.length; i++) dst[i - len] += src[i];
    out.copyToChannel(dst, c);
  }
  return out;
}

// One quiet glass note on a touch, a step along a pentatonic scale so repeated taps make a little tune.
const CHIME = [81, 84, 86, 88, 91, 93];
let chimeStep = 0;
export function chime(ctx, out) {
  chimeStep = (chimeStep + 1 + Math.floor(Math.random() * 2)) % CHIME.length;
  strike(ctx, out, ctx.currentTime + 0.01, hz(CHIME[chimeStep]), 0.07);
}
