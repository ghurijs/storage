import { describe, expect, it } from 'vitest'
import { detectImageFormat, getImageDimensions, getImageInfo, readImageInfo } from '../src/index'
import { bmp, gif, jpeg, png, webpExtended, webpLossless, webpLossy } from './helpers/images'

describe('image header parsing', () => {
  it.each([
    ['png', png(640, 480), 'image/png', 640, 480],
    ['jpeg', jpeg(1920, 1080), 'image/jpeg', 1920, 1080],
    ['jpeg (progressive)', jpeg(33, 7, { progressive: true }), 'image/jpeg', 33, 7],
    ['gif', gif(16, 9), 'image/gif', 16, 9],
    ['webp VP8', webpLossy(300, 200), 'image/webp', 300, 200],
    ['webp VP8L', webpLossless(1234, 567), 'image/webp', 1234, 567],
    ['webp VP8X', webpExtended(16383, 9000), 'image/webp', 16383, 9000],
    ['bmp', bmp(12, 34), 'image/bmp', 12, 34],
  ])('%s', (_, bytes, mimeType, width, height) => {
    expect(getImageInfo(bytes)).toMatchObject({ mimeType, width, height })
    expect(getImageDimensions(bytes)).toEqual({ width, height })
  })

  it('rejects non-images and truncated headers', () => {
    expect(getImageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(getImageInfo(new TextEncoder().encode('GIF8'))).toBeNull()
    expect(getImageInfo(png(10, 10).slice(0, 20))).toBeNull()
    expect(getImageInfo(png(0, 10))).toBeNull()
    expect(getImageInfo(new Uint8Array())).toBeNull()
    expect(detectImageFormat(jpeg(1, 1))).toBe('jpeg')
  })

  it('recognizes AVIF/HEIC without dimensions', () => {
    const avif = new Uint8Array([0, 0, 0, 0x1c, ...new TextEncoder().encode('ftypavif'), 0, 0, 0, 0])
    expect(getImageInfo(avif)).toEqual({ format: 'avif', mimeType: 'image/avif', width: null, height: null })
    expect(getImageDimensions(avif)).toBeNull()
  })

  it('reads only the head of Blobs, falling back for JPEGs with big EXIF blocks', async () => {
    expect(await readImageInfo(new Blob([png(5, 6)]))).toMatchObject({ width: 5, height: 6 })
    const big = jpeg(800, 600, { padding: 200_000 })
    expect(big.byteLength).toBeGreaterThan(64 * 1024)
    expect(await readImageInfo(new Blob([big]))).toMatchObject({ width: 800, height: 600 })
    expect(await readImageInfo(gif(3, 4).buffer)).toMatchObject({ width: 3, height: 4 })
    expect(await readImageInfo('not an image')).toBeNull()
  })
})
