// Sound in, a few numbers out: loudness, bass, eight frequency bands, brightness, pitch and beats, read from the demo
// tune, a track or the mic with Web Audio; and sound out, when the glass is played.
// Nothing is uploaded: the mic and the track are only analysed in the browser.
import { ACCENTS, LOOP, Singer, renderTune, room, strike } from "./tune.js";

/** @typedef {"off" | "demo" | "mic" | "track"} SoundMode */

const FFT = 2048;
// The tune and the glass's notes are made at the loudness of a video in a feed; the page plays them 10 dB quieter.
const PAGE = 0.32;
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
  hit = 0; // a beat: rises over a few hundredths of a second, then fades over ~0.35 s
  strike = 0; // the beat as it lands, before the soft rise
  bright = 0; // 0..1, how much of the sound is up high: hats, a cymbal, an "s"
  pitch = 0.5; // 0..1, where the body of the sound sits, 150 Hz to 1.5 kHz on a log scale: a voice going up, a melody
  clip = 0; // where the part of the track a video takes starts, s
  best = 0; // where the strongest 12 s of the track start, s: found when it's loaded
  duration = 0; // the track's length, s
  wave = null; // the track's loudness in slices, for the strip that picks the part
  onStudy = null; // called when a track has been studied

  ctx = null;
  analyser = null;
  out = null; // MediaStreamDestination: the sound that goes into the video
  rec = null; // a limiter in front of it: notes played over a loud bar of the loop don't clip the video
  demoRec = null; // the loop at full level, for the video
  touchBus = null; // where the glass's notes go
  studying = 0; // which track is being studied; an older study that ends late is dropped
  audio = null;
  tune = null; // the demo tune, rendered once
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
  peakBright = 0;
  beats = new Onset(0.14);
  sig = 0; // a few samples of the last buffer, to spot a frame with no new audio
  wait = 0; // time since the last frame that had new audio, s
  last = { level: 0, bass: 0, bands: new Float32Array(BANDS), bright: 0, pitch: 0.5 };
  singer = null;

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
    this.rec = ctx.createDynamicsCompressor();
    this.rec.threshold.value = -2;
    this.rec.knee.value = 0;
    this.rec.ratio.value = 20;
    this.rec.attack.value = 0.002;
    this.rec.release.value = 0.08;
    // The compressor adds its own makeup gain, about 1 dB here: taken back, so a mic or a track records as it was.
    const trim = ctx.createGain();
    trim.gain.value = 0.88;
    this.rec.connect(trim).connect(this.out);
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
    track.connect(this.rec);

    // The tune is made at the loudness of a video in a feed. The page plays it 10 dB quieter, a first taste rather than
    // a soundtrack; the video keeps it at full level, so it doesn't come out faint next to other posts.
    this.demoBus = ctx.createGain();
    this.demoBus.gain.value = PAGE;
    this.demoBus.connect(this.analyser);
    this.demoBus.connect(ctx.destination);
    this.demoRec = ctx.createGain();
    this.demoRec.connect(this.rec);
    this.wireTouch(ctx, ctx.destination, this.rec);
  }

  // The glass's notes ring in a little room, at the page's level on the speakers and at full level into a video, so a
  // tune played on the glass over Demo is recorded with it. They stay out of the analyser: the glass answers a touch
  // on its own, at the field that was struck.
  wireTouch(ctx, speakers, video) {
    this.touchBus = ctx.createGain();
    const out = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    this.touchBus.connect(out);
    this.touchBus.connect(wet).connect(room(ctx, 1.6)).connect(out);
    const page = ctx.createGain();
    page.gain.value = PAGE;
    out.connect(page).connect(speakers);
    // Into the video a little under the loop, which is made as loud as a video gets.
    if (video) {
      const rec = ctx.createGain();
      rec.gain.value = 0.5;
      out.connect(rec).connect(video);
    }
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
    src.connect(this.demoRec);
    src.start();
    this.demoSource = src;
    this.demoStart = this.ctx.currentTime;
    // Just before the first beat, so the opening thump counts.
    this.lastPos = LOOP - (this.ctx.outputLatency || 0) - 0.001;
  }

  // Where in the loop the tune is now, s.
  get position() {
    return (((this.ctx.currentTime - (this.ctx.outputLatency || 0) - this.demoStart) % LOOP) + LOOP) % LOOP;
  }

  // Demo beats come from the score, not the detector: the tune is ours, so they land exactly, the first one included.
  // The downbeat is the strongest.
  score() {
    const pos = this.position;
    const prev = this.lastPos;
    this.lastPos = pos;
    let beat = 0;
    for (const [t, strength] of ACCENTS) {
      const crossed = prev <= pos ? t > prev && t <= pos : t > prev || t <= pos;
      if (crossed) beat = Math.max(beat, strength);
    }
    return { beat };
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
    this.playTune(await this.prepare());
  }

  // A touch plays the glass, in the key of the demo tune, so it can be played along with it. Not over the mic or a
  // track: they have the floor. Returns the note, for a resting finger to damp.
  touch(x, y) {
    if (this.mode === "mic" || this.mode === "track") return null;
    this.ensure();
    this.ctx.resume();
    return strike(this.ctx, this.touchBus, this.ctx.currentTime + 0.005, x, y);
  }

  damp(note) {
    note?.damp(this.ctx.currentTime);
  }

  // A finger drawn across the glass makes it sing like a wine glass, louder the faster it moves.
  sing(x, y) {
    if (this.mode === "mic" || this.mode === "track") return;
    this.ensure();
    this.ctx.resume();
    this.singer?.stop(this.ctx.currentTime);
    this.singer = new Singer(this.ctx, this.touchBus, this.ctx.currentTime, x, y);
  }

  // Sound can start right on the press once the page has been allowed to play; before that only a release may start it.
  get ready() {
    return this.ctx?.state === "running";
  }

  rub(speed) {
    this.singer?.rub(this.ctx.currentTime, speed);
  }

  hush() {
    this.singer?.stop(this.ctx.currentTime);
    this.singer = null;
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
    this.micSource.connect(this.rec);
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
      this.duration = this.best = this.clip = 0;
      this.wave = null;
    }
    this.restart();
    this.mode = "track";
    // play() comes first, in the same tick as the tap: iPhone refuses it after an await.
    const playing = this.audio.play();
    if (file) {
      // The old track's strip goes at once; once the new one's strongest part is found, the track jumps there: what
      // you hear first is what a video would take.
      this.onStudy?.();
      const turn = ++this.studying;
      this.study(file, turn)
        .then((found) => {
          if (!found) return;
          if (this.mode === "track") this.audio.currentTime = this.clip;
          this.onStudy?.();
        })
        .catch(() => {});
    }
    await Promise.all([playing, this.ctx.resume()]);
    if (this.wanted !== "track") this.audio.pause();
  }

  // The strongest 12 s of a track, its chorus or its drop more often than not: the window that's loudest on average,
  // started on the hit nearest before it. Decoded once at a low rate, plenty to hear where the song is loud and where
  // it hits; nothing leaves the browser.
  // A long mix (past 15 minutes, or ~80 MB) isn't studied: decoding it whole could cost a phone its tab. It plays from
  // the start.
  async study(file, turn, seconds = 12) {
    if (file.size > 80e6) return false;
    const length = await new Promise((done) => {
      if (this.audio.readyState >= 1) return done(this.audio.duration);
      this.audio.addEventListener("loadedmetadata", () => done(this.audio.duration), { once: true });
      setTimeout(() => done(NaN), 5000);
    });
    if (turn !== this.studying || !(length <= 15 * 60)) return false;
    const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await file.arrayBuffer());
    if (turn !== this.studying) return false;
    const rate = decoded.sampleRate;
    const hop = Math.round(rate * 0.05);
    const n = Math.floor(decoded.length / hop);
    const chans = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    const loud = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let e = 0;
      for (const ch of chans) for (let i = f * hop; i < (f + 1) * hop; i++) e += ch[i] * ch[i];
      loud[f] = Math.sqrt(e / (hop * chans.length));
    }
    const span = Math.round(seconds / 0.05);
    let best = 0;
    if (n > span) {
      let sum = 0;
      for (let f = 0; f < span; f++) sum += loud[f];
      let top = sum;
      for (let f = 1; f + span <= n; f++) {
        sum += loud[f + span - 1] - loud[f - 1];
        if (sum > top) (top = sum), (best = f);
      }
      // Start on a hit: the sharpest rise in the second before the window, or just inside it.
      let hit = best;
      let rise = 0;
      for (let f = Math.max(1, best - 20); f <= Math.min(n - span, best + 4); f++) {
        const r = Math.log(loud[f] + 1e-6) - Math.log(loud[f - 1] + 1e-6);
        if (r > rise) (rise = r), (hit = f);
      }
      best = hit;
    }
    const slices = 160;
    const wave = new Float32Array(slices);
    for (let s = 0; s < slices; s++) {
      for (let f = Math.floor((s * n) / slices); f < Math.floor(((s + 1) * n) / slices); f++) wave[s] = Math.max(wave[s], loud[f]);
    }
    const peak = Math.max(...wave, 1e-6);
    if (turn !== this.studying) return false;
    this.wave = wave.map((v) => v / peak);
    this.duration = decoded.duration;
    this.best = this.clip = (best * hop) / rate;
    return true;
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
    const { level = 0, bass = 0, bands = null, beat = 0, bright = 0, pitch = 0.5 } = reading ?? {};

    // Soft release everywhere: glass settles, it doesn't snap back.
    this.level = follow(this.level, level, dt, 0.03, 0.45);
    this.bass = follow(this.bass, bass, dt, 0.02, 0.35);
    let loud = this.level + this.bass;
    for (let b = 0; b < BANDS; b++) {
      this.bands[b] = follow(this.bands[b], bands ? bands[b] : 0, dt, 0.01, 0.16);
      loud += this.bands[b];
    }
    // The accent rises over ~50 ms instead of jumping in one frame: a jump reads as a cut in the video.
    this.strike = Math.max(this.strike * Math.exp(-dt / 0.35), beat);
    this.hit = this.strike > this.hit ? follow(this.hit, this.strike, dt, 0.018, 0) : this.strike;
    this.bright = follow(this.bright, bright, dt, 0.02, 0.25);
    // Pitch drifts back to the middle in silence, so the light it turns comes home.
    const voiced = reading && level > 0.2;
    this.pitch = follow(this.pitch, voiced ? pitch : 0.5, dt, 0.12, voiced ? 0.12 : 0.8);
    loud += this.bright + Math.abs(this.pitch - 0.5);

    const alive = loud > 1e-3 || this.hit > 1e-3;
    if (!alive) {
      this.level = this.bass = this.hit = this.strike = this.bright = 0;
      this.pitch = 0.5;
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
    let all = 0;
    let high = 0;
    let body = 0;
    let bodyLog = 0;
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
        all += mag;
        if (f >= 2500) high += mag;
      }
      if (f >= 120 && f <= 2500) {
        body += mag;
        bodyLog += mag * Math.log2(f);
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

    // Brightness: the share of the sound above 2.5 kHz, against its own recent peak.
    const share = all > 0 ? high / all : 0;
    this.peakBright = Math.max(share, this.peakBright * slow, 0.04);
    // Weighed by loudness: a quiet room's hiss is all highs, and mustn't open the fringe.
    const bright = smooth((share / this.peakBright - 0.15) / 0.85) * level;
    // Pitch: the centre of the 120 Hz–2.5 kHz energy on a log scale, while there's something to hear; otherwise it holds.
    const pitch = rms > 0.004 && body > 0 ? Math.min(1, Math.max(0, (bodyLog / body - Math.log2(150)) / Math.log2(10))) : this.last.pitch;

    const decay = Math.exp(-dt / 3);
    this.peakLowFlux = Math.max(lowFlux, this.peakLowFlux * decay, 1e-3);
    this.peakLogFlux = Math.max(logFlux, this.peakLogFlux * decay, 0.05);
    // On a house track kicks come out at 0.6–1, the off-beat bass and hats near 0.3.
    const beat = this.beats.step(lowFlux / this.peakLowFlux + (0.5 * logFlux) / this.peakLogFlux, dt, rms > 0.01);

    this.last = { level, bass, bands, bright, pitch };
    return { level, bass, bands, beat, bright, pitch };
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
