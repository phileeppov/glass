// The /glass page: logo upload, sliders, PNG and video export. Everything runs in the browser; nothing goes to a server.
import { GlassRenderer, ICON_SCALE, LOGO_FILL, SDF_SPREAD } from "./renderer.js";
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
const afterBox = root.querySelector("[data-after]");

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
  facets: false,
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
let logoLuma = 0; // average logo luminance 0..1; a dark logo on a dark background is turned white, a white one on light black
let fill = false; // a photo or an icon on its own plate: it covers the glass edge to edge instead of sitting on it
let stroke = "bold"; // how thick the logo's thickest part is: thin, mid, bold, or fill for a photo (see buildLogo)
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

// --- Telling ---

// What people do here, by name, for whoever listens. On phileeppov.com a separate script counts these anonymously:
// the name only, never a logo, a file name or a value. Here nobody listens, and nothing leaves the page.
function tell(name) {
  root.dispatchEvent(new CustomEvent("glass:tell", { detail: name }));
}

// --- Logo ---

// via: how the user brought it, "file", "drop" or "paste"; the demo ☺ and typed text come without one.
async function loadFile(file, via) {
  if (recording) return; // the logo doesn't change mid-recording
  if (isAudio(file)) return void setSound("track", file); // a song dropped or pasted on the page plays as the track
  textInput.value = "";
  textTurn++; // a word still loading must not replace the file
  if (autoColor) setColor("original");
  if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) {
    await loadSvg(await file.text(), via);
  } else if (file.type.startsWith("image/")) {
    await loadUrl(URL.createObjectURL(file), via);
  } else {
    say("That file isn't an image. Try an SVG or PNG.");
  }
}

function isAudio(file) {
  return file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name);
}

// Browsers render an SVG without width/height at a tiny size, so set the size from viewBox.
async function loadSvg(text, via) {
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
  await loadUrl(URL.createObjectURL(blob), via);
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

async function loadUrl(url, via) {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    return say("Couldn't open that image.");
  }
  try {
    const source = unplate(img);
    buildLogo(source, trim(source));
  } catch {
    // For example, an SVG with <foreignObject> (background blur from Figma): the browser won't let us read the pixels.
    return say("Couldn't open that image.");
  } finally {
    URL.revokeObjectURL(url);
  }
  say("");
  if (via) {
    tell("upload");
    tell(`from:${via}`);
    tell(`logo:${stroke}`);
  }
  fitColorToBackground();
  applyColor();
  renderThumbs();
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
  renderThumbs();
  draw();
  kick();
}

// A logo exported on white, a JPG or a PNG without transparency, comes back with the white keyed out,
// so the glass sees the mark and not a white card. Only a plain white border counts: a border in another colour is
// an icon's own plate, and a photo has no plain border at all. Those come back as they are (see buildLogo).
function unplate(img) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const k = Math.min(1, 1024 / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return img; // has transparency: a logo as it is
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  // The background is the border's median colour: letters touching the border don't shift it.
  const bg = [0, 1, 2].map((ch) => {
    const v = border.map((p) => px[p * 4 + ch]).sort((a, b) => a - b);
    return v[v.length >> 1] / 255;
  });
  const dist = (p) => Math.hypot(px[p * 4] / 255 - bg[0], px[p * 4 + 1] / 255 - bg[1], px[p * 4 + 2] / 255 - bg[2]);
  // A logo cropped tight touches the border with a letter or two, so most of the border, not all of it, has to be plain.
  if (border.filter((p) => dist(p) < 0.08).length < border.length * 0.8) return img; // a busy border: a photo
  if (Math.min(...bg) < 0.86) return img; // plain, but not white: an icon's own plate
  const n = w * h;
  const d = new Float32Array(n); // how far each pixel is from the background colour
  for (let p = 0; p < n; p++) d[p] = dist(p);
  // Unmixing, only where the logo meets the background: an edge pixel is the logo's colour next to it, blended with
  // white. If a neighbour within 2 px is further from white and this pixel lies on the line from white to it, it takes
  // that colour, with the opacity of how far along the line it is. Inside the logo, away from the background, every
  // pixel keeps its own colour, so shades that touch, grey next to black, keep their seam.
  const BG_NOISE = 0.035; // up to ±5 levels a channel off white still counts as background: JPEG noise
  const out = new Uint8ClampedArray(px.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const o = p * 4;
      if (d[p] <= BG_NOISE) continue; // background: transparent
      let far = p;
      let edge = false;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++) {
        for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
          const q = yy * w + xx;
          if (d[q] <= BG_NOISE) edge = true;
          if (d[q] > d[far]) far = q;
        }
      }
      if (edge && d[far] > d[p] * 1.08) {
        const q = far * 4;
        let dot = 0;
        let len = 0;
        for (let ch = 0; ch < 3; ch++) {
          const fc = px[q + ch] / 255 - bg[ch];
          dot += (px[o + ch] / 255 - bg[ch]) * fc;
          len += fc * fc;
        }
        const t = Math.min(1, Math.max(0, dot / len));
        let miss = 0;
        for (let ch = 0; ch < 3; ch++) miss += (px[o + ch] / 255 - bg[ch] - t * (px[q + ch] / 255 - bg[ch])) ** 2;
        if (miss < 0.0064) {
          out.set(px.subarray(q, q + 3), o);
          out[o + 3] = t * 255;
          continue;
        }
      }
      if (d[p] >= 0.3 || !edge) {
        out.set(px.subarray(o, o + 3), o);
        out[o + 3] = 255;
      } else {
        // Faint, at the background, with nothing darker beside it: a hairline. Its own colour with the white taken back out.
        const t = (d[p] - BG_NOISE) / (0.3 - BG_NOISE);
        for (let ch = 0; ch < 3; ch++) out[o + ch] = (bg[ch] + (px[o + ch] / 255 - bg[ch]) / t) * 255;
        out[o + 3] = t * 255;
      }
    }
  }
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
  return c;
}

// Trim empty margins around the logo: the effect only shows when the artwork reaches the rim.
// Also says how much of the trimmed box is solid: nearly all of it means a photo or an icon on its own plate.
function trim(img) {
  // An <img> has natural size; a canvas with typed text only has its own.
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const k = Math.min(1, 1024 / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  const data = pixels(w, h, (ctx) => ctx.drawImage(img, 0, 0, w, h));
  let x0 = w, y0 = h, x1 = -1, y1 = -1, solid = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a > 128) solid++;
      if (a > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: iw, h: ih, solid: 0 };
  return { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k, solid: solid / ((x1 - x0 + 1) * (y1 - y0 + 1)) };
}

// Two textures: a distance field for the shape, and color extended past the edge so the blurred rim doesn't darken.
// A solid picture fills the glass: its middle square is taken, and the size never goes under edge to edge (see target).
function buildLogo(img, crop) {
  // Solid and close to square: a photo or an icon on its own plate. A wide or tall one keeps its shape and sits in the glass.
  const aspect = crop.w / crop.h;
  fill = crop.solid > 0.935 && aspect >= 0.74 && aspect <= 1.34;
  if (fill) {
    const side = Math.min(crop.w, crop.h);
    crop = { x: crop.x + (crop.w - side) / 2, y: crop.y + (crop.h - side) / 2, w: side, h: side };
  }
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
  // A typical half-width of the strokes, in texels: across a stroke the distance inside runs evenly from 0 to the half-width,
  // so twice the average distance inside is that half-width. The deepest point would overrate thin logos: joins are wider.
  let inside = 0, sum = 0;
  for (let i = 0; i < sdf.length; i++) if (sdf[i] > 128) (inside++, (sum += sdf[i] - 128));
  const half = inside ? ((2 * sum) / inside / 127) * SDF_SPREAD : 0;
  stroke = fill ? "fill" : half < 6 ? "thin" : half < 16 ? "mid" : "bold";

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
    size: fill ? Math.max(st.size, 1.02) : st.size,
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
    frame: ICON_SCALE, // share of the frame the icon takes; trying Avatar or App Store on hover eases it to 1
    shadow: 1,
    facet: st.facets ? 1 : 0,
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
const EASED = ["n", "refraction", "dispersion", "edge", "motion", "size", "tintMix", "sideMix", "sideTwo", "angle", "spread", "liquid", "volume", "depth", "facet", "frame", "shadow"];
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

// Sound on top of the settings, kept to the restraint of the still glass. A beat has one accent: the lens pulls
// the logo into the rim and eases back. Bass thickens the slab a touch; the shader tints the rim fringe by band
// and breathes the waves. Silent: the same object, nothing changes.
function live(p) {
  const { level, bass, hit, bands } = sound;
  if (!level && !bass && !hit && !bands.some(Boolean)) return p;
  return {
    ...p,
    volume: p.volume + 0.1 * bass,
    refraction: p.refraction + 0.6 * hit,
    sound: [level, bass, hit, 0],
    bands,
  };
}

// The four newest tap ripples, as the shader takes them.
function packDrops(list) {
  const packed = new Float32Array(16);
  list.slice(0, 4).forEach((d, i) => packed.set([d.x, d.y, d.age, d.amp], i * 4));
  return packed;
}

// --- Lean and touch ---

// The glass leans toward the cursor over the stage, or with the phone; a tap drops a ripple where it lands and rings the glass.
// Preview only: PNG and video come out upright and untouched. Reduced motion turns lean and ripples off.
const tiltGoal = [0, 0];
const tilt = [0, 0];
let touches = []; // tap ripples, newest first: { x, y, age: s, amp }
const LEAN = 320; // ms, how fast the glass follows: slow enough to feel heavy, like a slab of glass

function lean(dt) {
  const a = 1 - Math.exp(-dt / LEAN);
  let moving = false;
  for (let i = 0; i < 2; i++) {
    const d = tiltGoal[i] - tilt[i];
    if (Math.abs(d) > 1e-3) {
      tilt[i] += d * a;
      moving = true;
    } else tilt[i] = tiltGoal[i];
  }
  for (const t of touches) t.age += dt / 1000;
  touches = touches.filter((t) => t.age < 1);
  return moving || touches.length > 0;
}

function feel(p) {
  if (!tilt[0] && !tilt[1] && !touches.length) return p;
  const out = { ...p, tilt: [tilt[0], tilt[1]] };
  if (touches.length) out.drops = packDrops(touches);
  return out;
}

// One sound step. With sound on, the loop clock runs a little faster when it's loud, so the waves move with the music.
// The phase is handed over both ways, so turning sound on or off doesn't make the glass jump.
function listen(now, dt) {
  const on = sound.mode !== "off";
  if (on !== soundOn) {
    if (on) clock = phaseAt(now);
    else t0 = now - clock * PERIOD;
    soundOn = on;
  }
  const alive = sound.update(dt);
  showBars();
  if (soundOn) clock = (clock + (dt / PERIOD) * (1 + 0.4 * sound.level)) % 1;
  return alive;
}

// A frame without easing, for resize and after export.
function draw() {
  if (recording) return;
  if (!shown) shown = target(params);
  renderer.setSize(previewSize());
  const phase = phaseAt(performance.now());
  renderer.render(withTurn(feel(live(shown)), phase), phase);
}

function loop(now) {
  frame = 0;
  if (recording) return;
  const dt = Math.min(now - last, 100);
  const moving = ease(goal(), dt);
  const hearing = listen(now, dt);
  const leaning = lean(dt);
  last = now;
  draw();
  if (moving || animated() || hearing || leaning) frame = requestAnimationFrame(loop);
}

// What the stage eases toward: the settings, or what the mouse is trying on (see "Try on hover").
function goal() {
  if (trying?.preset) return presetLook(trying.preset);
  const look = target(params);
  if (trying?.format === "avatar") return { ...look, n: 2, frame: 1, shadow: 0 };
  if (trying?.format === "store") return { ...look, frame: 1, shadow: 0 };
  return look;
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

// Facets: cut glass instead of a rounded rim.
const facetsInput = root.querySelector("input[name=facets]");
params.facets = facetsInput.checked;
facetsInput.addEventListener("change", () => {
  params.facets = facetsInput.checked;
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
    if (input.name === "color") {
      autoColor = false;
      renderThumbs();
    }
    applyColor();
    kick();
  });
}
applyColor();

// A dark logo disappears on a dark background: turn it white, and back when the background is light again.
// Decided by the logo's own luminance, not just for the demo smiley.
// A white logo disappears on light glass the same way, so it turns black there. A photo keeps its own colors.
function fitColorToBackground() {
  const color = colorOn(params.background === "dark");
  if (color !== logoColor) setColor(color, true);
}

// The logo colour a background calls for, from the current one. Trying a preset on uses it too, so it shows what a click gives.
function colorOn(dark) {
  if (fill) return logoColor;
  const pale = logoLuma > 0.85;
  if (dark && (logoColor === "black" || (logoColor === "original" && logoLuma < 0.3))) return "white";
  if (!dark && logoColor === "white") return autoColor && !pale ? "original" : "black";
  if (!dark && logoColor === "original" && pale) return "black";
  return logoColor;
}

function setColor(c, auto = false) {
  logoColor = c;
  autoColor = auto;
  root.querySelector(`input[name=color][value=${c}]`).checked = true;
  applyColor();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file, "file");
  fileInput.value = "";
});

// Typing redraws after a short pause; the sample marks fill the field and load at once.
let textTimer = 0;
textInput.addEventListener("input", () => {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => loadText(textInput.value.trim()), 180);
  tried("text");
  tell("text");
});
for (const sample of root.querySelectorAll("[data-sample]")) {
  sample.addEventListener("click", () => {
    clearTimeout(textTimer);
    textInput.value = sample.dataset.sample;
    loadText(sample.dataset.sample);
    tried("text");
    tell("text");
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
  if (file) loadFile(file, "drop");
});

// --- Sound ---

// Off, Demo, Mic or Track. Demo is a glass tune made in the browser, no permission or file needed.
// Track plays a file, picked with Track itself or dropped on the page.
const soundRadio = (mode) => root.querySelector(`input[name=sound][value=${mode}]`);
const trackRadio = soundRadio("track");
function showSound(mode) {
  soundRadio(mode).checked = true;
  showCaption();
}

// While sound plays, its eight bands run at the right end of the Sound heading: the same bands that colour the fringe.
const bars = document.createElement("span");
bars.className = "bars";
bars.setAttribute("aria-hidden", "true");
bars.innerHTML = "<i></i>".repeat(8);
bars.hidden = true;
root.querySelector("[data-sound-head]").append(bars);
function showBars() {
  const on = sound.mode !== "off" && !reducedMotion;
  bars.hidden = !on;
  if (on) sound.bands.forEach((b, i) => (bars.children[i].style.transform = `scaleY(${(0.15 + 0.85 * b).toFixed(3)})`));
}

// The line under the buttons says what you'll get: which PNG, and a video that's the loop,
// one round of the tune, or a stretch of your own sound.
function showCaption() {
  const mode = root.querySelector("input[name=sound]:checked")?.value ?? "off";
  const video = mode === "off" ? "MP4 1080p, 4 s" : mode === "demo" ? "MP4 1080p, 9.6 s with sound" : "MP4 1080p, 12 s with sound";
  const own = mode === "mic" || mode === "track" ? "Your logo and sound never leave your browser." : "Your logo never leaves your browser.";
  caption.textContent = `${imageFormat().note} · ${video} · ${own}`;
}
for (const input of root.querySelectorAll("input[name=image]")) {
  input.addEventListener("change", () => {
    showCaption();
    tried("image");
  });
}

async function setSound(mode, file) {
  showSound(mode);
  if (mode !== "off") tried("sound");
  try {
    if (mode === "demo") await sound.demo();
    else if (mode === "mic") await sound.mic();
    else if (mode === "track") await sound.track(file);
    else sound.off();
    if (sound.wanted === mode) say(mode === "track" ? `♪ ${sound.name}` : "");
    if (sound.wanted === mode && mode !== "off") tell(`sound:${mode}`); // the mode only, never the track's name
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
    if (e?.message === "insecure") return isSecureContext ? "This browser can't use the mic. Try Chrome or Safari." : "The mic only works over HTTPS.";
    if (name === "NotAllowedError" || name === "SecurityError") return "Mic access is blocked. Allow it for this page and try again.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No mic found.";
    if (name === "NotReadableError") return "The mic is busy in another app.";
    return "Couldn't start the mic.";
  }
  if (mode === "demo") return "Couldn't play the demo in this browser.";
  if (name === "NotAllowedError") return `${touch ? "Tap" : "Click"} Track to play it.`; // mostly after a drop, which is a mouse gesture
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

// --- Lean and touch: input ---

const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const stageWrap = root.querySelector(".stage-wrap");
const tiltButton = root.querySelector("[data-tilt]");

// With a mouse, the glass leans toward the cursor while it's over the stage, and settles back when it leaves.
// That also makes the first second alive: the demo ☺ answers the cursor before anything is clicked.
if (!reducedMotion) {
  stageWrap.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    // Over the presets the glass stands straight, so a look being tried on is seen as it is.
    if (e.target.closest(".looks")) {
      tiltGoal[0] = tiltGoal[1] = 0;
      return void kick();
    }
    const r = canvas.getBoundingClientRect();
    tiltGoal[0] = clamp1(((e.clientX - r.left) / r.width - 0.5) * 2);
    tiltGoal[1] = clamp1(-((e.clientY - r.top) / r.height - 0.5) * 2);
    kick();
  });
  stageWrap.addEventListener("pointerleave", () => {
    tiltGoal[0] = tiltGoal[1] = 0;
    kick();
  });
}

// On a phone, the glass leans with the phone. Rest is how it's held: it drifts to the current grip in a couple of seconds.
let rest = null;
function onOrient(e) {
  if (e.beta == null || e.gamma == null) return;
  rest ??= { beta: e.beta, gamma: e.gamma };
  rest.beta += (e.beta - rest.beta) * 0.01;
  rest.gamma += (e.gamma - rest.gamma) * 0.01;
  tiltGoal[0] = clamp1((e.gamma - rest.gamma) / 20);
  tiltGoal[1] = clamp1(-(e.beta - rest.beta) / 20);
  kick();
}

// iPhone asks for motion access, and only after a tap: one button on the stage. Elsewhere tilt just works.
if (!reducedMotion && matchMedia("(pointer: coarse)").matches && typeof DeviceOrientationEvent !== "undefined") {
  if (typeof DeviceOrientationEvent.requestPermission === "function") tiltButton.hidden = false;
  else addEventListener("deviceorientation", onOrient);
}
tiltButton.addEventListener("click", async () => {
  try {
    if ((await DeviceOrientationEvent.requestPermission()) !== "granted") throw new Error("denied");
    addEventListener("deviceorientation", onOrient);
    tiltButton.hidden = true;
    tried("tilt");
    tell("tilt");
  } catch {
    say("Motion access is off, so the glass won't tilt.");
  }
});

// A tap on the glass: a ripple from that spot on the press, and a quiet glass note on the release.
// The note waits for the release because iPhone only lets audio start there, and a touch that turns into
// a scroll never releases on the canvas, so scrolling past the icon stays silent. Not while sound is on.
let pressed = false;
canvas.addEventListener("pointerdown", (e) => {
  pressed = false;
  if (recording) return;
  const r = canvas.getBoundingClientRect();
  const x = (((e.clientX - r.left) / r.width - 0.5) * 2) / ICON_SCALE;
  const y = (-((e.clientY - r.top) / r.height - 0.5) * 2) / ICON_SCALE;
  if (Math.hypot(x, y) > 1.3) return; // the shadow and the margin, not the glass
  pressed = true;
  tell("tap");
  if (reducedMotion) return;
  touches = [{ x, y, age: 0, amp: 1.6 }, ...touches].slice(0, 4);
  kick();
});
canvas.addEventListener("pointerup", () => {
  if (pressed) sound.chime();
  pressed = false;
});
canvas.addEventListener("pointercancel", () => (pressed = false));

// --- Presets ---

// Ready-made looks in one click. Studio is the default, in the markup too, so the first screen wows right away.
// Each preset sets shape, sides, background, volume and spin in full; otherwise the look would depend on the previous one.
const PRESETS = {
  // The logo flows into two opposite corners.
  studio: {
    ranges: { size: 0.66, refraction: 1.5, dispersion: 0.95, edge: 0.18, liquid: 0.75, angle: 45, spread: 0.6, thickness: 0.35, motion: 0.5 },
    radios: { sides: "two", background: "light", shape: "squircle" },
    checks: { volume: true, spin: false, facets: false },
  },
  // Flows into all corners, calmly.
  melt: {
    ranges: { size: 0.6, refraction: 1.1, dispersion: 0.85, edge: 0.22, liquid: 0.85, thickness: 0.45, motion: 0.5 },
    radios: { sides: "all", background: "light", shape: "squircle" },
    checks: { volume: true, spin: false, facets: false },
  },
  // Cut glass: the logo untouched, two clean facets with a thin rainbow along the whole rim.
  prism: {
    ranges: { size: 0.62, refraction: 1.1, dispersion: 1, edge: 0.17, liquid: 0, thickness: 0.6, motion: 0.5 },
    radios: { sides: "all", background: "light", shape: "squircle" },
    checks: { volume: true, spin: false, facets: true },
  },
  // A cut round lens: rings, like a cut stone.
  lens: {
    ranges: { size: 0.6, refraction: 0.85, dispersion: 1, edge: 0.28, liquid: 0.15, thickness: 0.5, motion: 0.4 },
    radios: { sides: "all", background: "light", shape: "circle" },
    checks: { volume: true, spin: false, facets: true },
  },
  // Studio on black: the light of the logo flows into two opposite corners. A dark logo turns white on its own.
  night: {
    ranges: { size: 0.64, refraction: 1.45, dispersion: 1, edge: 0.18, liquid: 0.75, angle: 45, spread: 0.6, thickness: 0.45, motion: 0.5 },
    radios: { sides: "two", background: "dark", shape: "squircle" },
    checks: { volume: true, spin: false, facets: false },
  },
};
// A preset as shader numbers, without touching the inputs: for the thumbnails on the preset keys and for trying a preset on hover.
// The logo color follows the same rule as the page: a dark logo turns white on a dark background, a white one black on light.
function presetLook(name, still = false) {
  const preset = PRESETS[name];
  const background = preset.radios.background;
  const dark = background === "dark";
  const color = colorOn(dark);
  const tint = color === "white" ? [1, 1, 1] : color === "black" ? hexToRgb(tokens.getPropertyValue("--color-black")) : null;
  const { angle = angleDeg, thickness: slab = thickness, motion = params.motion, ...ranges } = preset.ranges;
  const keepTint = lastTint;
  const look = target({
    ...params,
    ...ranges,
    motion: still ? 0 : motion,
    shape: preset.radios.shape,
    sides: preset.radios.sides,
    background,
    bg: dark ? BG.dark : BG.light,
    tint,
    volume: slab,
    depth: preset.checks.volume ? 1 : 0,
    facets: preset.checks.facets,
  });
  lastTint = keepTint; // target() remembers the last tint for easing; a thumbnail mustn't change it
  return { ...look, angle: (angle / 180) * Math.PI };
}

// Thumbnails: each preset drawn by the main renderer at 192 px, filling the frame, then copied into its key.
// Light presets render with no background, so the key's tray shows around the glass.
const thumbs = root.querySelectorAll("[data-thumb]");
function renderThumbs() {
  if (recording) return;
  for (const thumb of thumbs) {
    const look = presetLook(thumb.dataset.thumb, true);
    renderer.setSize(192);
    renderer.render({ ...look, ...(look.background === "light" ? { background: "none" } : {}), frame: 1, shadow: 0 }, 0);
    const ctx = thumb.getContext("2d");
    ctx.clearRect(0, 0, thumb.width, thumb.height);
    ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  }
  draw();
}

const PRESET_KEYS = new Set(Object.values(PRESETS).flatMap((p) => [...Object.keys(p.ranges), ...Object.keys(p.radios), ...Object.keys(p.checks)]));
let applyingPreset = false;

// A preset writes values into the inputs themselves, so the glass eases to it the same way as with the sliders.
function applyPreset(name) {
  if (PRESETS[name]) applyLook(PRESETS[name]);
}

function applyLook(preset) {
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
    tell(`preset:${input.value}`);
  });
}

// Randomize: a look of its own, mixed within the ranges the presets live in, so it never comes out broken or loud.
// It eases in like a preset; no preset stays selected, since the look is custom.
const pick = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;

function randomLook() {
  const sides = chance(0.5) ? "all" : chance(0.7) ? "two" : "one";
  const pooled = chance(0.35); // a third of looks keep the logo whole, with only a rim; cut glass suits those best
  return {
    ranges: {
      size: pick(0.58, 0.68),
      refraction: pick(1, 1.5),
      dispersion: pick(0.85, 1),
      edge: pick(0.14, 0.24),
      liquid: pooled ? pick(0, 0.15) : pick(0.75, 0.88),
      angle: pick(0, 360),
      spread: pick(0.4, 0.75),
      thickness: pick(0.3, 0.6),
      motion: pick(0.4, 0.6),
    },
    radios: { sides, background: chance(0.25) ? "dark" : "light", shape: chance(0.15) ? "circle" : "squircle" },
    checks: { volume: true, spin: false, facets: pooled && chance(0.6) },
  };
}

let rolls = 0;
function randomize() {
  applyLook(randomLook());
  tried("random");
  tell("random");
  for (const input of root.querySelectorAll("input[name=preset]")) input.checked = false;
  rolls++;
  for (const button of root.querySelectorAll("[data-random]")) button.style.setProperty("--turn", `${rolls * 120}deg`);
}

for (const button of root.querySelectorAll("[data-random]")) button.addEventListener("click", randomize);

// --- Try on hover ---

// With a mouse, hovering a preset key shows that look on the stage, and hovering Avatar or App Store shows that framing:
// the glass eases there and back when the mouse leaves. Nothing is selected until a click. Touch screens skip it.
let trying = null; // { preset } or { format }
if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
  for (const input of root.querySelectorAll("input[name=preset], input[name=image]")) {
    const key = input.parentElement;
    key.addEventListener("pointerenter", () => {
      if (input.checked || recording) return;
      trying = input.name === "preset" ? { preset: input.value } : { format: input.value };
      kick();
    });
    key.addEventListener("pointerleave", () => {
      trying = null;
      kick();
    });
    input.addEventListener("change", () => (trying = null));
  }
}

// --- Link to a look ---

// The settings travel in the link's hash, under short keys with three decimals. The logo never does:
// "Your logo never leaves your browser" stays true for links too.
const LOOK = {
  ranges: { r: "refraction", b: "liquid", s: "size", d: "dispersion", e: "edge", a: "angle", l: "spread", m: "motion", t: "thickness" },
  radios: { bg: "background", sd: "sides", sh: "shape", c: "color" },
  checks: { v: "volume", sp: "spin", f: "facets" },
};

function lookHash() {
  const q = new URLSearchParams();
  for (const [k, name] of Object.entries(LOOK.ranges)) q.set(k, String(+Number(root.querySelector(`input[name=${name}]`).value).toFixed(3)));
  for (const [k, name] of Object.entries(LOOK.radios)) q.set(k, root.querySelector(`input[name=${name}]:checked`)?.value ?? "");
  for (const [k, name] of Object.entries(LOOK.checks)) q.set(k, root.querySelector(`input[name=${name}]`).checked ? "1" : "0");
  return q.toString();
}

// Only known keys and values are taken, so a mangled link falls back to the defaults instead of breaking the page.
function readLook(hash) {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const look = { ranges: {}, radios: {}, checks: {} };
  let found = false;
  for (const [k, name] of Object.entries(LOOK.ranges)) {
    const v = Number(q.get(k));
    if (q.has(k) && Number.isFinite(v)) (look.ranges[name] = v), (found = true);
  }
  for (const [k, name] of Object.entries(LOOK.radios)) {
    const v = q.get(k);
    if (v && [...root.querySelectorAll(`input[name=${name}]`)].some((el) => el.value === v)) (look.radios[name] = v), (found = true);
  }
  for (const [k, name] of Object.entries(LOOK.checks)) if (q.has(k)) (look.checks[name] = q.get(k) === "1"), (found = true);
  return found ? look : null;
}

function openLook() {
  const look = readLook(location.hash);
  if (!look) return;
  applyLook(look);
  for (const input of root.querySelectorAll("input[name=preset]")) input.checked = false;
}

async function copyLink() {
  tried("link");
  tell("link:copy");
  const url = `${location.origin}${location.pathname}#${lookHash()}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    say("Link copied. Your logo isn't in it.");
  } catch {
    say("Couldn't copy. The link is in the address bar.");
  }
}

for (const button of root.querySelectorAll("[data-copy-link]")) button.addEventListener("click", copyLink);
addEventListener("hashchange", openLook);

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
    return void loadFile(file, "paste");
  }
  const text = data.getData("text/plain").trim();
  if (recording) return;
  if (text.startsWith("<svg") || text.startsWith("<?xml")) {
    e.preventDefault();
    textInput.value = "";
    textTurn++;
    if (autoColor) setColor("original");
    loadSvg(text, "paste");
  }
});

// --- Export ---

// The frame is rendered up to SUPERSAMPLE times larger and scaled down to the final size.
// For 2048 that would be a 4096 canvas, past what phones allow, so the supersampling shrinks to stay under ~12 MP.
const MAX_RENDER = Math.sqrt(12e6);
function frameInto(out, p, phase, opaque = false) {
  renderer.setSize(Math.round(out.width * Math.min(SUPERSAMPLE, MAX_RENDER / out.width)));
  renderer.render(p, phase);
  const ctx = out.getContext("2d", { alpha: !opaque });
  ctx.clearRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
}

// What Download PNG makes. Avatar: the glass as a circle filling the frame, for round profile pictures.
// App Store: the shape fills the square with no shadow and no transparency; the store rounds the corners itself.
const IMAGES = {
  icon: { px: EXPORT_PX, name: "glass-icon.png", note: "PNG 1024 px" },
  large: { px: 2048, name: "glass-icon-2048.png", note: "PNG 2048 px", told: "image:2048" },
  avatar: { px: 1024, name: "glass-avatar.png", note: "Avatar PNG 1024 px", fill: true, shape: "circle", told: "image:avatar" },
  store: { px: 1024, name: "glass-app-store.png", note: "App Store PNG 1024 px", fill: true, opaque: true, told: "image:store" },
};
const imageFormat = () => IMAGES[root.querySelector("input[name=image]:checked")?.value] ?? IMAGES.icon;

pngButton.addEventListener("click", () => {
  const format = imageFormat();
  const out = document.createElement("canvas");
  out.width = out.height = format.px;
  const phase = phaseAt(performance.now());
  const look = target({
    ...params,
    ...(format.shape ? { shape: format.shape } : {}),
    ...(format.opaque && params.background === "none" ? { background: "light", bg: BG.light } : {}),
  });
  const framed = format.fill ? { ...live(look), frame: 1, shadow: 0 } : live(look);
  frameInto(out, withTurn(framed, phase), phase, format.opaque);
  // rgb: the PNG is known to have no alpha already, so there is nothing to wait for before saving.
  const done = async (blob, rgb = false) => {
    if (blob && format.opaque && !rgb) blob = await withoutAlpha(blob, out);
    if (blob) {
      save(blob, format.name);
      tell("png");
      if (format.told) tell(format.told);
    }
    draw();
  };
  // iOS only reliably opens the Share sheet in the same tick as the tap, and toBlob responds later,
  // so there the PNG is built synchronously. Byte 25 of a PNG is its colour type: 2 is RGB, no alpha.
  if (ios) {
    const bytes = dataUrlBytes(out.toDataURL("image/png"));
    done(new Blob([bytes], { type: "image/png" }), bytes[25] === 2);
  } else out.toBlob(done, "image/png");
});

// App Store Connect refuses an icon with an alpha channel. Browsers write RGB from an opaque canvas, mostly;
// where one still writes RGBA (PNG color type 6), the pixels are re-encoded as RGB here.
async function withoutAlpha(blob, out) {
  const head = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
  if (head[25] !== 6 || typeof CompressionStream === "undefined") return blob;
  const { width: w, height: h } = out;
  const px = out.getContext("2d").getImageData(0, 0, w, h).data;
  const rows = new Uint8Array(h * (w * 3 + 1)); // each row starts with filter type 0
  for (let y = 0, o = 0; y < h; y++) {
    rows[o++] = 0;
    for (let x = 0; x < w; x++, o += 3) rows.set(px.subarray((y * w + x) * 4, (y * w + x) * 4 + 3), o);
  }
  const zipped = new Uint8Array(await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", zipped), pngChunk("IEND", new Uint8Array(0))], { type: "image/png" });
}

let crcTable = null;
function pngChunk(type, data) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = crcTable[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

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
    // A track whose autoplay was refused would record silence; this tap counts as the one it waited for.
    if (sound.mode === "track" && sound.audio.paused) await sound.audio.play().catch(() => {});
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
      tell(wide ? "video-wide" : "video");
      // X takes MP4 and MOV video; browsers that can't record MP4 (Firefox) write WebM.
      if (!mp4) message = "Saved as WebM. For X, record in Chrome or Safari.";
    } else {
      message = "This browser can't record video. Try Chrome or Safari.";
    }
  } catch {
    message = audio
      ? "This browser can't record video with sound. Turn Sound off to record without it."
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
  afterBox.hidden = false;
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
  // On iPhone this button means save, not share, so it isn't told as share.
  if (!ios) tell("share");
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

// A data URL's bytes, synchronously: the iOS stand-in for toBlob (see "Download PNG").
function dataUrlBytes(url) {
  const bytes = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return out;
}

function say(text) {
  status.textContent = text;
}

function hexToRgb(hex) {
  const h = hex.trim().replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}


// --- New ---

// What this release added, said once: a line under the title on the first visit, naming what's new.
// It shortens as you try things and goes when nothing is left. Temporary, so it has a date: two weeks after launch.
const NEW_UNTIL = Date.parse("2026-11-15"); // set to the launch day plus 14 days when the launch date is known
const NEW_NAMES = { sound: "sound", text: "text logos", random: "random looks", image: "PNG formats", tilt: "tilt" };
const whatsNew = document.querySelector("[data-whatsnew]");
const seen = [];

// The first visit is the one without the mark; the mark is set right away, so a reload no longer shows the line.
let firstVisit = true;
try {
  firstVisit = !localStorage.getItem("glass-new-seen");
  localStorage.setItem("glass-new-seen", "1");
} catch {
  // Storage unavailable: every visit counts as the first, and the line shows until the date.
}

function showNew() {
  // In NEW_NAMES order, sound first. Tilt only counts where its button shows (iPhone); elsewhere the glass just follows the cursor.
  const left = Object.keys(NEW_NAMES).filter((k) => !seen.includes(k) && (k !== "tilt" || !tiltButton.hidden)).map((k) => NEW_NAMES[k]);
  whatsNew.textContent = `New: ${left.join(", ")}`;
  whatsNew.hidden = !firstVisit || Date.now() > NEW_UNTIL || !left.length;
}

function tried(feature) {
  if (seen.includes(feature)) return;
  seen.push(feature);
  showNew();
}
showNew();
// A shared link opens on its look; the logo is the demo ☺ until you add your own.
openLook();
loadSvg(DEMO_SVG).then(kick);
