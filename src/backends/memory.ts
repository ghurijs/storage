import {
  bodyBytes,
  bytesStream,
  createStoredFile,
  type FileBody,
  type OpenOptions,
  resolveRange,
  type StoredFile,
  type StoredFileInfo,
  sha1Hex,
} from '../content'
import type { StorageConfig } from '../registry'
import { type BackendSaveOptions, dirPrefix, type ListDirResult, Storage } from '../storage'

interface MemoryEntry {
  data: Uint8Array
  contentType: string
  etag: string
  lastModified: Date
  cacheControl?: string
  contentDisposition?: string
  metadata?: Record<string, string>
}

export interface MemoryStorageOptions {
  /** Base URL for `url()` (default: `MEDIA_URL`). */
  baseUrl?: string
}

/** In-memory storage (Django's `InMemoryStorage`): per process / isolate. For tests and development. */
export class MemoryStorage extends Storage {
  readonly backend: string = 'memory'
  readonly files = new Map<string, MemoryEntry>()

  constructor(readonly options: MemoryStorageOptions = {}) {
    super()
  }

  protected async _save(name: string, body: FileBody, opts: BackendSaveOptions): Promise<string> {
    const data = (await bodyBytes(body)).slice()
    this.files.set(name, {
      data,
      contentType: opts.contentType,
      etag: `"${await sha1Hex(data)}"`,
      lastModified: new Date(),
      cacheControl: opts.cacheControl,
      contentDisposition: opts.contentDisposition,
      metadata: opts.metadata,
    })
    return name
  }

  async stat(name: string): Promise<StoredFileInfo | null> {
    const e = this.files.get(name)
    if (!e) return null
    return {
      name,
      size: e.data.byteLength,
      contentType: e.contentType,
      etag: e.etag,
      lastModified: e.lastModified,
    }
  }

  async open(name: string, opts: OpenOptions = {}): Promise<StoredFile | null> {
    const e = this.files.get(name)
    if (!e) return null
    const info = (await this.stat(name))!
    if (opts.range) {
      const r = resolveRange(opts.range, e.data.byteLength) ?? { offset: 0, length: 0 }
      return createStoredFile(info, () => bytesStream(e.data.slice(r.offset, r.offset + r.length)), r)
    }
    return createStoredFile(info, () => bytesStream(e.data.slice()))
  }

  async delete(name: string): Promise<void> {
    this.files.delete(name)
  }

  async listdir(path?: string): Promise<ListDirResult> {
    const prefix = dirPrefix(path)
    const dirs = new Set<string>()
    const files: string[] = []
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) files.push(rest)
      else dirs.add(rest.slice(0, slash))
    }
    return { dirs: [...dirs].sort(), files: files.sort() }
  }

  url(name: string): string {
    return this.joinUrl(this.options.baseUrl, name)
  }

  /** Remove every file. */
  clear(): void {
    this.files.clear()
  }
}

/** `STORAGES` entry for an in-memory storage (one store per config object, shared across requests). */
export function memoryStorage(opts: MemoryStorageOptions = {}): StorageConfig & { storage: MemoryStorage } {
  const storage = new MemoryStorage(opts)
  return {
    backend: 'memory',
    storage,
    create: () => storage,
  }
}
