import { tryGetContext } from '@ghuri/core'
import {
  type FileBody,
  type FileContent,
  normalizeContent,
  type OpenOptions,
  resolveContentType,
  type StoredFile,
  type StoredFileInfo,
} from './content'
import { FileNotFoundError, NotSupportedError, SuspiciousFileOperation } from './errors'
import {
  getValidFilename,
  joinName,
  joinUrl,
  normpath,
  randomString,
  splitExt,
  splitName,
  validateFileName,
} from './names'

export interface SaveOptions {
  /** MIME type to store (default: the Blob's type, else guessed from the name). */
  contentType?: string
  /** Maximum length of the final name (FileField passes its `maxLength`). */
  maxLength?: number
  /** Overwrite an existing file instead of picking a free name (default false, like Django). */
  overwrite?: boolean
  /** `Cache-Control` stored with the object (R2 / S3). */
  cacheControl?: string
  /** `Content-Disposition` stored with the object (R2 / S3). */
  contentDisposition?: string
  /** Custom metadata (R2 `customMetadata`, S3 `x-amz-meta-*`). */
  metadata?: Record<string, string>
}

/** Options a backend's `_save()` receives (content type already resolved). */
export interface BackendSaveOptions extends Omit<SaveOptions, 'contentType' | 'maxLength'> {
  contentType: string
  size: number
}

export interface PresignedUrlOptions {
  /** Seconds the URL stays valid (default 3600, max 604800 on S3). */
  expiresIn?: number
  /** HTTP method the URL is valid for (default GET; use PUT for direct browser uploads). */
  method?: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  /** Force a download name: sets `response-content-disposition` (GET only). */
  download?: string | boolean
  /** Override the response Content-Type (GET only). */
  responseContentType?: string
}

export interface ListDirResult {
  /** Immediate sub-directories (names relative to the listed path, no trailing slash). */
  dirs: string[]
  /** Files directly in the listed path (base names). */
  files: string[]
}

const MAX_NAME_ATTEMPTS = 100

/** The configured `MEDIA_URL` (default `/media/`). */
export function mediaUrl(): string {
  const v = tryGetContext()?.settings.MEDIA_URL
  return typeof v === 'string' && v ? v : '/media/'
}

/**
 * Django's `Storage` API. Backends implement `_save`, `stat`, `open`, `delete`, `listdir` and `url`;
 * `save()`, `exists()`, `size()`, naming and collision handling are shared.
 *
 * Names are `/`-separated relative paths (`avatars/2026/me.png`); they are what a `FileField` stores.
 */
export abstract class Storage {
  /** Backend identifier (`memory`, `r2`, `s3`, `filesystem`, …). */
  abstract readonly backend: string

  /**
   * Save `content` under `name` (or the content's own name when `name` is null) and return the final name,
   * which differs from `name` when a file already exists (a random suffix is added, like Django).
   */
  async save(name: string | null | undefined, content: FileContent, opts: SaveOptions = {}): Promise<string> {
    const given = name ?? (content as { name?: string })?.name
    if (!given) throw new TypeError('Storage.save() needs a name (or a File with a name).')
    let finalName = validateFileName(String(given).replace(/\\/g, '/'), true)
    const normalized = await normalizeContent(content)
    if (opts.overwrite) {
      if (opts.maxLength !== undefined && finalName.length > opts.maxLength)
        throw new SuspiciousFileOperation(
          `Storage can not overwrite '${finalName}': name longer than ${opts.maxLength} characters.`,
        )
    } else {
      finalName = await this.getAvailableName(finalName, opts.maxLength)
    }
    const contentType = resolveContentType(finalName, opts.contentType, normalized.type)
    const saved = await this._save(finalName, normalized.body, {
      contentType,
      size: normalized.size,
      overwrite: opts.overwrite,
      cacheControl: opts.cacheControl,
      contentDisposition: opts.contentDisposition,
      metadata: opts.metadata,
    })
    return validateFileName(saved, true)
  }

  /** Write the object. Return the name actually used (normally `name`). */
  protected abstract _save(name: string, body: FileBody, opts: BackendSaveOptions): Promise<string>

  /** Metadata of `name`, or null when it doesn't exist. */
  abstract stat(name: string): Promise<StoredFileInfo | null>

  /** Open `name` for reading (optionally a byte range); null when it doesn't exist. */
  abstract open(name: string, opts?: OpenOptions): Promise<StoredFile | null>

  /** Delete `name`. Deleting a missing file is not an error. */
  abstract delete(name: string): Promise<void>

  /** URL clients use to fetch the file (`MEDIA_URL` / `baseUrl` / `publicUrl` + name). */
  abstract url(name: string): string

  /** List a directory: `{ dirs, files }` directly under `path` (`''` = root). */
  abstract listdir(path?: string): Promise<ListDirResult>

  async exists(name: string): Promise<boolean> {
    return (await this.stat(name)) !== null
  }

  /** Size in bytes. Throws `FileNotFoundError` when missing. */
  async size(name: string): Promise<number> {
    const info = await this.stat(name)
    if (!info) throw new FileNotFoundError(name)
    return info.size
  }

  /** Last modification time, or null when the backend has none. Throws `FileNotFoundError` when missing. */
  async getModifiedTime(name: string): Promise<Date | null> {
    const info = await this.stat(name)
    if (!info) throw new FileNotFoundError(name)
    return info.lastModified ?? null
  }

  /** Time-limited signed URL (S3 API backends only). */
  async presignedUrl(_name: string, _opts: PresignedUrlOptions = {}): Promise<string> {
    throw new NotSupportedError(`The '${this.backend}' storage backend does not support presigned URLs.`)
  }

  /** Django's `get_valid_name`: a safe base name (`"my file?.txt"` → `my_file.txt`). */
  getValidName(name: string): string {
    return getValidFilename(name)
  }

  /**
   * Django's `generate_filename`: validate the directory part and clean the base name with
   * `getValidName()`. `photos/My Cat.JPG` → `photos/My_Cat.JPG`.
   */
  generateFilename(filename: string): string {
    const normalized = String(filename).replace(/\\/g, '/')
    const [dir, file] = splitName(normalized)
    if (dir.split('/').includes('..'))
      throw new SuspiciousFileOperation(`Detected path traversal attempt in '${dir}'.`)
    const joined = normpath(joinName(dir, this.getValidName(file)))
    return validateFileName(joined, true)
  }

  /** Django's `get_alternative_name`: `root_XXXXXXX.ext`. */
  getAlternativeName(fileRoot: string, fileExt: string): string {
    return `${fileRoot}_${randomString(7)}${fileExt}`
  }

  /**
   * Django's `get_available_name`: `name` if free, else `root_<7 random chars>.ext`; truncates the root
   * to honour `maxLength`.
   */
  async getAvailableName(name: string, maxLength?: number): Promise<string> {
    const normalized = validateFileName(name.replace(/\\/g, '/'), true)
    const [dir, file] = splitName(normalized)
    let [root, ext] = splitExt(file)
    let candidate = normalized
    let attempts = 0
    while ((await this.exists(candidate)) || (maxLength !== undefined && candidate.length > maxLength)) {
      if (++attempts > MAX_NAME_ATTEMPTS)
        throw new SuspiciousFileOperation(`Could not find an available name for '${name}'.`)
      candidate = joinName(dir, this.getAlternativeName(root, ext))
      if (maxLength === undefined) continue
      const truncation = candidate.length - maxLength
      if (truncation > 0) {
        root = root.slice(0, -truncation)
        if (!root) {
          throw new SuspiciousFileOperation(
            `Storage can not find an available filename for '${name}'. Please make sure that the ` +
              'corresponding file field allows sufficient "maxLength".',
          )
        }
        candidate = joinName(dir, this.getAlternativeName(root, ext))
      }
    }
    return candidate
  }

  /** URL helper for backends: `base` (or MEDIA_URL) + encoded name. */
  protected joinUrl(base: string | undefined, name: string): string {
    return joinUrl(base ?? mediaUrl(), name)
  }
}

/** True for `Storage` instances (also across duplicate module copies). */
export function isStorage(v: unknown): v is Storage {
  return (
    v instanceof Storage ||
    (!!v &&
      typeof v === 'object' &&
      typeof (v as Storage).save === 'function' &&
      typeof (v as Storage).open === 'function' &&
      typeof (v as Storage).url === 'function' &&
      typeof (v as Storage).stat === 'function')
  )
}

/** Normalize a directory argument of `listdir()` to a key prefix (`'a/b'` → `'a/b/'`, `''` → `''`). */
export function dirPrefix(path: string | undefined): string {
  const p = normpath((path ?? '').replace(/\\/g, '/'))
  if (p === '.' || p === '/' || p === '') return ''
  if (p.startsWith('/') || p.split('/').includes('..'))
    throw new SuspiciousFileOperation(`Detected path traversal attempt in '${path}'.`)
  return `${p}/`
}
