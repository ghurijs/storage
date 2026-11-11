// A tiny in-memory S3 server for tests: verifies SigV4 (header and query auth) independently of aws4fetch,
// using node:crypto, and implements PUT / GET (incl. Range) / HEAD / DELETE / ListObjectsV2.
import { createHash, createHmac } from 'node:crypto'

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest()
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface MockObject {
  data: Uint8Array
  contentType: string
  headers: Record<string, string>
  lastModified: Date
  etag: string
}

export interface SignedRequestRecord {
  method: string
  url: string
  auth: 'header' | 'query'
  signedHeaders: string[]
  credential: string
}

export class S3Mock {
  readonly buckets = new Map<string, Map<string, MockObject>>()
  readonly requests: SignedRequestRecord[] = []
  pathStyle = true

  constructor(
    readonly opts: { accessKeyId: string; secretAccessKey: string; region: string; bucket: string },
  ) {
    this.buckets.set(opts.bucket, new Map())
  }

  get objects(): Map<string, MockObject> {
    return this.buckets.get(this.opts.bucket)!
  }

  private signingKey(date: string, region: string): Buffer {
    const kDate = hmac(`AWS4${this.opts.secretAccessKey}`, date)
    return hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request')
  }

  private canonicalUri(url: URL): string {
    return url.pathname
      .split('/')
      .map((s) => rfc3986(decodeURIComponent(s)))
      .join('/')
  }

  private canonicalQuery(url: URL, exclude: string[] = []): string {
    return [...url.searchParams]
      .filter(([k]) => !exclude.includes(k))
      .map(([k, v]) => [rfc3986(k), rfc3986(v)])
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
      .map((p) => p.join('='))
      .join('&')
  }

  /** Verify a request's SigV4 signature. Returns an error message, or null when valid. */
  verify(req: Request): string | null {
    const url = new URL(req.url)
    const query = url.searchParams.get('X-Amz-Signature')
    let credential: string
    let signedHeaders: string[]
    let signature: string
    let amzDate: string
    let payloadHash: string
    if (query) {
      if (url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return 'bad algorithm'
      credential = url.searchParams.get('X-Amz-Credential') ?? ''
      signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';')
      signature = query
      amzDate = url.searchParams.get('X-Amz-Date') ?? ''
      payloadHash = 'UNSIGNED-PAYLOAD'
      const expires = Number(url.searchParams.get('X-Amz-Expires'))
      if (!(expires > 0 && expires <= 604800)) return 'bad X-Amz-Expires'
      const signedAt = Date.parse(
        `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
      )
      if (Date.now() > signedAt + expires * 1000) return 'expired'
    } else {
      const auth = req.headers.get('authorization') ?? ''
      const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        auth,
      )
      if (!m) return `bad Authorization header: ${auth}`
      credential = m[1]
      signedHeaders = m[2].split(';')
      signature = m[3]
      amzDate = req.headers.get('x-amz-date') ?? ''
      payloadHash = req.headers.get('x-amz-content-sha256') ?? ''
      if (!payloadHash) return 'missing x-amz-content-sha256'
    }
    const [akid, date, region, service, term] = credential.split('/')
    if (akid !== this.opts.accessKeyId) return 'unknown access key'
    if (service !== 's3' || term !== 'aws4_request') return 'bad credential scope'
    if (region !== this.opts.region) return `bad region ${region}`
    if (!/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== date) return 'bad x-amz-date'
    if (!signedHeaders.includes('host')) return 'host not signed'
    const headerValue = (h: string) =>
      h === 'host' ? url.host : (req.headers.get(h) ?? '').trim().replace(/\s+/g, ' ')
    const canonical = [
      req.method,
      this.canonicalUri(url),
      this.canonicalQuery(url, ['X-Amz-Signature']),
      `${signedHeaders.map((h) => `${h}:${headerValue(h)}`).join('\n')}\n`,
      signedHeaders.join(';'),
      payloadHash,
    ].join('\n')
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      `${date}/${region}/s3/aws4_request`,
      sha256(canonical),
    ].join('\n')
    const expected = createHmac('sha256', this.signingKey(date, region)).update(stringToSign).digest('hex')
    if (expected !== signature) return 'SignatureDoesNotMatch'
    this.requests.push({
      method: req.method,
      url: req.url,
      auth: query ? 'query' : 'header',
      signedHeaders,
      credential,
    })
    return null
  }

  private error(status: number, code: string, message = code): Response {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
      {
        status,
        headers: { 'Content-Type': 'application/xml' },
      },
    )
  }

  /** Split a request URL into bucket and key (path-style or virtual-hosted). */
  private locate(url: URL): { bucket: string; key: string } {
    const parts = url.pathname.split('/').slice(1)
    if (this.pathStyle)
      return { bucket: decodeURIComponent(parts[0]), key: parts.slice(1).map(decodeURIComponent).join('/') }
    return { bucket: url.hostname.split('.')[0], key: parts.map(decodeURIComponent).join('/') }
  }

  fetch = async (req: Request): Promise<Response> => {
    const problem = this.verify(req)
    if (problem) return this.error(403, 'SignatureDoesNotMatch', problem)
    const url = new URL(req.url)
    const { bucket, key } = this.locate(url)
    const store = this.buckets.get(bucket)
    if (!store) return this.error(404, 'NoSuchBucket')
    if (!key) {
      if (req.method !== 'GET' || url.searchParams.get('list-type') !== '2')
        return this.error(400, 'InvalidRequest')
      const prefix = url.searchParams.get('prefix') ?? ''
      const delimiter = url.searchParams.get('delimiter') ?? ''
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
      const prefixes = new Set<string>()
      const contents: string[] = []
      for (const k of keys) {
        const rest = k.slice(prefix.length)
        const i = delimiter ? rest.indexOf(delimiter) : -1
        if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1))
        else contents.push(k)
      }
      // paginate one key per page to exercise continuation tokens
      const all = [...[...prefixes].map((p) => ({ p })), ...contents.map((k) => ({ k }))]
      const start = Number(url.searchParams.get('continuation-token') ?? 0)
      const page = all.slice(start, start + 2)
      const truncated = start + 2 < all.length
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}${page
        .map((e) =>
          'p' in e
            ? `<CommonPrefixes><Prefix>${esc(e.p!)}</Prefix></CommonPrefixes>`
            : `<Contents><Key>${esc(e.k!)}</Key><Size>${store.get(e.k!)!.data.byteLength}</Size></Contents>`,
        )
        .join('')}</ListBucketResult>`
      return new Response(xml, { headers: { 'Content-Type': 'application/xml' } })
    }
    switch (req.method) {
      case 'PUT': {
        const data = new Uint8Array(await req.arrayBuffer())
        const headers: Record<string, string> = {}
        for (const [k, v] of req.headers)
          if (k.startsWith('x-amz-meta-') || k === 'cache-control' || k === 'content-disposition')
            headers[k] = v
        const etag = `"${createHash('md5').update(data).digest('hex')}"`
        store.set(key, {
          data,
          contentType: req.headers.get('content-type') ?? 'binary/octet-stream',
          headers,
          lastModified: new Date(Math.floor(Date.now() / 1000) * 1000),
          etag,
        })
        return new Response(null, { status: 200, headers: { ETag: etag } })
      }
      case 'GET':
      case 'HEAD': {
        const obj = store.get(key)
        if (!obj)
          return req.method === 'HEAD' ? new Response(null, { status: 404 }) : this.error(404, 'NoSuchKey')
        const headers = new Headers({
          'Content-Type': obj.contentType,
          ETag: obj.etag,
          'Last-Modified': obj.lastModified.toUTCString(),
          'Accept-Ranges': 'bytes',
          ...obj.headers,
        })
        const range = req.headers.get('range')
        const size = obj.data.byteLength
        if (range && req.method === 'GET') {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range)!
          let start: number
          let end: number
          if (m[1] === '') {
            start = Math.max(0, size - Number(m[2]))
            end = size - 1
          } else {
            start = Number(m[1])
            end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
          }
          if (start >= size) {
            headers.set('Content-Range', `bytes */${size}`)
            return new Response(null, { status: 416, headers })
          }
          headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
          headers.set('Content-Length', String(end - start + 1))
          return new Response(obj.data.slice(start, end + 1), { status: 206, headers })
        }
        headers.set('Content-Length', String(size))
        return new Response(req.method === 'HEAD' ? null : obj.data.slice(), { status: 200, headers })
      }
      case 'DELETE':
        store.delete(key)
        return new Response(null, { status: 204 })
      default:
        return this.error(405, 'MethodNotAllowed')
    }
  }
}
