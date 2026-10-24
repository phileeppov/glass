// Sound in, a few numbers out: loudness, bass and beats, read from a track or the mic with Web Audio.
// Nothing is uploaded: the mic and the track are only analysed in the browser.

/** @typedef {"off" | "mic" | "track"} SoundMode */

const FFT = 2048;
const RINGS = 2; // ripples alive at once
const RING_AT = 0.6; // beat strength that sends a ripple
const MIN_GAP = 0.14; // s between beats, so one kick doesn't fire twice

export class Sound {
  /** @type {SoundMode} */
  mode = "off"; // what is actually playing
  /** @type {SoundMode} */
  wanted = "off"; // the last choice; a mic that answers after the user moved on is dropped
  name = ""; // track file name
  level = 0; // loudness 0..1, against the recent peak, so a quiet track moves the glass as much as a loud one
  bass = 0; // 40–160 Hz, 0..1, the same way
  hit = 0; // a beat: jumps up, then fades over ~0.25 s
  rings = []; // ripples from the latest beats, newest first: { age: s, amp: 0..1 }

  ctx = null;
  analyser = null;
  out = null; // MediaStreamDestination: the sound that goes into the video
  audio = null;
  micStream = null;
  micSource = null;
  time = null;
  freq = null;
  prev = null;
  peakLevel = 0;
  peakBass = 0;
  prevMag = null;
  peakLowFlux = 0;
  peakLogFlux = 0;
  onset = 0; // running mean and spread of the onset strength, for the beat threshold
  onsetDev = 0;
  rise = 0; // the onset being climbed now
  peakOver = 0; // the strongest recent onset
  sinceHit = 1;
  sig = 0; // a few samples of the last buffer, to spot a frame with no new audio
  wait = 0; // time since the last frame that had new audio, s
  last = { level: 0, bass: 0 };

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
  }

  // The first frames after a switch compare against an old spectrum and would fire a false beat.
  restart() {
    this.sinceHit = -0.25;
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
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < 1.2);
    this.sinceHit += dt;

    let level = 0;
    let bass = 0;
    let beat = 0;
    if (this.mode !== "off" && this.ctx?.state === "running") ({ level, bass, beat } = this.analyse(dt));

    this.level = follow(this.level, level, dt, 0.02, 0.25);
    this.bass = follow(this.bass, bass, dt, 0.012, 0.18);
    this.hit = Math.max(this.hit * Math.exp(-dt / 0.22), beat);
    // Only strong beats send a ripple; one on every hat would blur into noise.
    if (beat > RING_AT) this.rings = [{ age: 0, amp: beat }, ...this.rings].slice(0, RINGS);

    const alive = this.level > 1e-3 || this.bass > 1e-3 || this.hit > 1e-3 || this.rings.length > 0;
    if (!alive) this.level = this.bass = this.hit = 0;
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
    if (sig !== 0 && sig === this.sig) return { ...this.last, beat: 0 };
    this.sig = sig;
    dt = this.wait;
    this.wait = 0;
    a.getFloatFrequencyData(this.freq);

    let sum = 0;
    for (const v of this.time) sum += v * v;
    const rms = Math.sqrt(sum / this.time.length);

    // Bass from the spectrum. Flux, how much the spectrum grew since the last frame, finds the beats in two ways:
    // in the bass band as is (a kick is the loudest jump there), and up to ~3 kHz on a log scale,
    // where a snare, a clap or a knock near the mic shows up even though it has little bass.
    const hz = this.ctx.sampleRate / FFT;
    const b0 = Math.max(1, Math.round(40 / hz));
    const b1 = Math.round(160 / hz);
    const f1 = Math.round(3000 / hz);
    let low = 0;
    let lowFlux = 0;
    let logFlux = 0;
    for (let i = 1; i <= f1; i++) {
      const db = this.freq[i];
      const mag = Number.isFinite(db) ? 10 ** (db / 20) : 0;
      if (i >= b0 && i <= b1) {
        low += mag;
        lowFlux += Math.max(0, mag - this.prevMag[i]);
      }
      const m = Math.log1p(mag * 1000);
      logFlux += Math.max(0, m - this.prev[i]);
      this.prev[i] = m;
      this.prevMag[i] = mag;
    }
    low /= b1 - b0 + 1;
    logFlux /= f1;

    // The peak falls slowly; the floor keeps room noise on the mic from being boosted into motion.
    this.peakLevel = Math.max(rms, this.peakLevel * Math.exp(-dt / 4), 0.02);
    this.peakBass = Math.max(low, this.peakBass * Math.exp(-dt / 4), 0.002);
    const level = smooth((rms / this.peakLevel - 0.2) / 0.8);
    const bass = smooth((low / this.peakBass - 0.3) / 0.7);

    // Each flux against its own recent peak, so loud and quiet sources work alike; the bass one counts double.
    const decay = Math.exp(-dt / 3);
    this.peakLowFlux = Math.max(lowFlux, this.peakLowFlux * decay, 1e-3);
    this.peakLogFlux = Math.max(logFlux, this.peakLogFlux * decay, 0.05);
    const onset = lowFlux / this.peakLowFlux + (0.5 * logFlux) / this.peakLogFlux;

    // A beat is an onset well above its recent mean. It fires just past the top of the rise, and its strength is
    // against the recent strongest beat: on a house track kicks reach 0.6–1, the off-beat bass and hats stay near 0.3.
    const over = onset - this.onset - 1.5 * this.onsetDev;
    const k = 1 - Math.exp(-dt / 0.6);
    this.onset += (onset - this.onset) * k;
    this.onsetDev += (Math.abs(onset - this.onset) - this.onsetDev) * k;
    this.peakOver *= decay;
    let beat = 0;
    if (over > 0.1 && over > this.rise * 0.6 && rms > 0.01) {
      this.rise = Math.max(this.rise, over);
    } else if (this.rise > 0) {
      this.peakOver = Math.max(this.peakOver, this.rise);
      if (this.sinceHit > MIN_GAP) {
        beat = this.rise / this.peakOver;
        this.sinceHit = 0;
      }
      this.rise = 0;
    }
    this.last = { level, bass };
    return { level, bass, beat };
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
