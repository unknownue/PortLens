// Generate the PortLens app icon source (1024x1024, 4x supersampled) and the derived sizes.
//
// Design: a lens looking at a network port, with a healthy-status dot.
//   dark rounded square (app theme)  ->  cyan magnifier ring + handle
//   inside the glass: an RJ45-style socket (rounded body + slots)
//   top-right: green "healthy" dot
// Everything is drawn procedurally (no dependencies); PNG encoding, box filtering and ICO
// packing are hand-rolled, same approach as LogLens's gen-icon.js so both apps stay buildable
// on a bare Node install.
//
// Usage: node gen-icon.cjs [outDir]      (default: src-tauri/icons)

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const S = 1024; // output size
const SS = 4; // supersampling factor
const R = 225; // corner radius of the tile

// palette (matches src/index.css dark theme)
const BG_TOP = [18, 22, 31]; // #12161f
const BG_BOT = [32, 44, 62]; // #202c3e
const GLASS = [27, 38, 52]; // #1b2634
const ACCENT = [69, 200, 220]; // #45c8dc
const ACCENT_DIM = [40, 122, 145]; // #287a91 rim shading
const SOCKET_INK = [168, 233, 245]; // #a8e9f5 brighter than the ring, so the shape survives at 16px
const OK = [74, 222, 128]; // #4ade80
const SLOT = [16, 21, 29]; // #10151d

// ---- geometry (1024 space) ----
const LENS = { cx: 462, cy: 452, r: 262, ring: 48 };
const HANDLE = { x0: 646, y0: 636, x1: 812, y1: 802, w: 84 };
// RJ45-ish socket inside the glass: light body, dark keyway across the top, three chunky slots
const SOCKET = { x0: 336, y0: 352, x1: 588, y1: 526, r: 30 };
const KEYWAY = { x0: 384, y0: 352, x1: 540, y1: 398, r: 12 };
const SLOTS = [366, 438, 510].map((x) => ({ x0: x, y0: 424, x1: x + 36, y1: 502 }));
const DOT = { cx: 748, cy: 232, r: 70, ring: 18 };

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRoundRect(x, y, s) {
  const cx = Math.max(s.x0 + s.r, Math.min(x, s.x1 - s.r));
  const cy = Math.max(s.y0 + s.r, Math.min(y, s.y1 - s.r));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= s.r * s.r;
}

// distance from point to a segment, used for the handle capsule
function segDist(x, y, x0, y0, x1, y1) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const wx = x - x0;
  const wy = y - y0;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const px = x0 + t * vx;
  const py = y0 + t * vy;
  return Math.hypot(x - px, y - py);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function sample(x, y) {
  // rounded tile
  const cx = Math.max(R, Math.min(x, S - R));
  const cy = Math.max(R, Math.min(y, S - R));
  if (Math.hypot(x - cx, y - cy) > R) return null;

  let color = mix(BG_TOP, BG_BOT, y / S);

  const lensDist = Math.hypot(x - LENS.cx, y - LENS.cy);
  const inGlass = lensDist <= LENS.r - LENS.ring;
  const inRing = lensDist <= LENS.r && !inGlass;

  if (inGlass) color = GLASS;

  // socket + slots inside the glass
  if (inGlass) {
    if (inRoundRect(x, y, SOCKET)) {
      color = inRoundRect(x, y, KEYWAY) ? SLOT : SOCKET_INK;
      for (const slot of SLOTS) {
        if (inRoundRect(x, y, { ...slot, r: 12 })) {
          color = SLOT;
          break;
        }
      }
    }
  }

  if (inRing) {
    // slight shading so the ring reads as glass thickness
    const t = (lensDist - (LENS.r - LENS.ring)) / LENS.ring;
    color = mix(ACCENT, ACCENT_DIM, t * 0.55);
  }

  // handle capsule (drawn after the ring so the joint looks continuous)
  if (segDist(x, y, HANDLE.x0, HANDLE.y0, HANDLE.x1, HANDLE.y1) <= HANDLE.w / 2) {
    color = ACCENT_DIM;
  }

  // status dot with a background-coloured separation ring
  const dotDist = Math.hypot(x - DOT.cx, y - DOT.cy);
  if (dotDist <= DOT.r + DOT.ring) color = mix(BG_BOT, GLASS, 0.5);
  if (dotDist <= DOT.r) color = OK;

  return color;
}

// ---- render (4x4 supersampling, alpha-aware) ----
const raw = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) {
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
    }
    const n = SS * SS;
    const i = (y * S + x) * 4;
    raw[i] = Math.round(r / n);
    raw[i + 1] = Math.round(g / n);
    raw[i + 2] = Math.round(b / n);
    raw[i + 3] = Math.round(a / n);
  }
}

// ---- PNG encoding ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const scan = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    scan[y * (stride + 1)] = 0; // filter none
    rgba.copy(scan, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(scan, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- box-filter downscale (premultiplied, so edges do not darken) ----
function boxScale(w0, h0, src, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * w0) / w);
      const x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * w0) / w));
      const y0 = Math.floor((y * h0) / h);
      const y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * h0) / h));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w0 + xx) * 4;
          const al = src[i + 3];
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += al;
        }
      }
      const i = (y * w + x) * 4;
      const n = (x1 - x0) * (y1 - y0);
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

// ---- icon.ico (PNG entries, Vista+) ----
function buildIco(entries) {
  const offset0 = 6 + 16 * entries.length;
  const header = Buffer.alloc(offset0);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);
  let off = offset0;
  entries.forEach((entry, i) => {
    const e = header.subarray(6 + i * 16, 6 + i * 16 + 16);
    e[0] = entry.w >= 256 ? 0 : entry.w;
    e[1] = entry.h >= 256 ? 0 : entry.h;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(entry.png.length, 8);
    e.writeUInt32LE(off, 12);
    off += entry.png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

const outDir = process.argv[2] || path.join(__dirname, "src-tauri", "icons");
fs.mkdirSync(outDir, { recursive: true });

const files = [
  ["icon-source-1024.png", encodePng(S, S, raw)],
  ["icon.png", encodePng(S, S, raw)],
  ["512x512.png", encodePng(512, 512, boxScale(S, S, raw, 512, 512))],
  ["128x128@2x.png", encodePng(256, 256, boxScale(S, S, raw, 256, 256))],
  ["128x128.png", encodePng(128, 128, boxScale(S, S, raw, 128, 128))],
  ["32x32.png", encodePng(32, 32, boxScale(S, S, raw, 32, 32))],
];
for (const [name, data] of files) {
  fs.writeFileSync(path.join(outDir, name), data);
  console.log("wrote", name, data.length, "bytes");
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const ico = buildIco(icoSizes.map((s) => ({ w: s, h: s, png: encodePng(s, s, boxScale(S, S, raw, s, s)) })));
fs.writeFileSync(path.join(outDir, "icon.ico"), ico);
console.log("wrote icon.ico with", icoSizes.join("/"), "sizes", ico.length, "bytes");
