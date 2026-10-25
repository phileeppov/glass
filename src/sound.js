// Sound in, a few numbers out: loudness, bass, eight frequency bands and beats,
// read from the demo tune, a track or the mic with Web Audio.
// Nothing is uploaded: the mic and the track are only analysed in the browser.
import { BEAT, TUNE_LENGTH, chime, renderTune } from "./tune.js";

/** @typedef {"off" | "demo" | "mic" | "track"} SoundMode */

const FFT = 2048;
// Eight bands from 40 Hz to 12 kHz, evenly spaced on a log scale. The shader lays them along the rainbow fringe,
// low to high as red to violet, the way glass splits light: long waves on one side, short on the other.
export const BANDS = 8;
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => 40 * 300 ** (i / BANDS));

// Peak picking on an onset curve: fires just past the top of a rise well above the recent mean,
// with strength against the recent strongest onset.
class Onset {
  mean = 0;
  dev = 0;
  rise = 0; // the onset being climbed now
  peak = 0; // the strongest recent one
  since = 1;

  constructor(gap) {
    this.gap = gap; // s, so one hit doesn't fire twice
  }

  step(v, dt, gate) {
    this.since += dt;
    const over = v - this.mean - 1.5 * this.dev;
    const k = 1 - Math.exp(-dt / 0.6);
    this.mean += (v - this.mean) * k;
    this.dev += (Math.abs(v - this.mean) - this.dev) * k;
    this.peak *= Math.exp(-dt / 3);
    if (over > 0.1 && over > this.rise * 0.6 && gate) {
      this.rise = Math.max(this.rise, over);
      return 0;
    }
    if (this.rise <= 0) return 0;
    this.peak = Math.max(this.peak, this.rise);
    const strength = this.since > this.gap ? this.rise / this.peak : 0;
    if (strength) this.since = 0;
    this.rise = 0;
    return strength;
  }
}

export class Sound {
  /** @type {SoundMode} */
  mode = "off"; // what is actually playing
  /** @type {SoundMode} */
  wanted = "off"; // the last choice; a mic that answers after the user moved on is dropped
  name = ""; // track file name
  level = 0; // loudness 0..1, against the recent peak, so a quiet track moves the glass as much as a loud one
  bass = 0; // 40–160 Hz, 0..1, the same way
  bands = new Float32Array(BANDS); // 0..1 each, the same way
  hit = 0; // a beat: jumps up, then fades over ~0.35 s

  ctx = null;
  analyser = null;
  out = null; // MediaStreamDestination: the sound that goes into the video
  audio = null;
  tune = null; // the demo tune, rendered once on the first tap of Demo
  demoBus = null;
  demoSource = null;
  demoStart = 0; // context time when the tune started
  lastPos = 0; // where in the tune the last frame was, s
  micStream = null;
  micSource = null;
  time = null;
  freq = null;
  prev = null;
  prevMag = null;
  peakLevel = 0;
  peakBass = 0;
  peakBands = new Float32Array(BANDS);
  peakLowFlux = 0;
  peakLogFlux = 0;
  beats = new Onset(0.14);
  sig = 0; // a few samples of the last buffer, to spot a frame with no new audio
  wait = 0; // time since the last frame that had new audio, s
  last = { level: 0, bass: 0, bands: new Float32Array(BANDS) };

  // The context starts on the first tap: browsers only let audio run after one.
  ensure() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = FFT;
    // Smoothing is done here, per frame, with a fast attack: the analyser's own smoothing blunts the beat.
    this.analyser.smoothingTimeConstant = 0;
    this.out = ctx.createMediaStreamDestination();
    this.time = new Float32Array(FFT);
    this.freq = new Float32Array(FFT / 2);
    this.prev = new Float32Array(FFT / 2);
    this.prevMag = new Float32Array(FFT / 2);

    this.audio = new Audio();
    this.audio.loop = true;
    this.audio.preload = "auto";
    this.audio.setAttribute("playsinline", "");
    const track = ctx.createMediaElementSource(this.audio);
    track.connect(this.analyser);
    track.connect(ctx.destination);
    track.connect(this.out);

    // The demo tune plays quietly, about 7 dB under the tune itself: a first taste, not a soundtrack.
    this.demoBus = ctx.createGain();
    this.demoBus.gain.value = 0.42;
    this.demoBus.connect(this.analyser);
    this.demoBus.connect(ctx.destination);
    this.demoBus.connect(this.out);
  }

  // The tune renders once, ahead of time if the page asks, so Demo starts at once. A failed render isn't kept.
  prepare() {
    this.tune ??= renderTune().catch((e) => {
      this.tune = null;
      throw e;
    });
    return this.tune;
  }

  async demo() {
    this.wanted = "demo";
    this.ensure();
    this.audio.pause();
    this.stopMic();
    this.session("playback");
    const resumed = this.ctx.resume();
    const buffer = await this.prepare();
    await resumed;
    if (this.wanted !== "demo") return;
    this.playTune(buffer);
    this.restart();
    this.mode = "demo";
  }

  playTune(buffer) {
    this.stopTune();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.demoBus);
    src.start();
    this.demoSource = src;
    this.demoStart = this.ctx.currentTime;
    // Just before the first beat, so the opening thump counts.
    this.lastPos = TUNE_LENGTH - (this.ctx.outputLatency || 0) - 0.001;
  }

  // Demo beats come from the score, not the detector: the tune is ours, so they land exactly, the first one included.
  // They fall on the thumps, beats one and three: one accent every two beats.
  score() {
    const len = TUNE_LENGTH;
    const pos = (((this.ctx.currentTime - (this.ctx.outputLatency || 0) - this.demoStart) % len) + len) % len;
    const prev = this.lastPos;
    this.lastPos = pos;
    const crossed = (step) => pos < prev || Math.floor(pos / step) !== Math.floor(prev / step);
    return { beat: crossed(2 * BEAT) ? 1 : 0 };
  }

  stopTune() {
    try {
      this.demoSource?.stop();
    } catch {
      // Already stopped.
    }
    this.demoSource?.disconnect();
    this.demoSource = null;
  }

  // Back to the first beat: a video in Demo is exactly one loop of the tune.
  async rewind() {
    if (this.mode !== "demo") return;
    this.playTune(await this.tune);
  }

  // A touch on the icon rings the glass. Not while sound is on: the tune, the track or the mic has the floor.
  chime() {
    if (this.mode !== "off") return;
    this.ensure();
    this.ctx.resume();
    chime(this.ctx, this.ctx.destination);
  }

  // The first frames after a switch compare against an old spectrum and would fire a false beat.
  restart() {
    this.beats.since = -0.25;
  }

  // iPhone mutes Web Audio with the silent switch unless the page says it plays media.
  session(type) {
    try {
      if (navigator.audioSession) navigator.audioSession.type = type;
    } catch {
      // Older Safari: no Audio Session API, the silent switch applies.
    }
  }

  async mic() {
    this.wanted = "mic";
    this.ensure();
    this.audio.pause();
    this.stopTune();
    this.session("play-and-record");
    const resumed = this.ctx.resume();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("insecure");
    // Music needs the raw signal: echo cancellation and noise suppression eat the beat.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await resumed;
    if (this.wanted !== "mic") return void stream.getTracks().forEach((t) => t.stop());
    this.stopMic();
    this.micStream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    // To the analyser and the video, not to the speakers: that would feed back.
    this.micSource.connect(this.analyser);
    this.micSource.connect(this.out);
    this.restart();
    this.mode = "mic";
  }

  // Play a new file, or resume the one already loaded.
  async track(file) {
    this.wanted = "track";
    this.ensure();
    this.stopMic();
    this.stopTune();
    this.session("playback");
    if (file) {
      if (this.audio.src) URL.revokeObjectURL(this.audio.src);
      this.audio.src = URL.createObjectURL(file);
      this.name = file.name;
    }
    this.restart();
    this.mode = "track";
    // play() comes first, in the same tick as the tap: iPhone refuses it after an await.
    const playing = this.audio.play();
    await Promise.all([playing, this.ctx.resume()]);
    if (this.wanted !== "track") this.audio.pause();
  }

  get hasTrack() {
    return !!this.audio?.src;
  }

  off() {
    this.wanted = this.mode = "off";
    this.audio?.pause();
    this.stopTune();
    this.stopMic();
  }

  stopMic() {
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSource = null;
    this.micStream = null;
  }

  // The sound track for the video.
  get audioTrack() {
    return this.out?.stream.getAudioTracks()[0] ?? null;
  }

  // One step per frame. Returns true while the glass still has something to show,
  // so after Off the values fade out instead of snapping to zero.
  update(dtMs) {
    const dt = Math.min(dtMs, 100) / 1000;
    let reading = null;
    if (this.mode !== "off" && this.ctx?.state === "running") reading = this.analyse(dt);
    if (reading && this.mode === "demo") reading = { ...reading, ...this.score() };
    const { level = 0, bass = 0, bands = null, beat = 0 } = reading ?? {};

    // Soft release everywhere: glass settles, it doesn't snap back.
    this.level = follow(this.level, level, dt, 0.03, 0.45);
    this.bass = follow(this.bass, bass, dt, 0.02, 0.35);
    let loud = this.level + this.bass;
    for (let b = 0; b < BANDS; b++) {
      this.bands[b] = follow(this.bands[b], bands ? bands[b] : 0, dt, 0.01, 0.16);
      loud += this.bands[b];
    }
    this.hit = Math.max(this.hit * Math.exp(-dt / 0.35), beat);

    const alive = loud > 1e-3 || this.hit > 1e-3;
    if (!alive) {
      this.level = this.bass = this.hit = 0;
      this.bands.fill(0);
    }
    return alive || this.mode !== "off";
  }

  analyse(dt) {
    const a = this.analyser;
    a.getFloatTimeDomainData(this.time);
    // On a fast screen a frame can come before new audio has: the same buffer would read as zero flux
    // and cut a beat short. Such a frame repeats the last reading.
    const t = this.time;
    const sig = t[FFT - 1] + 3 * t[FFT - 9] + 7 * t[FFT - 17];
    this.wait += dt;
    if (sig !== 0 && sig === this.sig) return this.last;
    this.sig = sig;
    dt = this.wait;
    this.wait = 0;
    a.getFloatFrequencyData(this.freq);

    let sum = 0;
    for (const v of this.time) sum += v * v;
    const rms = Math.sqrt(sum / this.time.length);

    // Flux, how much the spectrum grew since the last frame, finds the beats: the bass band as is (a kick is
    // the loudest jump there) plus everything up to ~3 kHz on a log scale, where a snare, a clap or a knock
    // near the mic shows up though it has little bass.
    const hz = this.ctx.sampleRate / FFT;
    const b0 = Math.max(1, Math.round(40 / hz));
    const b1 = Math.round(160 / hz);
    const f1 = Math.round(3000 / hz);
    const f2 = Math.min(FFT / 2 - 1, Math.round(12000 / hz)); // the top of the last band
    const raw = new Float32Array(BANDS);
    const count = new Float32Array(BANDS);
    let low = 0;
    let lowFlux = 0;
    let logFlux = 0;
    let band = 0;
    for (let i = 1; i <= f2; i++) {
      const db = this.freq[i];
      const mag = Number.isFinite(db) ? 10 ** (db / 20) : 0;
      const f = i * hz;
      if (i >= b0 && i <= b1) {
        low += mag;
        lowFlux += Math.max(0, mag - this.prevMag[i]);
      }
      while (band < BANDS - 1 && f >= EDGES[band + 1]) band++;
      if (f >= EDGES[0]) {
        raw[band] += mag;
        count[band]++;
      }
      const m = Math.log1p(mag * 1000);
      const d = Math.max(0, m - this.prev[i]);
      if (i <= f1) logFlux += d;
      this.prev[i] = m;
      this.prevMag[i] = mag;
    }
    low /= b1 - b0 + 1;
    logFlux /= f1;

    // Each value against its own slowly falling peak; the floors keep room noise on the mic from being boosted into motion.
    const slow = Math.exp(-dt / 4);
    this.peakLevel = Math.max(rms, this.peakLevel * slow, 0.02);
    this.peakBass = Math.max(low, this.peakBass * slow, 0.002);
    const level = smooth((rms / this.peakLevel - 0.2) / 0.8);
    const bass = smooth((low / this.peakBass - 0.3) / 0.7);
    const bands = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      const v = count[b] ? raw[b] / count[b] : 0;
      this.peakBands[b] = Math.max(v, this.peakBands[b] * slow, 2e-4);
      bands[b] = smooth((v / this.peakBands[b] - 0.25) / 0.75);
    }

    const decay = Math.exp(-dt / 3);
    this.peakLowFlux = Math.max(lowFlux, this.peakLowFlux * decay, 1e-3);
    this.peakLogFlux = Math.max(logFlux, this.peakLogFlux * decay, 0.05);
    // On a house track kicks come out at 0.6–1, the off-beat bass and hats near 0.3.
    const beat = this.beats.step(lowFlux / this.peakLowFlux + (0.5 * logFlux) / this.peakLogFlux, dt, rms > 0.01);

    this.last = { level, bass, bands };
    return { level, bass, bands, beat };
  }
}

// Envelope: fast up, slower down.
function follow(cur, goal, dt, attack, release) {
  return cur + (goal - cur) * (1 - Math.exp(-dt / (goal > cur ? attack : release)));
}

function smooth(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
