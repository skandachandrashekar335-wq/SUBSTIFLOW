/**
 * Generates `public/icon.png` (256x256) and `public/icon.ico` for packaging.
 *
 * No image dependencies: the artwork is rasterised from primitives at 4x and
 * box-filtered down, then encoded as PNG with Node's built-in zlib.
 *
 * Run with: npm run icon
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256 // final icon size
const SS = 4 // supersampling factor
const SRC = SIZE * SS // raster size before downsampling

// ---------------------------------------------------------------------------
// Artwork: sky-blue rounded square with a white "swap" glyph (⇄)
// ---------------------------------------------------------------------------
const BG_TOP = [14, 165, 233] // primary-500
const BG_BOTTOM = [12, 74, 110] // primary-900
const GLYPH = [255, 255, 255]

function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false
  const cx = x < r ? r : x > w - r ? w - r : x
  const cy = y < r ? r : y > h - r ? h - r : y
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1
}

/** Triangle via barycentric sign test. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

function inGlyph(x, y) {
  // Upper arrow -> points right
  if (inRect(x, y, 56, 74, 176, 94)) return true
  if (inTriangle(x, y, 172, 62, 172, 106, 208, 84)) return true
  // Lower arrow -> points left
  if (inRect(x, y, 84, 162, 204, 182)) return true
  if (inTriangle(x, y, 88, 150, 88, 194, 52, 172)) return true
  return false
}

function colorAt(x, y) {
  if (!inRoundedRect(x, y, SIZE, SIZE, 56)) return [0, 0, 0, 0]
  const t = y / SIZE
  const bg = [
    Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
  ]
  if (inGlyph(x, y)) return [GLYPH[0], GLYPH[1], GLYPH[2], 255]
  return [bg[0], bg[1], bg[2], 255]
}

/** Box-filter `size`x`size` output, sampling SSx SS points per pixel. */
function render(size) {
  const buf = Buffer.alloc(size * size * 4)
  const unit = SIZE / size

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * unit
          const py = (y + (sy + 0.5) / SS) * unit
          const [cr, cg, cb, ca] = colorAt(px, py)
          // premultiply so averaging handles transparency correctly
          r += (cr * ca) / 255
          g += (cg * ca) / 255
          b += (cb * ca) / 255
          a += ca
        }
      }
      const n = SS * SS
      r = Math.round(r / n)
      g = Math.round(g / n)
      b = Math.round(b / n)
      a = Math.round(a / n)
      if (a > 0) {
        r = Math.min(255, Math.round((r * 255) / a))
        g = Math.min(255, Math.round((g * 255) / a))
        b = Math.min(255, Math.round((b * 255) / a))
      }
      const o = (y * size + x) * 4
      buf[o] = r
      buf[o + 1] = g
      buf[o + 2] = b
      buf[o + 3] = a
    }
  }
  return buf
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// ICO encoding (PNG-compressed entries — supported since Windows Vista)
// ---------------------------------------------------------------------------
function encodeIco(sizes) {
  const entries = sizes.map((size) => ({ size, png: encodePng(size, render(size)) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(entries.length * 16)
  let offset = 6 + entries.length * 16

  entries.forEach((e, i) => {
    const o = i * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0 // palette colours
    dir[o + 3] = 0 // reserved
    dir.writeUInt16LE(1, o + 4) // colour planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// ---------------------------------------------------------------------------
const outDir = path.join(__dirname, '..', 'public')
fs.mkdirSync(outDir, { recursive: true })

const png256 = encodePng(SIZE, render(SIZE))
fs.writeFileSync(path.join(outDir, 'icon.png'), png256)

const ico = encodeIco([16, 32, 48, 64, 128, 256])
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)

console.log(`wrote public/icon.png (${png256.length} bytes)`)
console.log(`wrote public/icon.ico (${ico.length} bytes)`)
