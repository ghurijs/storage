// Image type detection and dimension parsing from file headers (PNG, JPEG, GIF, WebP, BMP; AVIF/HEIC type only).
// Pure TypeScript, no native dependencies.
import { type FileContent, isBlob, isReadableStream } from './content'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heic'

export interface ImageInfo {
  format: ImageFormat
  mimeType: string
  /** Null when the format is recognized but its dimensions can't be read from the header (AVIF/HEIC). */
  width: number | null
  height: number | null
}

const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
}

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end))

/** Detect the image format from magic bytes, or null. */
export function detectImageFormat(b: Uint8Array): ImageFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a)
    return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp'
  if (b.length >= 26 && ascii(b, 0, 2) === 'BM') return 'bmp'
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heic'
  }
  return null
}

function u16be(b: Uint8Array, o: number) {
  return (b[o] << 8) | b[o + 1]
}
function u16le(b: Uint8Array, o: number) {
  return b[o] | (b[o + 1] << 8)
}
function u24le(b: Uint8Array, o: number) {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
}
function u32be(b: Uint8Array, o: number) {
  return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])
}
function i32le(b: Uint8Array, o: number) {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
}

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null
    let marker = b[i + 1]
    while (marker === 0xff && i + 2 < b.length) {
      i++
      marker = b[i + 1]
    }
    i += 2
    // standalone markers (no length): TEM, RSTn, SOI, EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
    if (i + 1 >= b.length) return null
    const len = u16be(b, i)
    // SOFn (excluding DHT C4, JPG C8, DAC CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 6 >= b.length) return null
      return [u16be(b, i + 5), u16be(b, i + 3)]
    }
    if (marker === 0xda) return null // start of scan before any SOF
    i += len
  }
  return null
}

function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 25) return null
  const chunk = ascii(b, 12, 16)
  if (chunk === 'VP8 ') {
    if (b.length < 30) return null
    // frame tag (3 bytes) + start code 9d 01 2a + 14-bit width/height
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff]
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const b0 = b[21]
    const b1 = b[22]
    const b2 = b[23]
    const b3 = b[24]
    return [1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))]
  }
  if (chunk === 'VP8X' && b.length >= 30) return [1 + u24le(b, 24), 1 + u24le(b, 27)]
  return null
}

/**
 * Parse an image header: format, MIME type and pixel dimensions. Returns null when the bytes are not a
 * recognized image (or the header is truncated).
 */
export function getImageInfo(bytes: Uint8Array): ImageInfo | null {
  const format = detectImageFormat(bytes)
  if (!format) return null
  let size: [number, number] | null = null
  switch (format) {
    case 'png':
      if (bytes.length >= 24 && ascii(bytes, 12, 16) === 'IHDR') size = [u32be(bytes, 16), u32be(bytes, 20)]
      break
    case 'gif':
      if (bytes.length >= 10) size = [u16le(bytes, 6), u16le(bytes, 8)]
      break
    case 'jpeg':
      size = jpegSize(bytes)
      break
    case 'webp':
      size = webpSize(bytes)
      break
    case 'bmp': {
      const headerSize = i32le(bytes, 14)
      if (headerSize === 12) size = [u16le(bytes, 18), u16le(bytes, 20)]
      else size = [Math.abs(i32le(bytes, 18)), Math.abs(i32le(bytes, 22))]
      break
    }
    case 'avif':
    case 'heic':
      return { format, mimeType: MIME[format], width: null, height: null }
  }
  if (!size || !(size[0] > 0) || !(size[1] > 0)) return null
  return { format, mimeType: MIME[format], width: size[0], height: size[1] }
}

/** `{ width, height }` of an image, or null when not an image / unreadable. */
export function getImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const info = getImageInfo(bytes)
  return info && info.width !== null && info.height !== null
    ? { width: info.width, height: info.height }
    : null
}

const HEAD_BYTES = 64 * 1024

/**
 * Read image info from any file content without loading more than needed: the first 64 KiB of a Blob, and
 * the whole Blob only for JPEGs whose frame header comes later (large EXIF blocks).
 */
export async function readImageInfo(content: FileContent): Promise<ImageInfo | null> {
  if (isBlob(content)) {
    const head = new Uint8Array(await content.slice(0, HEAD_BYTES).arrayBuffer())
    const info = getImageInfo(head)
    if (info || content.size <= HEAD_BYTES || detectImageFormat(head) !== 'jpeg') return info
    return getImageInfo(new Uint8Array(await content.arrayBuffer()))
  }
  if (typeof content === 'string') return getImageInfo(new TextEncoder().encode(content))
  if (content instanceof ArrayBuffer) return getImageInfo(new Uint8Array(content))
  if (ArrayBuffer.isView(content))
    return getImageInfo(new Uint8Array(content.buffer, content.byteOffset, content.byteLength))
  if (isReadableStream(content))
    throw new TypeError('readImageInfo() cannot consume a ReadableStream; buffer it first.')
  return null
}
