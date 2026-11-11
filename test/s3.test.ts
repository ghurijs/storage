import { afterEach, describe, expect, it, vi } from 'vitest'
import { S3Storage, StorageError, s3 } from '../src/index'
import { S3Mock } from './helpers/s3mock'

const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }

function setup(region = 'us-east-1', extra: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) {
  const mock = new S3Mock({ ...creds, region, bucket: 'media' })
  const storage = new S3Storage({
    ...creds,
    bucket: 'media',
    endpoint: 'http://localhost:9000',
    fetch: mock.fetch,
    ...extra,
  })
  return { mock, storage }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('S3Storage', () => {
  it('signs every request with SigV4 headers (verified independently)', async () => {
    const { mock, storage } = setup()
    await storage.save('a/b c.txt', 'hi', { cacheControl: 'max-age=60', metadata: { Owner: 'me' } })
    await storage.stat('a/b c.txt')
    await storage.delete('a/b c.txt')
    expect(mock.requests.map((r) => r.method)).toEqual(['HEAD', 'PUT', 'HEAD', 'DELETE'])
    const put = mock.requests[1]
    expect(put.auth).toBe('header')
    expect(put.url).toBe('http://localhost:9000/media/a/b%20c.txt')
    expect(put.signedHeaders).toEqual(
      expect.arrayContaining([
        'host',
        'x-amz-content-sha256',
        'x-amz-date',
        'x-amz-meta-owner',
        'cache-control',
      ]),
    )
    expect(put.credential).toMatch(/^AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request$/)
  })

  it('stores content type, cache control and metadata', async () => {
    const { mock, storage } = setup()
    await storage.save('x.json', '{}', { metadata: { a: '1' }, contentDisposition: 'inline' })
    const obj = mock.objects.get('x.json')!
    expect(obj.contentType).toBe('application/json')
    expect(obj.headers).toMatchObject({ 'x-amz-meta-a': '1', 'content-disposition': 'inline' })
    const withDefault = setup('us-east-1', { cacheControl: 'public, max-age=31536000' })
    await withDefault.storage.save('y.txt', 'y')
    expect(withDefault.mock.objects.get('y.txt')!.headers['cache-control']).toBe('public, max-age=31536000')
  })

  it('creates presigned GET/PUT URLs that verify and expire', async () => {
    const { mock, storage } = setup('eu-west-1', { region: 'eu-west-1' })
    await storage.save('private/doc (1).pdf', 'secret pdf')
    const url = await storage.presignedUrl('private/doc (1).pdf', { expiresIn: 600 })
    const u = new URL(url)
    expect(u.pathname).toBe('/media/private/doc%20%281%29.pdf')
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(u.searchParams.get('X-Amz-Credential')).toMatch(
      /^AKIDEXAMPLE\/\d{8}\/eu-west-1\/s3\/aws4_request$/,
    )
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // an unsigned client (browser) can use it
    const res = await mock.fetch(new Request(url))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('secret pdf')
    // tampering breaks the signature
    const tampered = new URL(url)
    tampered.searchParams.set('X-Amz-Expires', '6000')
    expect((await mock.fetch(new Request(tampered))).status).toBe(403)

    const putUrl = await storage.presignedUrl('uploads/direct.txt', { method: 'PUT' })
    const put = await mock.fetch(new Request(putUrl, { method: 'PUT', body: 'from browser' }))
    expect(put.status).toBe(200)
    expect(new TextDecoder().decode(mock.objects.get('uploads/direct.txt')!.data)).toBe('from browser')

    const dl = new URL(await storage.presignedUrl('private/doc (1).pdf', { download: 'Report ১.pdf' }))
    expect(dl.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="Report _.pdf"; filename*=UTF-8''Report%20%E0%A7%A7.pdf`,
    )
    expect((await mock.fetch(new Request(dl))).status).toBe(200)
  })

  it('rejects expired presigned URLs', async () => {
    const { mock, storage } = setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const url = await storage.presignedUrl('a.txt', { expiresIn: 60 })
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
    expect((await mock.fetch(new Request(url))).status).toBe(403)
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
    expect((await mock.fetch(new Request(url))).status).toBe(404)
  })

  it('supports virtual-hosted style and R2 endpoint defaults', async () => {
    const mock = new S3Mock({ ...creds, region: 'auto', bucket: 'media' })
    mock.pathStyle = false
    const storage = new S3Storage({
      ...creds,
      bucket: 'media',
      endpoint: 'https://acc123.r2.cloudflarestorage.com',
      forcePathStyle: false,
      fetch: mock.fetch,
    })
    expect(storage.region).toBe('auto')
    expect(storage.objectUrl('a/b.txt')).toBe('https://media.acc123.r2.cloudflarestorage.com/a/b.txt')
    await storage.save('a/b.txt', 'r2')
    expect(await (await storage.open('a/b.txt'))!.text()).toBe('r2')

    const r2path = new S3Storage({
      ...creds,
      bucket: 'media',
      endpoint: 'https://acc123.r2.cloudflarestorage.com',
    })
    expect(r2path.forcePathStyle).toBe(true)
    const aws = new S3Storage({ ...creds, bucket: 'media', region: 'eu-central-1' })
    expect(aws.forcePathStyle).toBe(false)
    expect(aws.objectUrl('k')).toBe('https://media.s3.eu-central-1.amazonaws.com/k')
  })

  it('uses the global fetch by default and sends session tokens', async () => {
    const mock = new S3Mock({ ...creds, region: 'us-east-1', bucket: 'media' })
    const seen: Request[] = []
    vi.stubGlobal('fetch', async (req: Request) => {
      seen.push(req.clone())
      return mock.fetch(req)
    })
    const storage = s3({
      ...creds,
      bucket: 'media',
      endpoint: 'http://localhost:9000',
      sessionToken: 'TOKEN',
    }).create({})
    await storage.save('t.txt', 't')
    expect(seen.length).toBe(2)
    expect(seen[1].headers.get('x-amz-security-token')).toBe('TOKEN')
  })

  it('reports S3 errors with code and status', async () => {
    const { storage } = setup()
    const bad = new S3Storage({
      ...creds,
      secretAccessKey: 'wrong',
      bucket: 'media',
      endpoint: 'http://localhost:9000',
      fetch: setup().mock.fetch,
    })
    const err = await bad.save('x.txt', 'x').catch((e) => e)
    expect(err).toBeInstanceOf(StorageError)
    expect(err.status).toBe(403)
    expect(err.code).toBe('SignatureDoesNotMatch')
    const missing = new S3Storage({
      ...creds,
      bucket: 'nope',
      endpoint: 'http://localhost:9000',
      fetch: setup().mock.fetch,
    })
    await expect(missing.listdir()).rejects.toMatchObject({ status: 404, code: 'NoSuchBucket' })
    expect(await storage.open('missing.txt')).toBeNull()
  })

  it('paginates listdir with continuation tokens', async () => {
    const { storage } = setup()
    for (let i = 0; i < 7; i++) await storage.save(`many/f${i}.txt`, String(i))
    await storage.save('many/sub/x.txt', 'x')
    const { dirs, files } = await storage.listdir('many')
    expect(dirs).toEqual(['sub'])
    expect(files).toHaveLength(7)
  })
})
