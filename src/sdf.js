// Distance field from the image alpha: the Felzenszwalb-Huttenlocher Euclidean distance transform,
// run separately outside and inside the shape. Semi-transparent edge pixels give subpixel accuracy.

const INF = 1e20;

// One pass over a row or column: squared distances to the nearest "zero" point.
function pass(grid, offset, stride, n, f, v, z) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  let k = 0;
  for (let q = 1; q < n; q++) {
    f[q] = grid[offset + q * stride];
    let s;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    grid[offset + q * stride] = f[r] + (q - r) * (q - r);
  }
}

function transform(grid, size) {
  const f = new Float64Array(size);
  const v = new Uint32Array(size);
  const z = new Float64Array(size + 1);
  for (let x = 0; x < size; x++) pass(grid, x, size, size, f, v, z);
  for (let y = 0; y < size; y++) pass(grid, y * size, 1, size, f, v, z);
}

// rgba: RGBA of a square size × size canvas. Returns bytes: 128 is the edge, higher is inside,
// with `spread` texels of distance spanning half the byte range.
export function buildSdf(rgba, size, spread) {
  const n = size * size;
  const outer = new Float64Array(n);
  const inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    outer[i] = a === 1 ? 0 : a === 0 ? INF : Math.max(0, 0.5 - a) ** 2;
    inner[i] = a === 0 ? 0 : a === 1 ? INF : Math.max(0, a - 0.5) ** 2;
  }
  transform(outer, size);
  transform(inner, size);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(inner[i]) - Math.sqrt(outer[i]); // > 0 inside
    out[i] = Math.max(0, Math.min(255, Math.round(128 + (d / spread) * 127)));
  }
  return out;
}
