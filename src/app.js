// The /glass page: logo upload, sliders, PNG and video export. Everything runs in the browser; nothing goes to a server.
import { GlassRenderer, LOGO_FILL, SDF_SPREAD } from "./renderer.js";
import { buildSdf } from "./sdf.js";
import { Sound } from "./sound.js";
import { TUNE_LENGTH } from "./tune.js";

const LAYER = 1024; // logo textures, px
const EXPORT_PX = 1024;
const VIDEO_PX = 1080;
const SUPERSAMPLE = 2; // PNG is rendered at 2x and scaled down, so edges aren't jagged. Video can't keep 60 fps this way.
const PERIOD = 4000; // one animation loop, ms
const CLIP = 12000; // video with sound, ms: a stretch of the track, not the loop
const TAU = Math.PI * 2;

// Default logo: the brand's ☺, until the user uploads their own.
// Friendly: arc eyes, as if squinting, and a soft shallow smile (picked from ten variants).
const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g fill="none" stroke="#0a0a0a" stroke-width="7" stroke-linecap="round"><circle cx="50" cy="50" r="42"/><path d="M31 46Q37 37 43 46M57 46Q63 37 69 46"/><path d="M34 59Q50 72 66 59"/></g></svg>`;

const root = document.querySelector("[data-glass]");
const canvas = root.querySelector("canvas");
const stage = root.querySelector("[data-stage]");
const fileInput = root.querySelector("input[type=file]");
const pngButton = root.querySelector("[data-png]");
const videoButton = root.querySelector("[data-video]");
const status = root.querySelector("[data-status]");
const shareButton = root.querySelector("[data-share]");
const trackInput = root.querySelector("[data-track]");
const textInput = root.querySelector("[data-text]");
const caption = root.querySelector("[data-caption]");

const tokens = getComputedStyle(document.documentElement);
const BG = {
  light: hexToRgb(tokens.getPropertyValue("--color-off-white")),
  dark: hexToRgb(tokens.getPropertyValue("--color-black")),
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// What is selected in the inputs. Converted to numbers for the shader (target), eased smoothly on screen (ease).
const params = {
  shape: "squircle",
  refraction: 1,
  dispersion: 0.8,
  edge: 0.16,
  motion: 0.5,
  size: 0.8,
  tint: null,
  sides: "all",
  spread: 0.35,
  liquid: 0,
  volume: 0.5,
  depth: 0,
  background: "light",
  bg: BG.light,
};
let angleDeg = 45;
let spin = false;
let volumeOn = false;
let thickness = 0.5;
// Thickness stays when volume is turned off: only depth eases out, so the volume fades instead of collapsing.
const applyVolume = () => {
  params.volume = thickness;
  params.depth = volumeOn ? 1 : 0;
};
let logoColor = "original";
let logoLuma = 0; // average logo luminance 0..1; a dark logo on a dark background is turned white
let autoColor = false; // the color was switched by the code, not by the user
let recording = false;
const sound = new Sound();
let soundOn = false; // the loop runs on the sound clock (see listen)
let clock = 0; // loop phase while sound is on

let renderer;
try {
  renderer = new GlassRenderer(canvas);
} catch {
  root.classList.add("is-unsupported");
  throw new Error("WebGL is not available");
}

// --- Logo ---

async function loadFile(file) {
  if (recording) return; // the logo doesn't change mid-recording
  if (isAudio(file)) return void setSound("track", file); // a song dropped or pasted on the page plays as the track
  textInput.value = "";
  textTurn++; // a word still loading must not replace the file
  if (autoColor) setColor("original");
  if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) {
    await loadSvg(await file.text());
  } else if (file.type.startsWith("image/")) {
    await loadUrl(URL.createObjectURL(file));
  } else {
    say("That file isn't an image. Try an SVG or PNG.");
  }
}

function isAudio(file) {
  return file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name);
}

// Browsers render an SVG without width/height at a tiny size, so set the size from viewBox.
async function loadSvg(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName.toLowerCase() !== "svg") return say("Couldn't read that SVG.");
  solidify(svg);
  const vb = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const w = parseFloat(svg.getAttribute("width") ?? "") || vb[2] || 100;
  const h = parseFloat(svg.getAttribute("height") ?? "") || vb[3] || 100;
  if (!svg.getAttribute("viewBox")) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const k = (LAYER * 2) / Math.max(w, h);
  svg.setAttribute("width", String(w * k));
  svg.setAttribute("height", String(h * k));
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
  await loadUrl(URL.createObjectURL(blob));
}

// Layers with transparency from Figma (opacity, fill-opacity, stroke-opacity) are set to 100%:
// the glass barely sees a semi-transparent logo, so both the logo and the refraction come out pale.
const OPACITY = ["opacity", "fill-opacity", "stroke-opacity"];
function solidify(svg) {
  for (const el of [svg, ...svg.querySelectorAll("*")]) {
    for (const attr of OPACITY) el.removeAttribute(attr);
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", style.replace(/(?:^|;)\s*(?:fill-|stroke-)?opacity\s*:[^;]*/gi, ""));
  }
  for (const css of svg.querySelectorAll("style")) {
    css.textContent = (css.textContent ?? "").replace(/(?:fill-|stroke-)?opacity\s*:[^;}]*;?/gi, "");
  }
}

async function loadUrl(url) {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    return say("Couldn't open that image.");
  }
  try {
    buildLogo(img, trim(img));
  } catch {
    // For example, an SVG with <foreignObject> (background blur from Figma): the browser won't let us read the pixels.
    return say("Couldn't open that image.");
  } finally {
    URL.revokeObjectURL(url);
  }
  say("");
  fitColorToBackground();
  applyColor();
  draw();
  kick();
}

// Typed text or an emoji becomes the logo through the same distance field as an upload:
// letters in Onest, the page's font, emoji in the system's color emoji font.
const TEXT_FONT = `600 400px Onest, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
let textTurn = 0;

async function loadText(text) {
  if (recording) return;
  const turn = ++textTurn;
  if (autoColor) setColor("original");
  if (!text) return loadSvg(DEMO_SVG); // an empty field brings back the ☺
  try {
    await document.fonts.load(TEXT_FONT, text);
  } catch {
    // Onest didn't load: the fallback font draws it.
  }
  if (turn !== textTurn) return; // typed on since
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = TEXT_FONT;
  c.width = Math.ceil(ctx.measureText(text).width + 240);
  c.height = 720;
  ctx.font = TEXT_FONT; // resizing the canvas resets its state
  if ("letterSpacing" in ctx) ctx.letterSpacing = "-16px"; // the page's −4% tracking at 400 px
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#0a0a0a";
  ctx.fillText(text, c.width / 2, c.height / 2);
  buildLogo(c, trim(c));
  say("");
  fitColorToBackground();
  applyColor();
  draw();
  kick();
}

// Trim empty margins around the logo: the effect only shows when the artwork reaches the rim.
function trim(img) {
  // An <img> has natural size; a canvas with typed text only has its own.
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const k = Math.min(1, 1024 / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  const data = pixels(w, h, (ctx) => ctx.drawImage(img, 0, 0, w, h));
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: iw, h: ih };
  return { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k };
}

// Two textures: a distance field for the shape, and color extended past the edge so the blurred rim doesn't darken.
function buildLogo(img, crop) {
  const k = (LAYER * LOGO_FILL) / Math.max(crop.w, crop.h);
  const w = crop.w * k;
  const h = crop.h * k;
  const place = (ctx) =>
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, (LAYER - w) / 2, (LAYER - h) / 2, w, h);

  const shape = pixels(LAYER, LAYER, place);
  // If the whole PNG is semi-transparent, scale alpha up to full based on the most opaque pixel.
  let maxAlpha = 0;
  for (let i = 3; i < shape.length; i += 4) if (shape[i] > maxAlpha) maxAlpha = shape[i];
  if (maxAlpha > 0 && maxAlpha < 250) for (let i = 3; i < shape.length; i += 4) shape[i] = (shape[i] * 255) / maxAlpha;
  const sdf = buildSdf(shape, LAYER, SDF_SPREAD);

  const color = document.createElement("canvas");
  color.width = color.height = LAYER;
  const ctx = color.getContext("2d", { willReadFrequently: true });
  for (const blur of [24, 6, 0]) {
    ctx.filter = blur ? `blur(${blur}px)` : "none";
    place(ctx);
  }
  ctx.filter = "none";
  const data = ctx.getImageData(0, 0, LAYER, LAYER);
  const px = data.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (shape[i + 3] > 128) {
      r += shape[i];
      g += shape[i + 1];
      b += shape[i + 2];
      n++;
    }
  }
  const avg = n ? [r / n, g / n, b / n] : [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) [px[i], px[i + 1], px[i + 2]] = avg;
    px[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  logoLuma = (0.299 * avg[0] + 0.587 * avg[1] + 0.114 * avg[2]) / 255;
  renderer.setLogo(sdf, color, LAYER);
}

function pixels(w, h, paint) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  paint(ctx);
  return ctx.getImageData(0, 0, w, h).data;
}

function applyColor() {
  params.tint = logoColor === "black" ? hexToRgb(tokens.getPropertyValue("--color-black")) : logoColor === "white" ? [1, 1, 1] : null;
}

// --- Rendering ---

let t0 = performance.now();
let frame = 0;
let last = 0;
let lastTint = [0, 0, 0];

const spinning = () => spin && params.sides !== "all";
const animated = () => params.motion > 0 || spinning();

function phaseAt(now) {
  if (soundOn) return clock;
  return animated() ? ((now - t0) % PERIOD) / PERIOD : 0;
}

// Input state → numbers for the shader. The angle excludes spin; withTurn adds it.
function target(st) {
  if (st.tint) lastTint = st.tint;
  return {
    n: st.shape === "circle" ? 2 : 5,
    refraction: st.refraction,
    dispersion: st.dispersion,
    edge: st.edge,
    motion: st.motion,
    size: st.size,
    tint: lastTint,
    tintMix: st.tint ? 1 : 0,
    sideMix: st.sides === "all" ? 0 : 1,
    sideTwo: st.sides === "two" ? 1 : 0,
    angle: (angleDeg / 180) * Math.PI,
    spread: st.spread,
    liquid: st.liquid,
    volume: st.volume,
    depth: st.depth,
    background: st.background,
    bg: st.bg,
  };
}

// Spin: one turn per loop; with two sides, half a turn, since the pattern repeats.
function withTurn(p, phase) {
  const turn = spinning() ? phase * TAU * (params.sides === "two" ? 0.5 : 1) : 0;
  return { ...p, angle: p.angle + turn };
}

// Easing: each on-screen value chases its target with time constant EASE,
// so the glass flows from square to circle and from one set of sides to another instead of jumping.
const EASE = 90; // ms
const EASED = ["n", "refraction", "dispersion", "edge", "motion", "size", "tintMix", "sideMix", "sideTwo", "angle", "spread", "liquid", "volume", "depth"];
let shown = null;

function ease(goal, dt) {
  if (!shown || reducedMotion) {
    shown = { ...goal };
    return false;
  }
  const a = 1 - Math.exp(-dt / EASE);
  let moving = false;
  for (const key of EASED) {
    const d = goal[key] - shown[key];
    if (Math.abs(d) > 1e-4) {
      shown[key] += d * a;
      moving = true;
    } else shown[key] = goal[key];
  }
  shown.tint = shown.tint.map((c, i) => c + (goal.tint[i] - c) * a);
  shown.background = goal.background;
  shown.bg = goal.bg;
  return moving;
}

function previewSize() {
  const css = stage.clientWidth;
  return Math.min(Math.round(css * Math.min(devicePixelRatio, 2)), 1400);
}

// Sound on top of the settings: bass swells the glass and rocks the rim, a beat flashes refraction and rainbow;
// the shader splits the bands along the fringe, swells the waves, pumps the icon and runs the ripples.
// Silent: the same object, nothing changes.
function live(p) {
  const { level, bass, hit, rings, drops, bands } = sound;
  if (!level && !bass && !hit && !rings.length && !drops.length && !bands.some(Boolean)) return p;
  const [a, b] = rings;
  const packed = new Float32Array(16);
  drops.forEach((d, i) => packed.set([d.x, d.y, d.age, d.amp], i * 4));
  return {
    ...p,
    motion: p.motion + 0.4 * bass,
    volume: p.volume + 0.3 * bass,
    refraction: p.refraction + 0.6 * hit,
    dispersion: p.dispersion + 0.3 * hit,
    sound: [level, bass, hit, 0],
    ring: [a?.age ?? 0, a?.amp ?? 0, b?.age ?? 0, b?.amp ?? 0],
    bands,
    drops: packed,
  };
}

// One sound step. With sound on, the loop clock runs faster when it's loud, so the waves rush with the music.
// The phase is handed over both ways, so turning sound on or off doesn't make the glass jump.
function listen(now, dt) {
  const on = sound.mode !== "off";
  if (on !== soundOn) {
    if (on) clock = phaseAt(now);
    else t0 = now - clock * PERIOD;
    soundOn = on;
  }
  const alive = sound.update(dt);
  if (soundOn) clock = (clock + (dt / PERIOD) * (1 + 1.5 * sound.level)) % 1;
  return alive;
}

// A frame without easing, for resize and after export.
function draw() {
  if (recording) return;
  if (!shown) shown = target(params);
  renderer.setSize(previewSize());
  const phase = phaseAt(performance.now());
  renderer.render(withTurn(live(shown), phase), phase);
}

function loop(now) {
  frame = 0;
  if (recording) return;
  const dt = Math.min(now - last, 100);
  const moving = ease(target(params), dt);
  const hearing = listen(now, dt);
  last = now;
  draw();
  if (moving || animated() || hearing) frame = requestAnimationFrame(loop);
}

// Start redrawing if the loop is idle.
function kick() {
  if (frame || recording) return;
  last = performance.now();
  frame = requestAnimationFrame(loop);
}

new ResizeObserver(() => draw()).observe(stage);

// --- Controls ---

// Read values from the inputs: the browser may restore them after a reload.
for (const input of root.querySelectorAll("input[type=range]")) {
  const box = input.parentElement;
  const val = box.querySelector(".val");
  const set = () => {
    const v = Number(input.value);
    const min = Number(input.min);
    // --p is the thumb position 0..1 for the CSS; .val is the number shown while dragging.
    box.style.setProperty("--p", String((v - min) / (Number(input.max) - min)));
    // The number goes in an attribute, not text: it's a reading, not page copy.
    if (val) val.dataset.v = input.name === "angle" ? `${Math.round(v)}°` : v.toFixed(2);
    if (input.name === "angle") angleDeg = v;
    else if (input.name === "thickness") {
      thickness = v;
      applyVolume();
    } else params[input.name] = v;
  };
  if (input.name === "motion" && reducedMotion) input.value = "0";
  set();
  input.addEventListener("input", () => {
    set();
    kick();
  });
  // Double-click a slider to reset it to the default value.
  input.addEventListener("dblclick", () => {
    input.value = input.defaultValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const spinInput = root.querySelector("input[name=spin]");
spin = spinInput.checked && !reducedMotion;
spinInput.checked = spin;
spinInput.addEventListener("change", () => {
  spin = spinInput.checked;
  kick();
});

const volumeInput = root.querySelector("input[name=volume]");
const syncVolume = () => {
  volumeOn = volumeInput.checked;
  root.dataset.volume = volumeOn ? "on" : "off";
  root.querySelector("input[name=thickness]").disabled = !volumeOn;
  applyVolume();
};
syncVolume();
volumeInput.addEventListener("change", () => {
  syncVolume();
  kick();
});

for (const input of root.querySelectorAll("input[type=radio]")) {
  const apply = () => {
    if (input.name === "shape") params.shape = input.value;
    if (input.name === "sides") {
      params.sides = input.value;
      root.dataset.sides = input.value;
      // Angle and spin do nothing without selected sides, so disable them for real, not just visually.
      for (const el of root.querySelectorAll(".directional input")) el.disabled = input.value === "all";
    }
    if (input.name === "background") {
      params.background = input.value;
      params.bg = input.value === "dark" ? BG.dark : BG.light;
    }
    if (input.name === "color") logoColor = input.value;
  };
  if (input.checked) apply();
  input.addEventListener("change", () => {
    if (!input.checked) return;
    apply();
    if (input.name === "background") {
      fitColorToBackground();
    }
    if (input.name === "color") autoColor = false;
    applyColor();
    kick();
  });
}
applyColor();

// A dark logo disappears on a dark background: turn it white, and back when the background is light again.
// Decided by the logo's own luminance, not just for the demo smiley.
function fitColorToBackground() {
  const dark = params.background === "dark";
  if (dark && (logoColor === "black" || (logoColor === "original" && logoLuma < 0.3))) setColor("white", true);
  else if (!dark && logoColor === "white") setColor(autoColor ? "original" : "black", true);
}

function setColor(c, auto = false) {
  logoColor = c;
  autoColor = auto;
  root.querySelector(`input[name=color][value=${c}]`).checked = true;
  applyColor();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
  fileInput.value = "";
});

// Typing redraws after a short pause; the sample marks fill the field and load at once.
let textTimer = 0;
textInput.addEventListener("input", () => {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => loadText(textInput.value.trim()), 180);
});
for (const sample of root.querySelectorAll("[data-sample]")) {
  sample.addEventListener("click", () => {
    clearTimeout(textTimer);
    textInput.value = sample.dataset.sample;
    loadText(sample.dataset.sample);
  });
}

// A file can be dropped anywhere on the page; while it's being dragged, the stage is highlighted.
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  root.classList.add("is-over");
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) root.classList.remove("is-over");
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  root.classList.remove("is-over");
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});

// --- Sound ---

// Off, Demo, Mic or Track. Demo is a glass tune made in the browser, no permission or file needed.
// Track plays a file, picked with Track itself or dropped on the page.
const soundRadio = (mode) => root.querySelector(`input[name=sound][value=${mode}]`);
const trackRadio = soundRadio("track");
const CAPTION = caption.textContent;

// The line under the buttons says what the video will be: the loop, one round of the tune, or a stretch of the sound.
function showSound(mode) {
  soundRadio(mode).checked = true;
  caption.textContent = mode === "off" ? CAPTION : mode === "demo" ? caption.dataset.demo : caption.dataset.sound;
}

async function setSound(mode, file) {
  showSound(mode);
  try {
    if (mode === "demo") await sound.demo();
    else if (mode === "mic") await sound.mic();
    else if (mode === "track") await sound.track(file);
    else sound.off();
    if (sound.wanted === mode) say(mode === "track" ? `♪ ${sound.name}` : "");
  } catch (e) {
    if (sound.wanted !== mode) return;
    say(soundError(mode, e));
    // Playback refused because there was no tap yet (a file dropped on a fresh page): the track stays, a tap on Track starts it.
    if (mode === "track" && e?.name === "NotAllowedError" && sound.hasTrack) return;
    sound.off();
    showSound("off");
  }
  kick();
}

function soundError(mode, e) {
  const name = e?.name ?? "";
  if (mode === "mic") {
    if (e?.message === "insecure") return "The mic only works on a secure (https) page.";
    if (name === "NotAllowedError" || name === "SecurityError") return "Mic access is blocked. Allow it for this page and try again.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No mic found.";
    if (name === "NotReadableError") return "The mic is busy in another app.";
    return "Couldn't start the mic.";
  }
  if (mode === "demo") return "Couldn't play the demo in this browser.";
  if (name === "NotAllowedError") return "Tap Track to play it.";
  return "Couldn't play that file. Try MP3, M4A or WAV.";
}

for (const input of root.querySelectorAll("input[name=sound]")) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    if (input.value === "track" && !sound.hasTrack) return void trackInput.click();
    setSound(input.value);
  });
}

// The demo tune renders in the background after the first touch anywhere on the page, so Demo starts without a wait.
function warmUp() {
  removeEventListener("pointerdown", warmUp);
  removeEventListener("keydown", warmUp);
  (window.requestIdleCallback ?? setTimeout)(() => sound.prepare().catch(() => {}));
}
addEventListener("pointerdown", warmUp);
addEventListener("keydown", warmUp);

// Track tapped while it's already selected: start it if it's stopped, otherwise pick another file.
trackRadio.parentElement.addEventListener("click", (e) => {
  if (e.target === trackRadio || !trackRadio.checked) return;
  if (!sound.hasTrack || (sound.mode === "track" && !sound.audio.paused)) trackInput.click();
  else setSound("track");
});

trackInput.addEventListener("change", () => {
  const file = trackInput.files?.[0];
  trackInput.value = "";
  if (file) setSound("track", file);
  else showSound(sound.mode);
});
// Picker closed without a file: back to what was playing.
trackInput.addEventListener("cancel", () => showSound(sound.mode));

// --- Presets ---

// Ready-made looks in one click. Studio is the default, in the markup too, so the first screen wows right away.
// Each preset sets shape, sides, background, volume and spin in full; otherwise the look would depend on the previous one.
const PRESETS = {
  // The logo flows into two opposite corners.
  studio: {
    ranges: { size: 0.66, refraction: 1.5, dispersion: 0.95, edge: 0.18, liquid: 0.75, angle: 45, spread: 0.6, thickness: 0.35, motion: 0.5 },
    radios: { sides: "two", background: "light", shape: "squircle" },
    checks: { volume: true, spin: false },
  },
  // Flows into all corners, rainbow patches.
  melt: {
    ranges: { size: 0.6, refraction: 1.2, dispersion: 0.9, edge: 0.22, liquid: 0.85, thickness: 0.45, motion: 0.7 },
    radios: { sides: "all", background: "light", shape: "squircle" },
    checks: { volume: true, spin: false },
  },
  // Thin rainbow along the whole rim, logo almost untouched, without a heavy frame in its color.
  prism: {
    ranges: { size: 0.62, refraction: 1.05, dispersion: 1, edge: 0.14, liquid: 0, thickness: 0.6, motion: 0.5 },
    radios: { sides: "all", background: "light", shape: "squircle" },
    checks: { volume: true, spin: false },
  },
  // Round lens, like the brand stamp.
  lens: {
    ranges: { size: 0.6, refraction: 0.85, dispersion: 1, edge: 0.28, liquid: 0.15, thickness: 0.5, motion: 0.4 },
    radios: { sides: "all", background: "light", shape: "circle" },
    checks: { volume: true, spin: false },
  },
  // Dark background; a dark logo turns white on its own.
  night: {
    ranges: { size: 0.62, refraction: 1.3, dispersion: 1, edge: 0.2, liquid: 0.75, thickness: 0.6, motion: 0.5 },
    radios: { sides: "all", background: "dark", shape: "squircle" },
    checks: { volume: true, spin: false },
  },
};
const PRESET_KEYS = new Set(Object.values(PRESETS).flatMap((p) => [...Object.keys(p.ranges), ...Object.keys(p.radios), ...Object.keys(p.checks)]));
let applyingPreset = false;

// A preset writes values into the inputs themselves, so the glass eases to it the same way as with the sliders.
function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  applyingPreset = true;
  for (const [key, on] of Object.entries(preset.checks)) {
    const el = root.querySelector(`input[name=${key}]`);
    if (el.checked !== on) {
      el.checked = on;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  for (const [key, value] of Object.entries(preset.radios)) {
    const el = root.querySelector(`input[name=${key}][value=${value}]`);
    if (!el.checked) {
      el.checked = true;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  for (const [key, value] of Object.entries(preset.ranges)) {
    if (key === "motion" && reducedMotion) continue;
    const el = root.querySelector(`input[name=${key}]`);
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  applyingPreset = false;
}

for (const input of root.querySelectorAll("input[name=preset]")) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    applyPreset(input.value);
  });
}

// Advanced remembers whether it's open, per visitor, in their own browser.
const advanced = root.querySelector("[data-advanced]");
try {
  if (localStorage.getItem("glass-advanced") === "open") {
    advanced.classList.add("instant");
    advanced.open = true;
    requestAnimationFrame(() => requestAnimationFrame(() => advanced.classList.remove("instant")));
  }
} catch {
  // Storage unavailable: it just stays collapsed.
}
advanced.addEventListener("toggle", () => {
  try {
    localStorage.setItem("glass-advanced", advanced.open ? "open" : "closed");
  } catch {
    // Not saved; that's fine.
  }
});

// Touching a setting a preset controls clears the preset selection: the look is now custom.
const clearPreset = (e) => {
  const name = e.target.name;
  if (applyingPreset || !PRESET_KEYS.has(name)) return;
  for (const input of root.querySelectorAll("input[name=preset]")) input.checked = false;
};
root.addEventListener("input", clearPreset);
root.addEventListener("change", clearPreset);

// Figma's "Copy as SVG" copies text, so accept both text and an image from the clipboard.
document.addEventListener("paste", (e) => {
  const data = e.clipboardData;
  if (!data) return;
  const file = [...data.files].find((f) => f.type.startsWith("image/"));
  // An image or SVG code is the logo, not text for the field, even if the field has focus.
  if (file) {
    e.preventDefault();
    return void loadFile(file);
  }
  const text = data.getData("text/plain").trim();
  if (recording) return;
  if (text.startsWith("<svg") || text.startsWith("<?xml")) {
    e.preventDefault();
    textInput.value = "";
    textTurn++;
    if (autoColor) setColor("original");
    loadSvg(text);
  }
});

// --- Export ---

// The frame is rendered SUPERSAMPLE times larger and scaled down to the final size.
function frameInto(out, p, phase) {
  renderer.setSize(out.width * SUPERSAMPLE);
  renderer.render(p, phase);
  const ctx = out.getContext("2d");
  ctx.clearRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
}

pngButton.addEventListener("click", () => {
  const out = document.createElement("canvas");
  out.width = out.height = EXPORT_PX;
  const phase = phaseAt(performance.now());
  frameInto(out, withTurn(live(target(params)), phase), phase);
  const done = (blob) => {
    if (blob) save(blob, "glass-icon.png");
    draw();
  };
  // iOS only reliably opens the Share sheet in the same tick as the tap, and toBlob responds later,
  // so there the PNG is built synchronously.
  if (ios) done(dataUrlToBlob(out.toDataURL("image/png")));
  else out.toBlob(done, "image/png");
});

videoButton.addEventListener("click", async () => {
  // With sound on, the video carries it: the codecs include audio (AAC in MP4, which X takes), and the clip is a stretch of the track.
  const audio = sound.mode !== "off" ? sound.audioTrack : null;
  const types = audio
    ? ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    : ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  const type = typeof MediaRecorder === "undefined" ? undefined : types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return say("This browser can't record video. Try Chrome or Safari.");
  const demo = sound.mode === "demo";
  const length = !audio ? PERIOD : demo ? TUNE_LENGTH * 1000 : CLIP;

  recording = true;
  // Must reset: otherwise kick() after recording thinks the loop is alive, and the preview freezes.
  cancelAnimationFrame(frame);
  frame = 0;
  videoButton.style.setProperty("--rec", `${length}ms`);
  root.classList.add("is-recording");
  videoButton.disabled = pngButton.disabled = true;
  say(params.background === "none" ? "Recording on light: video can't be transparent." : "Recording…");

  // If the browser can't handle recording (codec, 1080p, bitrate), the page must not be left with disabled buttons.
  let message = "";
  try {
    // Video always has a background: transparent mode records on light. A still video makes no sense, so the shape moves.
    const base = target({
      ...params,
      ...(params.background === "none" ? { background: "light", bg: BG.light } : {}),
      motion: animated() ? params.motion : 0.5,
    });

    // Wide is a 1920×1080 frame for the X feed: the icon square centered, margins in the background color.
    const wide = root.querySelector("input[name=format]:checked")?.value === "wide";
    const frameCanvas = wide ? document.createElement("canvas") : null;
    const frameCtx = frameCanvas?.getContext("2d");
    if (frameCanvas) {
      frameCanvas.width = 1920;
      frameCanvas.height = VIDEO_PX;
    }
    const fill = `rgb(${base.bg.map((c) => Math.round(c * 255)).join(",")})`;
    const paint = (phase, p = base) => {
      renderer.render(withTurn(p, phase), phase);
      if (frameCtx) {
        frameCtx.fillStyle = fill;
        frameCtx.fillRect(0, 0, 1920, VIDEO_PX);
        frameCtx.drawImage(canvas, (1920 - VIDEO_PX) / 2, 0, VIDEO_PX, VIDEO_PX);
      }
    };

    renderer.setSize(VIDEO_PX);
    paint(audio ? clock : 0);
    const video = (frameCanvas ?? canvas).captureStream(60);
    const stream = audio ? new MediaStream([...video.getVideoTracks(), audio]) : video;
    const recorder = new MediaRecorder(stream, {
      mimeType: type,
      videoBitsPerSecond: 16_000_000,
      ...(audio ? { audioBitsPerSecond: 192_000 } : {}),
    });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => (recorder.onstop = () => resolve()));

    // In Demo the video is one round of the tune from its first beat, so the first second already moves.
    if (demo) await sound.rewind();
    recorder.start();
    const start = performance.now();
    let prev = start;
    await new Promise((resolve) => {
      const tick = (now) => {
        const elapsed = now - start;
        if (audio) {
          // The sound keeps driving the glass while recording, on the same clock as the preview.
          listen(now, now - prev);
          paint(clock, live(base));
        } else {
          paint(Math.min(elapsed / PERIOD, 1) % 1);
        }
        prev = now;
        if (elapsed < length) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    recorder.stop();
    await done;
    // Only the canvas track: the sound track belongs to the page and serves the next recording too.
    video.getTracks().forEach((t) => t.stop());

    const mp4 = type.startsWith("video/mp4");
    if (chunks.length) {
      save(new Blob(chunks, { type }), `glass-icon${wide ? "-wide" : ""}.${mp4 ? "mp4" : "webm"}`);
      // X takes MP4 and MOV video; browsers that can't record MP4 (Firefox) write WebM.
      if (!mp4) message = "Saved as WebM. For X, record in Chrome or Safari.";
    } else {
      message = "This browser can't record video. Try Chrome or Safari.";
    }
  } catch {
    message = audio
      ? "This browser can't record video with sound. Turn Sound off to record the loop."
      : "This browser can't record video. Try Chrome or Safari.";
  } finally {
    recording = false;
    root.classList.remove("is-recording");
    videoButton.disabled = pngButton.disabled = false;
    say(message);
    t0 = performance.now();
    frame = 0;
    kick();
  }
});

// --- Share on X ---

// The prefilled post credits only the URL, not an @handle: designers strip a handle like a watermark.
const SHARE_URL = "https://phileeppov.com/glass";
const SHARE_TEXT = "made with";
const SHARE_POST = `${SHARE_TEXT} ${SHARE_URL.replace("https://", "")}`;
const SHARE_LABEL = shareButton.textContent;
// On phones, the system Share sheet with the file. On desktop X is usually not in that menu, so there it's the clipboard and the X composer.
const touch = matchMedia("(pointer: coarse)").matches;
// iPhone and iPad (iPad reports itself as a Mac; the touchscreen gives it away). A regular download there sends the file to Files,
// and X's in-app browser opens the image full screen. So save via the Share sheet: it has Save Image to Photos
// and X right there (the sheet itself was tested on iPhone in Safari and in X's in-app browser; "Download PNG" straight into the sheet was not).
const ios =
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
let lastExport = null;

async function save(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (!ios || !navigator.canShare?.({ files: [file] })) return download(blob, name);
  lastExport = { blob, name, video: blob.type.startsWith("video/") };
  shareButton.hidden = true;
  // The Share sheet only opens right after a tap, and video takes 4 s to record, so for video show the button right away.
  if (lastExport.video) return offerSave();
  try {
    await navigator.share({ files: [file], text: SHARE_POST });
  } catch (e) {
    // Sheet closed, or tapped twice (sheet already open): do nothing. Blocked for any other reason: show the same button.
    const reason = e.name;
    if (reason !== "AbortError" && reason !== "InvalidStateError") offerSave();
  }
}

// On iPhone the button under export is a full button, not a quiet link: without it the file can't be saved.
function offerSave() {
  shareButton.textContent = lastExport?.video ? "Save video" : "Save image";
  shareButton.classList.add("is-save");
  shareButton.hidden = false;
}

shareButton.addEventListener("click", async () => {
  if (!lastExport) return;
  const file = new File([lastExport.blob], lastExport.name, { type: lastExport.blob.type });
  if ((touch || ios) && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: SHARE_POST });
    } catch (e) {
      // Sheet closed: do nothing. On iPhone the file can't be saved without the sheet, so on failure fall back to a regular download.
      if (ios && e.name !== "AbortError") download(file, file.name);
    }
    return;
  }
  // The X composer link only takes text and a URL; the image goes to the clipboard, the video has to be dragged in from downloads.
  let hint = "Attach the video you just downloaded.";
  if (!lastExport.video) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": lastExport.blob })]);
      hint = "Image copied. Paste it into your post.";
    } catch {
      hint = "Attach the image you just downloaded.";
    }
  }
  // A separate window over the page, so the hint on the page stays visible.
  const tab = window.open(
    `https://x.com/intent/post?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SHARE_URL)}`,
    "_blank",
    "popup,width=620,height=720",
  );
  if (tab) tab.opener = null;
  say(tab ? hint : "Pop-up blocked. Allow pop-ups to open X.");
});

// --- Misc ---

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  // On iOS a download is confirmed by hand, so keep the URL for a minute, not a second.
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  // After saving, Share appears: sharing only works on a tap, and by then the file is ready.
  // X most likely won't accept WebM, so don't show the button; the Chrome and Safari hint stays.
  if (blob.type.includes("webm")) {
    lastExport = null;
    shareButton.hidden = true;
    return;
  }
  lastExport = { blob, name, video: blob.type.startsWith("video/") };
  // The button may still be the iPhone "Save …" button from the last export, so turn it back into a link.
  shareButton.classList.remove("is-save");
  shareButton.textContent = touch ? "Share" : SHARE_LABEL;
  shareButton.hidden = false;
}

// Synchronous toBlob replacement for iOS (see "Download PNG").
function dataUrlToBlob(url) {
  const bytes = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return new Blob([out], { type: "image/png" });
}

function say(text) {
  status.textContent = text;
}

function hexToRgb(hex) {
  const h = hex.trim().replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

loadSvg(DEMO_SVG).then(kick);
