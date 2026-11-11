import { createApp, defineSettings, path } from '@ghuri/core'
import { createTestClient } from '@ghuri/core/testing'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  mediaPatterns,
  memoryStorage,
  parseRangeHeader,
  type R2BucketLike,
  r2,
  serveMedia,
} from '../src/index'

const memory = memoryStorage()
let mf: Miniflare
let bucket: R2BucketLike

const settings = defineSettings(() => ({
  SECRET_KEY: 'test',
  INSTALLED_APPS: [],
  MEDIA_URL: '/media/',
  STORAGES: { default: memory, cloud: r2('MEDIA') },
  ROOT_URLCONF: [
    path('media/<path:name>', serveMedia()),
    path('download/<path:name>', serveMedia({ download: true, cacheControl: 'private, no-store' })),
    ...mediaPatterns('r2/', { storage: 'cloud' }),
  ],
}))

let client: ReturnType<typeof createTestClient>
let etag: string

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null, { status: 204 }) } }',
    r2Buckets: ['MEDIA'],
  })
  bucket = (await mf.getR2Bucket('MEDIA')) as unknown as R2BucketLike
  client = createTestClient(createApp(settings), { env: { MEDIA: bucket } })
  await memory.storage.save('docs/hello.txt', 'Hello, media!')
  await memory.storage.save('docs/ছবি 1.txt', 'unicode')
  await memory.storage.save(
    'evil.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  )
  etag = (await memory.storage.stat('docs/hello.txt'))!.etag!
  await bucket.put('big/data.bin', new TextEncoder().encode('0123456789abcdefghij'), {
    httpMetadata: { contentType: 'application/x-test' },
  })
})
afterAll(async () => {
  await mf?.dispose()
})

describe('serveMedia', () => {
  it('streams a file with metadata headers', async () => {
    const res = await client.get('/media/docs/hello.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Hello, media!')
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('content-length')).toBe('13')
    expect(res.headers.get('etag')).toBe(etag)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('last-modified')).toBeTruthy()
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('decodes percent-encoded names', async () => {
    const res = await client.get(`/media/docs/${encodeURIComponent('ছবি 1.txt')}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('unicode')
  })

  it('404s for missing files and traversal attempts', async () => {
    expect((await client.get('/media/docs/nope.txt')).status).toBe(404)
    expect((await client.get('/media/docs/%2E%2E/%2E%2E/secret')).status).toBe(404)
    expect((await client.get('/media/..%2Fsecret')).status).toBe(404)
  })

  it('answers conditional requests with 304', async () => {
    const res = await client.get('/media/docs/hello.txt', { headers: { 'If-None-Match': etag } })
    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
    expect(res.headers.get('etag')).toBe(etag)
    expect(
      (await client.get('/media/docs/hello.txt', { headers: { 'If-None-Match': `W/${etag}, "x"` } })).status,
    ).toBe(304)
    expect((await client.get('/media/docs/hello.txt', { headers: { 'If-None-Match': '*' } })).status).toBe(
      304,
    )
    expect(
      (await client.get('/media/docs/hello.txt', { headers: { 'If-None-Match': '"other"' } })).status,
    ).toBe(200)
    const future = new Date(Date.now() + 60_000).toUTCString()
    expect(
      (await client.get('/media/docs/hello.txt', { headers: { 'If-Modified-Since': future } })).status,
    ).toBe(304)
    const past = new Date(Date.now() - 3_600_000).toUTCString()
    expect(
      (await client.get('/media/docs/hello.txt', { headers: { 'If-Modified-Since': past } })).status,
    ).toBe(200)
  })

  it('serves byte ranges (206 / 416)', async () => {
    let res = await client.get('/media/docs/hello.txt', { headers: { Range: 'bytes=0-4' } })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('Hello')
    expect(res.headers.get('content-range')).toBe('bytes 0-4/13')
    expect(res.headers.get('content-length')).toBe('5')

    res = await client.get('/media/docs/hello.txt', { headers: { Range: 'bytes=7-' } })
    expect([res.status, await res.text(), res.headers.get('content-range')]).toEqual([
      206,
      'media!',
      'bytes 7-12/13',
    ])

    res = await client.get('/media/docs/hello.txt', { headers: { Range: 'bytes=-6' } })
    expect([res.status, await res.text()]).toEqual([206, 'media!'])

    res = await client.get('/media/docs/hello.txt', { headers: { Range: 'bytes=10-1000' } })
    expect([res.status, await res.text(), res.headers.get('content-range')]).toEqual([
      206,
      'ia!',
      'bytes 10-12/13',
    ])

    res = await client.get('/media/docs/hello.txt', { headers: { Range: 'bytes=13-' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */13')

    res = await client.get('/media/docs/hello.txt', { headers: { Range: 'bytes=0-1,4-5' } })
    expect([res.status, await res.text()]).toEqual([200, 'Hello, media!'])

    res = await client.get('/media/docs/hello.txt', {
      headers: { Range: 'bytes=0-4', 'If-Range': '"stale"' },
    })
    expect(res.status).toBe(200)
    res = await client.get('/media/docs/hello.txt', { headers: { Range: 'bytes=0-4', 'If-Range': etag } })
    expect(res.status).toBe(206)
  })

  it('supports HEAD and rejects other methods', async () => {
    const head = await client.head('/media/docs/hello.txt')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('13')
    expect(await head.text()).toBe('')
    const post = await client.post('/media/docs/hello.txt', { csrf: false })
    expect([403, 405]).toContain(post.status)
  })

  it('sandboxes active content and can force downloads', async () => {
    const svg = await client.get('/media/evil.svg')
    expect(svg.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(svg.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    const dl = await client.get(`/download/docs/${encodeURIComponent('ছবি 1.txt')}`)
    expect(dl.headers.get('content-disposition')).toBe(
      `attachment; filename="___ 1.txt"; filename*=UTF-8''${encodeURIComponent('ছবি 1.txt')}`,
    )
    expect(dl.headers.get('cache-control')).toBe('private, no-store')
  })

  it('serves from an R2 binding with ranges (mediaPatterns)', async () => {
    let res = await client.get('/r2/big/data.bin')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-test')
    expect(await res.text()).toBe('0123456789abcdefghij')
    const r2etag = res.headers.get('etag')!
    expect(r2etag).toMatch(/^"[0-9a-f]+"$/)
    res = await client.get('/r2/big/data.bin', { headers: { Range: 'bytes=10-14' } })
    expect([res.status, await res.text(), res.headers.get('content-range')]).toEqual([
      206,
      'abcde',
      'bytes 10-14/20',
    ])
    res = await client.get('/r2/big/data.bin', { headers: { Range: 'bytes=-5' } })
    expect([res.status, await res.text()]).toEqual([206, 'fghij'])
    res = await client.get('/r2/big/data.bin', { headers: { 'If-None-Match': r2etag } })
    expect(res.status).toBe(304)
    expect((await client.get('/r2/missing')).status).toBe(404)
  })
})

describe('parseRangeHeader', () => {
  it.each([
    ['bytes=0-99', { offset: 0, length: 100 }],
    ['bytes=5-', { offset: 5 }],
    ['bytes=-20', { suffix: 20 }],
    ['bytes = 1 - 2', { offset: 1, length: 2 }],
    ['bytes=5-1', undefined],
    ['bytes=-', undefined],
    ['items=0-1', undefined],
    ['bytes=0-1,3-4', undefined],
    [null, undefined],
  ])('%s', (header, expected) => {
    expect(parseRangeHeader(header)).toEqual(expected)
  })
})
