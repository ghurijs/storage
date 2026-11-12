import { ImproperlyConfigured } from '@ghuri/core'
import {
  createStoredFile,
  DEFAULT_CONTENT_TYPE,
  type FileBody,
  type OpenOptions,
  resolveRange,
  type StoredFile,
  type StoredFileInfo,
} from '../content'
import { NotSupportedError } from '../errors'
import type { StorageConfig } from '../registry'
import {
  type BackendSaveOptions,
  dirPrefix,
  type ListDirResult,
  type PresignedUrlOptions,
  Storage,
} from '../storage'

// Minimal structural types of the Workers R2 binding (so users don't need @cloudflare/workers-types).
export interface R2HttpMetadataLike {
  contentType?: string
  contentDisposition?: string
  cacheControl?: string
  contentEncoding?: string
  contentLanguage?: string
}
export interface R2ObjectLike {
  key: string
  size: number
  etag: string
  httpEtag: string
  uploaded: Date
  httpMetadata?: R2HttpMetadataLike
  customMetadata?: Record<string, string>
  range?: { offset?: number; length?: number; suffix?: number }
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>
}
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>
  get(
    key: string,
    options?: { range?: { offset?: number; length?: number; suffix?: number } },
  ): Promise<R2ObjectBodyLike | R2ObjectLike | null>
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string | null,
    options?: { httpMetadata?: R2HttpMetadataLike; customMetadata?: Record<string, string> },
  ): Promise<R2ObjectLike | null>
  delete(keys: string | string[]): Promise<void>
  list(options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }): Promise<{
    objects: R2ObjectLike[]
    delimitedPrefixes: string[]
    truncated: boolean
    cursor?: string
  }>
}

export interface R2StorageOptions {
  /** Public base URL of the bucket (custom domain or `https://pub-xxxx.r2.dev`). Default: `MEDIA_URL`. */
  publicUrl?: string
  /** Default `Cache-Control` stored with new objects. */
  cacheControl?: string
}

function info(obj: R2ObjectLike): StoredFileInfo {
  return {
    name: obj.key,
    size: obj.size,
    contentType: obj.httpMetadata?.contentType || DEFAULT_CONTENT_TYPE,
    etag: obj.httpEtag || (obj.etag ? `"${obj.etag}"` : undefined),
    lastModified: obj.uploaded ? new Date(obj.uploaded) : undefined,
  }
}

function isBucket(v: unknown): v is R2BucketLike {
  return (
    !!v && typeof (v as R2BucketLike).put === 'function' && typeof (v as R2BucketLike).head === 'function'
  )
}

/**
 * Cloudflare R2 through a Workers binding. Fast and free of credentials; it cannot create presigned URLs
 * (use `s3()` against R2's S3 endpoint for those). `url()` uses `publicUrl`, else `MEDIA_URL` (serve the
 * files with `serveMedia()`).
 *
 * `url()` does no I/O, so it works without the binding (tests, scripts, a Worker without the bucket); the
 * other methods throw `ImproperlyConfigured` when the binding is missing.
 */
export class R2Storage extends Storage {
  readonly backend: string = 'r2'
  readonly #bucket: R2BucketLike | undefined
  readonly #bindingName: string | undefined

  /**
   * @param bucket the R2 binding; `null` / `undefined` makes every I/O method throw `ImproperlyConfigured`.
   * @param bindingName binding name used in that error message.
   */
  constructor(
    bucket: R2BucketLike | null | undefined,
    readonly options: R2StorageOptions = {},
    bindingName?: string,
  ) {
    super()
    this.#bucket = bucket ?? undefined
    this.#bindingName = bindingName
  }

  /** The R2 binding. Throws `ImproperlyConfigured` when it is missing. */
  get bucket(): R2BucketLike {
    if (this.#bucket) return this.#bucket
    const name = this.#bindingName === undefined ? '' : ` '${this.#bindingName}'`
    throw new ImproperlyConfigured(
      `R2 bucket binding${name} was not found in env. Add it to wrangler.jsonc under "r2_buckets". ` +
        '(url() works without it; reading and writing files needs the binding.)',
    )
  }

  protected async _save(name: string, body: FileBody, opts: BackendSaveOptions): Promise<string> {
    const httpMetadata: R2HttpMetadataLike = { contentType: opts.contentType }
    const cacheControl = opts.cacheControl ?? this.options.cacheControl
    if (cacheControl) httpMetadata.cacheControl = cacheControl
    if (opts.contentDisposition) httpMetadata.contentDisposition = opts.contentDisposition
    await this.bucket.put(name, body, { httpMetadata, customMetadata: opts.metadata })
    return name
  }

  async stat(name: string): Promise<StoredFileInfo | null> {
    const obj = await this.bucket.head(name)
    return obj ? info(obj) : null
  }

  async open(name: string, opts: OpenOptions = {}): Promise<StoredFile | null> {
    if (!opts.range) {
      const obj = await this.bucket.get(name)
      if (!obj || !('body' in obj)) return null
      return createStoredFile(info(obj), obj.body)
    }
    // Resolve the range against the size first: R2 rejects ranges past the end of the object.
    const head = await this.bucket.head(name)
    if (!head) return null
    const r = resolveRange(opts.range, head.size)
    if (!r) return createStoredFile(info(head), () => new Blob([]).stream(), { offset: 0, length: 0 })
    const obj = await this.bucket.get(name, { range: { offset: r.offset, length: r.length } })
    if (!obj || !('body' in obj)) return null
    return createStoredFile(info(obj), obj.body, r)
  }

  async delete(name: string): Promise<void> {
    await this.bucket.delete(name)
  }

  async listdir(path?: string): Promise<ListDirResult> {
    const prefix = dirPrefix(path)
    const dirs: string[] = []
    const files: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, delimiter: '/', cursor })
      for (const p of page.delimitedPrefixes) dirs.push(p.slice(prefix.length).replace(/\/$/, ''))
      for (const o of page.objects) files.push(o.key.slice(prefix.length))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return { dirs: dirs.sort(), files: files.sort() }
  }

  url(name: string): string {
    return this.joinUrl(this.options.publicUrl, name)
  }

  override async presignedUrl(_name: string, _opts?: PresignedUrlOptions): Promise<string> {
    throw new NotSupportedError(
      'R2 bindings cannot create presigned URLs. Configure an s3() storage with your R2 S3 API endpoint ' +
        '(https://<account>.r2.cloudflarestorage.com) and an R2 API token for signed URLs.',
    )
  }
}

/**
 * `STORAGES` entry for a Workers R2 binding: `r2('MEDIA', { publicUrl: 'https://media.example.com' })`.
 * `binding` is the binding name in `wrangler.jsonc` (or the bucket object itself).
 *
 * A missing binding is reported when the storage first reads or writes a file (`ImproperlyConfigured`), not
 * when it is created: `url()` needs no binding.
 */
export function r2(binding: string | R2BucketLike, opts: R2StorageOptions = {}): StorageConfig {
  return {
    backend: 'r2',
    create(env) {
      const bucket = typeof binding === 'string' ? env[binding] : binding
      return new R2Storage(isBucket(bucket) ? bucket : undefined, opts, String(binding))
    },
  }
}
