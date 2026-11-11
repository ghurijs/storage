import { AwsClient } from 'aws4fetch'
import {
  bytesStream,
  createStoredFile,
  DEFAULT_CONTENT_TYPE,
  type FileBody,
  type OpenOptions,
  type StoredFile,
  type StoredFileInfo,
} from '../content'
import { StorageError } from '../errors'
import { encodeName } from '../names'
import type { StorageConfig } from '../registry'
import {
  type BackendSaveOptions,
  dirPrefix,
  type ListDirResult,
  type PresignedUrlOptions,
  Storage,
} from '../storage'

export interface S3StorageOptions {
  /**
   * Endpoint URL, e.g. `https://<account>.r2.cloudflarestorage.com` (R2), `http://localhost:9000` (MinIO),
   * `https://s3.eu-west-1.amazonaws.com` (AWS). Default: AWS for `region`.
   */
  endpoint?: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Signing region (default `auto` for R2 endpoints, else `us-east-1`). */
  region?: string
  /** Public base URL used by `url()` (CDN / custom domain / public bucket). Default: `MEDIA_URL`. */
  publicUrl?: string
  /**
   * Path-style URLs (`endpoint/bucket/key`) instead of virtual-hosted (`bucket.endpoint/key`).
   * Default: true, except for amazonaws.com endpoints.
   */
  forcePathStyle?: boolean
  /** Default `Cache-Control` stored with new objects. */
  cacheControl?: string
  /** Custom fetch (tests, proxies). Default: global fetch. */
  fetch?: (request: Request) => Promise<Response>
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  for (const m of xml.matchAll(re)) out.push(decodeXml(m[1]))
  return out
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * Any S3-compatible API (AWS S3, Cloudflare R2's S3 endpoint, MinIO, …) over `fetch` with SigV4 signing
 * (aws4fetch). Works on Workers and Node. Supports `presignedUrl()`.
 */
export class S3Storage extends Storage {
  readonly backend: string = 's3'
  readonly client: AwsClient
  readonly endpoint: URL
  readonly region: string
  readonly forcePathStyle: boolean
  private readonly fetchFn: (request: Request) => Promise<Response>

  constructor(readonly options: S3StorageOptions) {
    super()
    if (!options.bucket) throw new TypeError('s3(): `bucket` is required.')
    const endpoint = options.endpoint ?? `https://s3.${options.region ?? 'us-east-1'}.amazonaws.com`
    this.endpoint = new URL(endpoint.replace(/\/+$/, ''))
    const host = this.endpoint.hostname
    this.region = options.region ?? (host.endsWith('.r2.cloudflarestorage.com') ? 'auto' : 'us-east-1')
    this.forcePathStyle = options.forcePathStyle ?? !host.endsWith('amazonaws.com')
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      service: 's3',
      region: this.region,
      retries: 0,
    })
    this.fetchFn = options.fetch ?? ((req) => fetch(req))
  }

  /** URL of the bucket (no trailing slash). */
  bucketUrl(): string {
    const e = this.endpoint
    const base = e.pathname.replace(/\/+$/, '')
    if (this.forcePathStyle)
      return `${e.protocol}//${e.host}${base}/${encodeURIComponent(this.options.bucket)}`
    return `${e.protocol}//${this.options.bucket}.${e.host}${base}`
  }

  /** URL of an object. */
  objectUrl(name: string): string {
    return `${this.bucketUrl()}/${encodeName(name)}`
  }

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    const signed = await this.client.sign(url, init)
    return this.fetchFn(signed)
  }

  private async fail(res: Response, action: string, name?: string): Promise<never> {
    const text = await res.text().catch(() => '')
    const code = xmlValues(text, 'Code')[0]
    const message = xmlValues(text, 'Message')[0]
    throw new StorageError(
      `S3 ${action}${name ? ` '${name}'` : ''} failed: ${res.status} ${code ?? res.statusText}${message ? ` — ${message}` : ''}`,
      { status: res.status, code },
    )
  }

  protected async _save(name: string, body: FileBody, opts: BackendSaveOptions): Promise<string> {
    // fetch derives Content-Length from the (Blob / bytes) body
    const headers: Record<string, string> = { 'Content-Type': opts.contentType }
    const cacheControl = opts.cacheControl ?? this.options.cacheControl
    if (cacheControl) headers['Cache-Control'] = cacheControl
    if (opts.contentDisposition) headers['Content-Disposition'] = opts.contentDisposition
    for (const [k, v] of Object.entries(opts.metadata ?? {})) headers[`x-amz-meta-${k.toLowerCase()}`] = v
    const res = await this.send(this.objectUrl(name), {
      method: 'PUT',
      headers,
      body: body as BodyInit,
    })
    if (!res.ok) await this.fail(res, 'PUT', name)
    await res.body?.cancel()
    return name
  }

  private infoFrom(name: string, res: Response, size: number): StoredFileInfo {
    const lm = res.headers.get('Last-Modified')
    return {
      name,
      size,
      contentType: res.headers.get('Content-Type') || DEFAULT_CONTENT_TYPE,
      etag: res.headers.get('ETag') ?? undefined,
      lastModified: lm ? new Date(lm) : undefined,
    }
  }

  async stat(name: string): Promise<StoredFileInfo | null> {
    const res = await this.send(this.objectUrl(name), { method: 'HEAD' })
    if (res.status === 404) return null
    if (!res.ok) await this.fail(res, 'HEAD', name)
    return this.infoFrom(name, res, Number(res.headers.get('Content-Length') ?? 0))
  }

  async open(name: string, opts: OpenOptions = {}): Promise<StoredFile | null> {
    const headers: Record<string, string> = {}
    const r = opts.range
    if (r) {
      if ('suffix' in r) headers.Range = `bytes=-${r.suffix}`
      else headers.Range = `bytes=${r.offset}-${r.length === undefined ? '' : r.offset + r.length - 1}`
    }
    const res = await this.send(this.objectUrl(name), { method: 'GET', headers })
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (res.status === 416) {
      await res.body?.cancel()
      const st = await this.stat(name)
      if (!st) return null
      return createStoredFile(st, () => bytesStream(new Uint8Array()), { offset: 0, length: 0 })
    }
    if (!res.ok) await this.fail(res, 'GET', name)
    const body = res.body ?? bytesStream(new Uint8Array())
    const length = Number(res.headers.get('Content-Length') ?? 0)
    if (res.status === 206) {
      const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(res.headers.get('Content-Range') ?? '')
      const offset = m ? Number(m[1]) : 0
      const end = m ? Number(m[2]) : length - 1
      const total = m && m[3] !== '*' ? Number(m[3]) : length
      return createStoredFile(this.infoFrom(name, res, total), body, { offset, length: end - offset + 1 })
    }
    const info = this.infoFrom(name, res, length)
    return createStoredFile(info, body, r ? { offset: 0, length } : undefined)
  }

  async delete(name: string): Promise<void> {
    const res = await this.send(this.objectUrl(name), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) await this.fail(res, 'DELETE', name)
    await res.body?.cancel()
  }

  async listdir(path?: string): Promise<ListDirResult> {
    const prefix = dirPrefix(path)
    const dirs: string[] = []
    const files: string[] = []
    let token: string | undefined
    do {
      const url = new URL(`${this.bucketUrl()}/`)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('delimiter', '/')
      if (prefix) url.searchParams.set('prefix', prefix)
      if (token) url.searchParams.set('continuation-token', token)
      const res = await this.send(url.toString(), { method: 'GET' })
      if (!res.ok) await this.fail(res, 'LIST', prefix || '/')
      const xml = await res.text()
      for (const block of xml.match(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g) ?? [])
        for (const p of xmlValues(block, 'Prefix')) dirs.push(p.slice(prefix.length).replace(/\/$/, ''))
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [])
        for (const k of xmlValues(block, 'Key')) if (k !== prefix) files.push(k.slice(prefix.length))
      token =
        xmlValues(xml, 'IsTruncated')[0] === 'true' ? xmlValues(xml, 'NextContinuationToken')[0] : undefined
    } while (token)
    return { dirs: dirs.sort(), files: files.sort() }
  }

  url(name: string): string {
    return this.joinUrl(this.options.publicUrl, name)
  }

  /**
   * Presigned (query-string signed) URL valid for `expiresIn` seconds: share private files or let browsers
   * upload directly with `method: 'PUT'`.
   */
  override async presignedUrl(name: string, opts: PresignedUrlOptions = {}): Promise<string> {
    const expiresIn = Math.max(1, Math.min(604_800, Math.floor(opts.expiresIn ?? 3600)))
    const url = new URL(this.objectUrl(name))
    url.searchParams.set('X-Amz-Expires', String(expiresIn))
    if (opts.download) {
      const fname = typeof opts.download === 'string' ? opts.download : (name.split('/').pop() ?? name)
      url.searchParams.set('response-content-disposition', contentDisposition(fname))
    }
    if (opts.responseContentType) url.searchParams.set('response-content-type', opts.responseContentType)
    const signed = await this.client.sign(url.toString(), {
      method: opts.method ?? 'GET',
      aws: { signQuery: true },
    })
    return signed.url
  }
}

/**
 * `STORAGES` entry for an S3-compatible bucket:
 * `s3({ endpoint: env.S3_ENDPOINT, bucket: 'media', accessKeyId: env.S3_KEY, secretAccessKey: env.S3_SECRET })`.
 */
export function s3(opts: S3StorageOptions): StorageConfig {
  let storage: S3Storage | undefined
  return {
    backend: 's3',
    create() {
      storage ??= new S3Storage(opts)
      return storage
    },
  }
}
