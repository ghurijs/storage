// Content inputs, content-type guessing and the StoredFile wrapper. Workers-safe (web APIs only).

/** Anything `Storage.save()` accepts. Streams are buffered (S3 and R2 need a known length). */
export type FileContent = Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string

/** Normalized content handed to backends: bytes or a Blob (a `File` is a Blob). */
export type FileBody = Uint8Array | Blob

const MIME_TYPES: Record<string, string> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  ico: 'image/vnd.microsoft.icon',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // documents / text
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  epub: 'application/epub+zip',
  // archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  wasm: 'application/wasm',
  // audio / video
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  // fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** Guess a MIME type from a file name's extension (Python's `mimetypes.guess_type`, small table). */
export function guessContentType(name: string): string | undefined {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const type = MIME_TYPES[base.slice(dot + 1).toLowerCase()]
  if (type?.startsWith('text/') || type === 'image/svg+xml') return `${type}; charset=utf-8`
  return type
}

export function isBlob(v: unknown): v is Blob {
  return typeof Blob !== 'undefined' && v instanceof Blob
}

export function isReadableStream(v: unknown): v is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && v instanceof ReadableStream
}

/** True for values `Storage.save()` accepts. */
export function isFileContent(v: unknown): v is FileContent {
  return (
    typeof v === 'string' ||
    isBlob(v) ||
    v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v) ||
    isReadableStream(v)
  )
}

/** Name carried by the content itself (a `File`), if any. */
export function contentName(content: unknown): string | undefined {
  const n = (content as { name?: unknown } | null)?.name
  return typeof n === 'string' && n ? n : undefined
}

export interface NormalizedContent {
  body: FileBody
  size: number
  /** MIME type carried by the content (a Blob's `type`), if any. */
  type?: string
}

/** Turn any `FileContent` into bytes or a Blob with a known size. */
export async function normalizeContent(content: FileContent): Promise<NormalizedContent> {
  if (typeof content === 'string') {
    const body = new TextEncoder().encode(content)
    return { body, size: body.byteLength }
  }
  if (isBlob(content)) return { body: content, size: content.size, type: content.type || undefined }
  if (content instanceof ArrayBuffer) return { body: new Uint8Array(content), size: content.byteLength }
  if (ArrayBuffer.isView(content)) {
    const body = new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
    return { body, size: body.byteLength }
  }
  if (isReadableStream(content)) {
    const body = new Uint8Array(await new Response(content).arrayBuffer())
    return { body, size: body.byteLength }
  }
  throw new TypeError(
    'Unsupported file content: expected Blob, File, ArrayBuffer, Uint8Array, ReadableStream or string.',
  )
}

/** Bytes of a normalized body. */
export async function bodyBytes(body: FileBody): Promise<Uint8Array> {
  return body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer())
}

/** Pick the content type to store: explicit > Blob type > guessed from the name > octet-stream. */
export function resolveContentType(name: string, explicit?: string, carried?: string): string {
  return explicit || carried || guessContentType(name) || DEFAULT_CONTENT_TYPE
}

/** Hex SHA-1 of bytes (used as ETag by the memory backend). */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---- StoredFile ---------------------------------------------------------------------------------

/** Metadata of a stored file (`storage.stat(name)`). */
export interface StoredFileInfo {
  name: string
  /** Total size of the object in bytes. */
  size: number
  contentType: string
  /** HTTP entity tag, quoted (`"abc123"`), when the backend has one. */
  etag?: string
  lastModified?: Date
}

/** Byte range for `storage.open(name, { range })`: `{ offset, length? }` or the last `suffix` bytes. */
export type ByteRange = { offset: number; length?: number } | { suffix: number }

export interface OpenOptions {
  range?: ByteRange
}

/**
 * An opened file: metadata plus a single-use body (Django's `File` returned by `storage.open()`).
 * Read it once with `body` (stream), `arrayBuffer()`, `bytes()`, `text()` or `blob()`.
 */
export interface StoredFile extends StoredFileInfo {
  readonly body: ReadableStream<Uint8Array>
  /** Set when a range was requested: the slice actually returned. */
  readonly range?: { offset: number; length: number }
  readonly bodyUsed: boolean
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  blob(): Promise<Blob>
}

class StoredFileImpl implements StoredFile {
  name: string
  size: number
  contentType: string
  etag?: string
  lastModified?: Date
  readonly range?: { offset: number; length: number }
  private _body?: ReadableStream<Uint8Array>
  private used = false

  constructor(
    info: StoredFileInfo,
    private readonly source: ReadableStream<Uint8Array> | (() => ReadableStream<Uint8Array>),
    range?: { offset: number; length: number },
  ) {
    this.name = info.name
    this.size = info.size
    this.contentType = info.contentType
    this.etag = info.etag
    this.lastModified = info.lastModified
    this.range = range
  }

  get body(): ReadableStream<Uint8Array> {
    this._body ??= typeof this.source === 'function' ? this.source() : this.source
    return this._body
  }

  get bodyUsed(): boolean {
    return this.used || (this._body?.locked ?? false)
  }

  private take(): ReadableStream<Uint8Array> {
    if (this.bodyUsed) throw new TypeError(`The body of '${this.name}' has already been read.`)
    this.used = true
    return this.body
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Response(this.take()).arrayBuffer()
  }
  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer())
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer())
  }
  async blob(): Promise<Blob> {
    return new Blob([await this.arrayBuffer()], { type: this.contentType })
  }
}

/** Build a StoredFile (for custom backends). `body` may be a factory so it is only created when read. */
export function createStoredFile(
  info: StoredFileInfo,
  body: ReadableStream<Uint8Array> | (() => ReadableStream<Uint8Array>),
  range?: { offset: number; length: number },
): StoredFile {
  return new StoredFileImpl(info, body, range)
}

/** Stream over bytes. */
export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength) controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Resolve a requested range against a total size: `{ offset, length }` clamped to the object, or null
 * when unsatisfiable (offset past the end, empty suffix).
 */
export function resolveRange(range: ByteRange, size: number): { offset: number; length: number } | null {
  if ('suffix' in range) {
    if (range.suffix <= 0 || size === 0) return null
    const length = Math.min(range.suffix, size)
    return { offset: size - length, length }
  }
  if (range.offset < 0 || range.offset >= size) return null
  const max = size - range.offset
  const length = range.length === undefined ? max : Math.min(range.length, max)
  if (length <= 0) return null
  return { offset: range.offset, length }
}

/**
 * Django's `ContentFile`: a named `File` built from in-memory content.
 * `await post.cover.save('cover.png', new ContentFile(bytes))` or `post.cover = new ContentFile('…', 'a.txt')`.
 */
export class ContentFile extends File {
  constructor(
    content: string | ArrayBuffer | ArrayBufferView | Blob,
    name = 'content',
    options: FilePropertyBag = {},
  ) {
    super([content as BlobPart], name, options)
  }
}
