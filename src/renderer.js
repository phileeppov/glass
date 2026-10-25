// WebGL glass: a superellipse with a bevel; the bevel refracts the logo inward,
// spectral samples give a rainbow fringe. No libraries, WebGL 1.
// The logo comes in as a distance field (SDF): the edge is computed, not taken from pixels,
// so it stays smooth under the lens at any magnification.

/** @typedef {"squircle" | "circle"} Shape */
/** @typedef {"light" | "dark" | "none"} Background */
/** @typedef {"all" | "two" | "one"} Sides */

// Everything that can be animated smoothly between values is a number: shape, sides, logo fill.
/**
 * @typedef {object} GlassParams
 * @property {number} n superellipse exponent: 2 is a circle, 5 is a rounded square
 * @property {number} refraction 0..1.5, how far the bevel pulls the image from inside
 * @property {number} dispersion 0..1, color spread
 * @property {number} edge bevel width as a fraction of the icon half-size
 * @property {number} motion 0..1, shape wobble
 * @property {number} size logo half-size as a fraction of the icon half-size
 * @property {[number, number, number]} tint logo fill color
 * @property {number} tintMix 0: the logo's own color, 1: tint fill
 * @property {number} sideMix 0: the rim refracts everywhere, 1: only on the selected sides
 * @property {number} sideTwo 0: one side, 1: two opposite sides
 * @property {number} angle direction in radians, 0 is right, counterclockwise
 * @property {number} spread 0..1, width of the selected-sides zone
 * @property {number} liquid 0..1, the smear flows into the edge, waves move through the glass
 * @property {number} volume slab thickness, 0..1
 * @property {number} depth 0: flat glass, 1: with volume
 * @property {number} facet 0: a rounded rim, 1: cut glass, two flat facets with crisp edges
 * @property {Background} background
 * @property {[number, number, number]} bg background color for light/dark, 0..1
 * @property {number} [reverse] 1: the logo's lightness turned over, its hue kept
 * @property {[number, number, number, number]} [sound] unused, bass, beat, unused; all 0 or absent when sound is off
 * @property {Float32Array} [bands] 8 frequency bands, 0..1, low to high
 * @property {[number, number, number, number]} [light] sound as light: turn (rad), rim glow, fringe width, unused
 * @property {Float32Array} [fields] the handpan's 9 fields: x, y, radius, how hard it rings now
 * @property {[number, number, number, number]} [press] a held finger: x, y, how far the glass gives, radius
 * @property {[number, number]} [tilt] where the glass leans, -1..1 per axis; absent in exports
 * @property {number} [frame] share of the frame the icon takes, ICON_SCALE by default, 1 to fill it
 * @property {number} [shadow] 1: shadow under the icon (default), 0: none
 */

// The icon takes 80% of the frame, leaving 10% per side for the shadow and breathing room.
export const ICON_SCALE = 0.8;
// Share of the texture the logo takes along its long side; the margins leave room for the SDF falloff.
export const LOGO_FILL = 0.86;
// How far from the edge the SDF still resolves distance, in texels.
export const SDF_SPREAD = 32;

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const frag = (derivatives) => `
${derivatives ? "#extension GL_OES_standard_derivatives : enable" : ""}
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_uv;
uniform sampler2D u_sdf;    // R: 0.5 is the logo edge, higher is inside
uniform sampler2D u_color;  // logo color, extended past the edge
uniform float u_texSize;
uniform float u_halfPx;     // icon half-size in pixels
uniform float u_n;          // superellipse exponent: 2 is a circle, 5 is a rounded square
uniform float u_edge;
uniform float u_refract;
uniform float u_disp;
uniform float u_phase;      // 0..1, one animation loop
uniform float u_motion;
uniform float u_size;
uniform vec4 u_tint;        // rgb is the fill, a is how much to fill: 0 own color, 1 fill
uniform float u_reverse;    // 1: the logo's lightness turned over, its hue kept (a dark two-tone logo on dark)
uniform float u_sideMix;    // 0: everywhere, 1: selected sides only
uniform float u_sideTwo;    // 0: one side, 1: two
uniform float u_angle;
uniform float u_spread;     // side zone width: 0 is a narrow spot, 1 is almost the whole side
uniform float u_liquid;     // 0: smear as a band at the rim, 1: the glyph flows into the edge, waves move through the glass
uniform float u_volume;     // slab thickness, 0..1
uniform float u_depth;      // 0: flat glass, 1: with volume; continuous so the volume fades out instead of popping off
uniform float u_facet;      // 0: a rounded rim, 1: cut glass; continuous so a preset eases from one to the other
uniform vec3 u_bg;
uniform float u_mode;       // 0 light, 1 dark, 2 transparent
uniform vec4 u_sound;       // y bass; all 0 when sound is off, and then nothing below changes
uniform float u_bands[8];   // sound by frequency, low to high, 0..1; laid along the fringe from red to violet
uniform vec4 u_press;       // a held finger: xy where, z how far the glass gives (0..1), w the radius it gives over
uniform vec4 u_fields[9];   // the handpan's fields: xy centre, z radius, w how hard it rings now (0 at rest)
uniform vec4 u_light;       // sound as light: x turns the light (rad), y brightens the rim, z widens the fringe; 0 in silence
uniform vec2 u_tilt;        // where the glass leans, toward the cursor or with the phone: -1..1 per axis, 0 when still
uniform float u_zoom;       // 1: the icon takes ${Math.round(ICON_SCALE * 100)}% of the frame; less fills more (avatar and App Store fill all of it)
uniform float u_shadow;     // 1: soft shadow under the icon, 0: none (avatar, App Store)

const int TAPS = 32;
const float TAU = 6.2831853;

// Spectrum from red (0) to violet (1).
vec3 spectrum(float x) {
  float h = x * 0.8;
  return clamp(vec3(abs(h * 6.0 - 3.0) - 1.0, 2.0 - abs(h * 6.0 - 2.0), 2.0 - abs(h * 6.0 - 4.0)), 0.0, 1.0);
}

// Square by multiplication: pow(x, 2.0) is undefined for x < 0 in GLSL and gives black pixels on some GPUs.
float sq(float x) {
  return x * x;
}

// Distance to the superellipse edge (approximate, exact right at the edge) and the outward normal.
float shape(vec2 p, out vec2 nrm) {
  vec2 a = max(abs(p), vec2(1e-4));
  vec2 an = pow(a, vec2(u_n));
  float s = an.x + an.y;
  float f = pow(s, 1.0 / u_n);
  vec2 g = sign(p) * pow(a, vec2(u_n - 1.0)) * pow(s, 1.0 / u_n - 1.0);
  float gl = max(length(g), 1e-4);
  nrm = g / gl;
  return (f - 1.0) / gl;
}

// With no background the glass is the same as on light: only what is outside stays transparent.
// Nearly empty glass has nothing to refract, so the rainbow turned into gray smudges.
// Superellipse norm: 1 at the edge, less inside. Its level sets are scaled-down copies of the shape, and their corners
// are always rounded. A constant-distance inset breaks at a corner once it exceeds the corner radius,
// and the rim lens magnifies that kink, which is what caused the creases in the corners.
float snorm(vec2 p) {
  vec2 a = max(abs(p), vec2(1e-4));
  return pow(pow(a.x, u_n) + pow(a.y, u_n), 1.0 / u_n);
}

vec4 glassBase() {
  // The body is close to the background: the glass is clear, you see the backdrop through it, not a white tile.
  if (u_mode > 0.5 && u_mode < 1.5) return vec4(mix(u_bg, vec3(1.0), 0.04), 1.0);
  return vec4(mix(u_bg, vec3(1.0), 0.05), 1.0);
}

// The logo at point q in icon space. blur is the half-width of the edge transition, in texels.
vec4 content(vec2 q, float blur) {
  vec2 uv = 0.5 + q * (0.5 * ${LOGO_FILL.toFixed(2)}) / u_size;
  uv.y = 1.0 - uv.y;
  float dist = (texture2D(u_sdf, uv).r * 255.0 - 128.0) / 127.0 * ${SDF_SPREAD.toFixed(1)};
  float cov = smoothstep(-blur, blur, dist);
  vec3 col = texture2D(u_color, uv).rgb;
  if (u_reverse > 0.0) col = mix(col, clamp(col + 1.0 - 2.0 * dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0), u_reverse);
  col = mix(col, u_tint.rgb, u_tint.a);
  vec4 logo = vec4(col * cov, cov);
  return logo + glassBase() * (1.0 - logo.a);
}

// --- Volume: a slab of thickness h with a rounded top rim. A ray from the eye enters the rim,
// refracts and lands on the floor; whatever lies there is what you see. That gives the shimmer inside the rim. ---

// Where on the floor a ray lands after entering the glass with normal n3.
vec2 throughSlab(vec3 n3, float ior, float h) {
  // An index below 1 gives total internal reflection: refract() returns zero, leaving a break in the image.
  vec3 t = refract(vec3(0.0, 0.0, -1.0), n3, 1.0 / max(ior, 1.02));
  return t.xy / max(-t.z, 0.25) * h;
}

// Slab floor: the logo and the backdrop, with a contact shadow at the edge. A bright caustic ring used to be here,
// but at the corners the rim focuses rays and stretched it into straight bright streaks, so it was removed.
vec4 floorAt(vec2 q, float blur) {
  vec4 c = content(q, blur);
  float contact = exp(min(snorm(q) - 1.0, 0.0) / 0.04) * 0.12 * u_depth;
  c.rgb *= 1.0 - contact;
  return c;
}

// The room reflected in the rim: floor under the slab, walls, a window at top left and a light strip at bottom right.
vec3 studio(vec3 r) {
  float len = length(r.xy);
  vec2 dir = r.xy / max(len, 1e-4);
  float key = dot(dir, normalize(vec2(-0.55, 0.85)));
  float ang = len > 1e-4 ? atan(dir.y, dir.x) : 0.0; // atan(0, 0) is undefined in GLSL
  float up = smoothstep(-0.25, 0.35, r.z);
  float window = exp(-sq((ang - 2.15) / 0.22)) * up;
  float strip = exp(-sq((ang + 0.9) / 0.14)) * up;
  bool dark = u_mode > 0.5 && u_mode < 1.5;
  vec3 floorC = u_bg * (dark ? 0.6 : 0.78);
  vec3 wall = dark ? vec3(0.08 + 0.2 * max(key, 0.0)) : u_bg + 0.04 * key;
  return mix(floorC, wall, up) + vec3(window * (dark ? 0.9 : 0.35) + strip * (dark ? 0.4 : 0.18));
}

// Slow waves inside the glass: a sum of sines at different angles. Phase T is the animation loop,
// so the video loops without a seam.
vec2 waves(vec2 p, float T) {
  float a = sin(dot(p, vec2(3.1, 1.7)) + T) + sin(dot(p, vec2(-2.3, 2.9)) - T + 1.7);
  float b = sin(dot(p, vec2(1.3, -3.4)) + T + 0.6) + sin(dot(p, vec2(-3.7, -1.1)) - T + 2.4);
  return vec2(a, b) * 0.5;
}

mat2 turn(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

// Noise with a uniform spectrum: sample jitter instead of banding.
float ign(vec2 c) {
  return fract(52.9829189 * fract(dot(c, vec2(0.06711056, 0.00583715))));
}

void main() {
  float T = u_phase * TAU;
  vec2 p = (v_uv - 0.5) * 2.0 / ${ICON_SCALE.toFixed(2)};
  p *= u_zoom;
  // Bass lifts the whole icon by a hair, a breath rather than a pump.
  p *= 1.0 - 0.012 * u_motion * sin(T) - 0.006 * u_sound.y;

  vec2 nrm;
  float d = shape(p, nrm);
  float th = atan(p.y, p.x + 1e-7); // offset so there is no atan(0, 0) at the exact center
  // A struck field reaches into the rim near it, the way a beat does all round; the ding in the middle reaches all round.
  float reachHit = 0.0;
  for (int i = 0; i < 9; i++) {
    vec4 f = u_fields[i];
    if (f.w < 0.002) continue;
    float near = 1.0;
    if (i > 0) {
      float fa = atan(f.y, f.x + 1e-7);
      float da = atan(sin(th - fa), cos(th - fa));
      near = exp(-da * da / 0.3);
    }
    reachHit += f.w * near;
  }
  float wob = u_motion * (0.016 * sin(3.0 * th + T) + 0.01 * sin(2.0 * th - 2.0 * T));
  d -= wob;
  // Inward depth along scaled-down copies of the shape: 0 at the edge, growing toward the center.
  float depth = 1.0 - snorm(p) + wob;

  float px = 1.0 / u_halfPx;
  float texelsPerUnit = u_texSize * 0.5 * ${LOGO_FILL.toFixed(2)} / u_size;

  // Outside: the background and a soft shadow slightly below the icon.
  vec2 sn;
  float sd = max(shape(p + vec2(0.0, 0.05) + u_tilt * 0.02, sn), 0.0); // the shadow slides away from the lean
  float shadow = exp(-sd / 0.12) * (u_mode > 0.5 && u_mode < 1.5 ? 0.45 : 0.035) * (1.0 + 0.4 * u_volume * u_depth) * u_shadow;
  vec4 outside;
  if (u_mode > 1.5) {
    outside = vec4(0.0, 0.0, 0.0, shadow);
  } else {
    // Flat background: it blends with the page, and in 16:9 video with the side margins, without a seam.
    vec3 bg = u_bg;
    outside = vec4(bg * (1.0 - shadow), 1.0);
  }

  // Inside: the bevel refracts; samples shift inward along the normal, each with its own color.
  // The depth the bevel gathers the image from doesn't depend on its width: a narrow rim
  // compresses a wide band from inside, so the glyph near the edge stretches along it, like in thick glass.
  float t = clamp(depth / u_edge, 0.0, 1.0);
  float e = 1.0 - t;

  // Sides: where the rim refracts. The mask uses the position angle, not the normal: on straight
  // sides the normal angle is constant, and the whole side would switch on at once. Spread is the zone half-width.
  float side = 1.0;
  if (u_sideMix > 0.001) {
    float c = cos(th - u_angle);
    float hw = mix(0.25, 1.6, u_spread);
    side = mix(1.0, smoothstep(cos(hw), cos(hw * 0.35), mix(c, abs(c), u_sideTwo)), u_sideMix);
  }
  float wave = 1.0 + 0.25 * u_motion * sin(T + 1.3);
  // Profile: the offset quickly reaches full strength and holds it across the whole band,
  // so the rim shows a solid band of glyph pulled from far away, with the fringe on its inner boundary.
  float rimPull = smoothstep(0.0, 0.65, e);
  // Cut glass: two flat facets instead of the rounded profile. Each shifts the logo by its own constant amount,
  // so the rim shows two clean copies of the edge, and the step between them is a sharp line.
  float facetAA = 1.2 * px / max(u_edge, 1e-3);
  // The first step only rises past the start of the rim, so the flat middle (e = 0) never shifts, at any canvas size.
  float facets = 0.5 * smoothstep(0.02, 0.02 + 2.0 * facetAA, e) + 0.5 * smoothstep(0.5 - facetAA, 0.5 + facetAA, e);
  rimPull = mix(rimPull, facets, u_facet);
  // Liquid: the falloff reaches deep inside and becomes gentle, so the image doesn't fold
  // into a separate arc but stretches continuously to the edge: the glyph flows into the rim as a bridge.
  float flowW = mix(u_edge, 0.62, u_liquid);
  float flow = pow(1.0 - smoothstep(0.0, flowW, depth), 1.4);
  // Waves in the glass: the smear thickness varies along the rim. None in the center, so the glyph stays even there.
  vec2 wv = waves(p, T);
  float nearEdge = 1.0 - smoothstep(0.0, 0.6, depth);
  float swell = 1.0 + 0.45 * u_liquid * wv.x * nearEdge;
  // A corner is farther from the center than a side's midpoint, so the ray reaches farther, or the corner runs short of glyph.
  float cornerReach = length(p) / max(snorm(p), 1e-3);
  // The band at the rim stays (long tails along the sides); the bridge to the glyph is added on top.
  float k = u_refract * 0.42 * wave * swell * cornerReach * max(rimPull, flow * u_liquid) * side;
  // A struck field pulls the rim near it whatever the sides are, so the glass answers wherever it's played.
  k += u_refract * 0.42 * cornerReach * rimPull * 0.8 * reachHit;
  // Color spread is capped: otherwise, at large offsets the fringe smears into wide blotches.
  float kDisp = min(k, 0.16 + 0.08 * u_light.z + 0.05 * reachHit);
  // Sample direction: along the normal; with Liquid it converges toward the center, and the tails pool into the corner.
  vec2 dir = normalize(mix(nrm, p / max(length(p), 1e-3), 0.45 * u_liquid));
  vec2 ripple = wv * 0.05 * u_liquid * nearEdge * side;
  // The light follows the lean; the logo under the glass shifts the other way, more under a thicker slab: parallax.
  vec2 L = normalize(vec2(-0.55, 0.85) + u_tilt * 0.5);
  // Pitch turns the light around the glass; the guard keeps the silent glass exactly as it was.
  if (u_light.x != 0.0) L = turn(u_light.x) * L;
  vec2 par = -u_tilt * (0.015 + 0.06 * u_volume * u_depth);
  // Touch: a struck field focuses, drawing what's beneath toward its middle, and a held finger is a soft lens.
  vec2 wake = vec2(0.0);
  for (int i = 0; i < 9; i++) {
    vec4 f = u_fields[i];
    if (f.w < 0.002) continue;
    vec2 v = p - f.xy;
    float r = length(v) / f.z;
    wake -= v * exp(-r * r * 2.2) * 0.24 * f.w;
  }
  if (u_press.z > 0.001) {
    vec2 v = p - u_press.xy;
    float r = length(v) / u_press.w;
    float lens = 1.0 - smoothstep(0.0, 1.0, r);
    wake -= v * lens * lens * 0.3 * u_press.z;
  }

  // Volume: a slab with a rounded rim. Thickness sets its visible width and depth,
  // while Edge width still controls the bevel smear. The ray computes the offset; the index comes from Refraction.
  bool vol = u_depth > 0.001;
  float rimW = 0.05 + 0.2 * u_volume;
  float tr = clamp(depth / rimW, 0.0, 1.0);
  float r = 1.0 - tr;
  // Cut glass turns the slab's rounded rim into the same two facets.
  float rAA = 1.2 * px / rimW;
  r = mix(r, 0.5 * smoothstep(0.02, 0.02 + 2.0 * rAA, r) + 0.35 * smoothstep(0.5 - rAA, 0.5 + rAA, r), u_facet);
  float slope = r / max(sqrt(1.0 - r * r), 0.08);
  vec3 n3 = normalize(vec3(nrm * slope, 1.0));
  float h = 0.1 + 0.4 * u_volume;
  float ior = 1.0 + 0.5 * u_refract;
  // A physically accurate slab bends the ray only slightly, and the look we want smears more than physics does. So with volume the ray
  // through the rim is added to the existing bevel smear: lens plus rainbow.
  vec2 offC = (vol ? throughSlab(n3, ior, h) * side * wave * u_depth : vec2(0.0)) - dir * k + ripple + wake;

  // Edge transition width: the pixel size in texels where the sample lands,
  // plus blur that grows with refraction strength, since glass has a soft rim.
  vec2 q0 = p + offC;
#ifdef GL_OES_standard_derivatives
  float foot = length(fwidth(q0)) * texelsPerUnit * 0.4;
#else
  float foot = px * texelsPerUnit * 1.5;
#endif
  float reach = length(offC);
  float blur = max(foot, 0.35) + reach * 0.022 * texelsPerUnit;

  // Color order in the fringe. A black glyph on light and a light glyph on dark give complementary
  // colors; on dark the fringe came out yellow-orange. We flip the order so it is the same on every background.
  // In the band at the rim the image is folded, on the Liquid bridge it isn't, so their color orders are opposite.
  // Flip per zone with a smooth transition: cyan inside and red outside at the rim, a cyan halo around the bridge.
  float zone = mix(-1.0, 1.0, smoothstep(u_edge * 0.6, u_edge * 1.3, depth) * step(0.001, u_liquid));
  float order = (u_mode > 0.5 && u_mode < 1.5 ? -1.0 : 1.0) * zone;

  vec4 inside;
  if (reach < 1e-4) {
    // With volume, draw the floor the same way as in the loop; otherwise, where the side mask kills the smear,
    // the contact shadow would disappear and a straight step in tone would show up on the glass.
    inside = vol ? floorAt(p + par, blur) : content(p + par, blur);
  } else {
    vec3 acc = vec3(0.0);
    vec3 wsum = vec3(0.0);
    float aacc = 0.0;
    vec2 tng = vec2(-nrm.y, nrm.x);
    float jitter = ign(gl_FragCoord.xy);
    for (int i = 0; i < TAPS; i++) {
      float x = (float(i) + jitter) / float(TAPS);
      // Sound as light: each colour of the rim fringe listens to its own band, bass in red through highs in violet.
      // A loud band leans its colour a little further and a little stronger; the fringe stays a thin rim.
      float tone = u_bands[i / 4];
      vec3 w = spectrum(x) * (1.0 + 0.6 * tone);
      // Red goes deeper, blue stays closer to the edge: red fringe outside, cyan inside.
      // A small spread along the rim softens hard cuts in the glyph.
      float along = (fract(x * 7.31 + jitter) - 0.5) * 0.25;
      float spread = (0.5 - x) * order * (1.0 + 0.5 * tone + 0.8 * u_light.z + 0.5 * reachHit);
      vec2 off = -dir * (k + kDisp * u_disp * spread * 0.75) + ripple + wake;
      vec4 c;
      if (vol) {
        off += throughSlab(n3, ior + u_disp * 0.3 * spread, h) * side * wave * u_depth;
        // The along-rim spread blends into the flat version with u_depth; otherwise it jumped at the moment volume was turned off.
        c = floorAt(p + par + off + tng * mix(k, length(off), u_depth) * along, blur);
      } else {
        c = content(p + par + off + tng * k * along, blur);
      }
      acc += c.rgb * w;
      wsum += w;
      aacc += c.a;
    }
    float a = aacc / float(TAPS);
    inside = vec4(min(acc / wsum, vec3(a)), a);
    // Averaging the samples desaturates the fringe, so give back some saturation, only where there is smear.
    // Just some: past this colored logos and photos turn acid.
    float luma = dot(inside.rgb, vec3(0.299, 0.587, 0.114));
    inside.rgb = clamp(luma + (inside.rgb - luma) * 1.35, 0.0, a);
  }

  float lit = 0.55 + 0.45 * dot(nrm, L);
  // A thin glint right at the edge; photographed glass always has one.
  float glint = exp(-sq((-d - 0.012) / (2.0 * px)));
  // Flat rim: a light band with a thin glint inside and a gray outline outside.
  float band = smoothstep(0.035, 0.0, -d);
  vec4 flatRim = mix(inside, vec4(1.0), clamp(glint * (0.35 + 0.55 * lit + 0.6 * u_light.y) + band * (0.12 + 0.15 * u_light.y), 0.0, 1.0));
  if (vol) {
    vec4 v = inside;
    // Fresnel reflection of the room, kept weak: the glass should read as clear, not glossy plastic.
    vec3 refl = reflect(vec3(u_tilt * 0.25, -1.0), n3); // the room in the rim slides with the lean
    if (u_light.x != 0.0) refl.xy = turn(u_light.x) * refl.xy;
    float fres = (0.04 + 0.96 * pow(max(1.0 - n3.z, 0.0), 3.0)) * step(tr, 0.999);
    v = mix(v, vec4(studio(refl), 1.0), clamp(fres, 0.0, 1.0) * (0.55 + 0.3 * u_light.y));
    // The seam where the rim meets the flat top: a highlight on the lit side, a shadow on the opposite side.
    float seam = exp(-sq((depth - rimW) / (1.4 * px)));
    float toLight = dot(nrm, L);
    v = mix(v, vec4(1.0), seam * max(toLight, 0.0) * (0.6 + 0.5 * u_light.y));
    v.rgb *= 1.0 - seam * max(-toLight, 0.0) * 0.2;
    v = mix(v, vec4(1.0), glint * (0.25 + 0.5 * lit + 0.6 * u_light.y));
    // Facet edges catch the light as fine lines, brighter on the side facing it.
    if (u_facet > 0.001) {
      float edgeLine = exp(-sq((e - 0.5) * u_edge / (1.1 * px)));
      float rimLine = exp(-sq(((1.0 - tr) - 0.5) * rimW / (1.1 * px)));
      v = mix(v, vec4(1.0), u_facet * (0.35 * edgeLine + 0.45 * rimLine) * (0.4 + 0.6 * max(toLight, 0.0)));
    }
    // The volume dissolves into flat glass with u_depth, with no jump at the end.
    inside = mix(flatRim, v, u_depth);
  } else {
    inside = flatRim;
  }

  float line = smoothstep(2.0 * px, 0.0, -d);
  if (u_mode > 0.5 && u_mode < 1.5) inside = mix(inside, vec4(1.0), 0.3 * line);
  else inside.rgb *= 1.0 - (0.12 + 0.2 * u_light.y) * line;

  float cov = clamp(0.5 - d / px, 0.0, 1.0);
  gl_FragColor = inside * cov + outside * (1.0 - cov);
}`;

const UNIFORMS = [
  "u_sdf", "u_color", "u_texSize", "u_halfPx", "u_n", "u_edge", "u_refract", "u_disp", "u_phase",
  "u_motion", "u_size", "u_tint", "u_reverse", "u_sideMix", "u_sideTwo", "u_angle", "u_spread", "u_liquid", "u_volume", "u_depth", "u_facet", "u_bg", "u_mode",
  "u_sound", "u_bands", "u_press", "u_fields", "u_light", "u_tilt", "u_zoom", "u_shadow",
];
const SILENT = [0, 0, 0, 0];
const NO_BANDS = new Float32Array(8);
const NO_FIELDS = new Float32Array(36);
const STILL = [0, 0];

export class GlassRenderer {
  canvas;
  gl;
  program;
  sdf;
  color;
  texSize = 1;
  loc = {};

  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("webgl");
    this.gl = gl;
    const derivatives = !!gl.getExtension("OES_standard_derivatives");
    this.program = this.link(frag(derivatives));
    gl.useProgram(this.program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    for (const name of UNIFORMS) this.loc[name] = gl.getUniformLocation(this.program, name);
    this.sdf = this.texture(0);
    this.color = this.texture(1);
    gl.uniform1i(this.loc.u_sdf, 0);
    gl.uniform1i(this.loc.u_color, 1);
  }

  texture(unit) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  link(fragSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    return prog;
  }

  // sdf is size × size bytes (128 is the edge); color is a canvas of the same size with color extended past the edge.
  setLogo(sdf, color, size) {
    const gl = this.gl;
    this.texSize = size;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sdf);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, size, size, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, sdf);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.color);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, color);
  }

  setSize(px) {
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
  }

  render(params, phase) {
    const gl = this.gl;
    const size = this.canvas.width;
    gl.viewport(0, 0, size, size);
    gl.uniform1f(this.loc.u_texSize, this.texSize);
    const frame = params.frame ?? ICON_SCALE;
    gl.uniform1f(this.loc.u_halfPx, (size / 2) * frame);
    gl.uniform1f(this.loc.u_zoom, frame === ICON_SCALE ? 1 : ICON_SCALE / frame);
    gl.uniform1f(this.loc.u_shadow, params.shadow ?? 1);
    gl.uniform1f(this.loc.u_n, params.n);
    gl.uniform1f(this.loc.u_edge, params.edge);
    gl.uniform1f(this.loc.u_refract, params.refraction);
    gl.uniform1f(this.loc.u_disp, params.dispersion);
    gl.uniform1f(this.loc.u_phase, phase);
    gl.uniform1f(this.loc.u_motion, params.motion);
    gl.uniform1f(this.loc.u_size, params.size);
    gl.uniform4f(this.loc.u_tint, ...params.tint, params.tintMix);
    gl.uniform1f(this.loc.u_reverse, params.reverse ?? 0);
    gl.uniform1f(this.loc.u_sideMix, params.sideMix);
    gl.uniform1f(this.loc.u_sideTwo, params.sideTwo);
    gl.uniform1f(this.loc.u_angle, params.angle);
    gl.uniform1f(this.loc.u_spread, params.spread);
    gl.uniform1f(this.loc.u_liquid, params.liquid);
    gl.uniform1f(this.loc.u_volume, params.volume);
    gl.uniform1f(this.loc.u_depth, params.depth);
    gl.uniform1f(this.loc.u_facet, params.facet ?? 0);
    gl.uniform3fv(this.loc.u_bg, params.bg);
    gl.uniform1f(this.loc.u_mode, params.background === "light" ? 0 : params.background === "dark" ? 1 : 2);
    gl.uniform4fv(this.loc.u_sound, params.sound ?? SILENT);
    gl.uniform1fv(this.loc.u_bands, params.bands ?? NO_BANDS);
    gl.uniform4fv(this.loc.u_press, params.press ?? SILENT);
    gl.uniform4fv(this.loc.u_fields, params.fields ?? NO_FIELDS);
    gl.uniform4fv(this.loc.u_light, params.light ?? SILENT);
    gl.uniform2fv(this.loc.u_tilt, params.tilt ?? STILL);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
