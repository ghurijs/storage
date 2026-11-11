// Minimal, valid image headers generated in-test (no binary fixtures in the repo).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function concat(...parts: Array<Uint8Array | number[]>): Uint8Array<ArrayBuffer> {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)))
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrays) {
    out.set(a, o)
    o += a.length
  }
  return out
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff]
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff]
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

function pngChunk(type: string, data: number[]): Uint8Array<ArrayBuffer> {
  const body = concat(ascii(type), data)
  return concat(be32(data.length), body, be32(crc32(body)))
}

export function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    pngChunk('IDAT', [0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1]),
    pngChunk('IEND', []),
  )
}

/** JPEG with an optional large APP1 (EXIF-like) segment before the SOF0 frame header. */
export function jpeg(
  width: number,
  height: number,
  opts: { padding?: number; progressive?: boolean } = {},
): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const pads: Uint8Array[] = []
  let remaining = opts.padding ?? 0
  while (remaining > 0) {
    const n = Math.min(remaining, 65_000)
    pads.push(concat([0xff, 0xe1, ...be16(n + 2)], new Uint8Array(n)))
    remaining -= n
  }
  const sof = [0xff, opts.progressive ? 0xc2 : 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3]
  for (let i = 1; i <= 3; i++) sof.push(i, 0x11, 0)
  const sos = [0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]
  return concat(
    [0xff, 0xd8],
    app0,
    ...pads,
    [0xff, 0xdb, ...be16(67), 0, ...new Array(64).fill(1)],
    sof,
    sos,
    [0x00, 0xff, 0xd9],
  )
}

export function gif(width: number, height: number): Uint8Array<ArrayBuffer> {
  return concat(ascii('GIF89a'), le16(width), le16(height), [0x80, 0, 0], [0, 0, 0, 255, 255, 255], [0x3b])
}

function riff(chunk: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = concat(ascii('WEBP'), ascii(chunk), le32(payload.length), payload)
  return concat(ascii('RIFF'), le32(body.length), body)
}

export function webpLossy(width: number, height: number): Uint8Array<ArrayBuffer> {
  return riff(
    'VP8 ',
    new Uint8Array([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0]),
  )
}

export function webpLossless(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  return riff('VP8L', new Uint8Array([0x2f, ...le32(bits >>> 0), 0, 0, 0]))
}

export function webpExtended(width: number, height: number): Uint8Array<ArrayBuffer> {
  return riff('VP8X', new Uint8Array([0x10, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]))
}

export function bmp(width: number, height: number): Uint8Array<ArrayBuffer> {
  return concat(
    ascii('BM'),
    le32(70),
    le32(0),
    le32(54),
    le32(40),
    le32(width),
    le32(-height >>> 0),
    [1, 0, 24, 0],
    new Array(24).fill(0),
  )
}
