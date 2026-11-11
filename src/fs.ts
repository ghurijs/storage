// @ghuri/storage/fs — local filesystem storage (Node only: imports node:fs / node:path).
import { createReadStream } from 'node:fs'
import { mkdir, open as openFile, readdir, rm, stat as statFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import {
  bytesStream,
  createStoredFile,
  DEFAULT_CONTENT_TYPE,
  type FileBody,
  guessContentType,
  type OpenOptions,
  resolveRange,
  type StoredFile,
  type StoredFileInfo,
} from './content'
import { SuspiciousFileOperation } from './errors'
import type { StorageConfig } from './registry'
import { type BackendSaveOptions, dirPrefix, type ListDirResult, Storage } from './storage'

export interface FileSystemStorageOptions {
  /** Directory holding the files (Django's `MEDIA_ROOT`). Relative paths resolve from `process.cwd()`. */
  location: string
  /** Base URL for `url()` (default: `MEDIA_URL`). */
  baseUrl?: string
  /** Mode of new files (default 0o644). */
  filePermissions?: number
  /** Mode of new directories (default 0o755). */
  directoryPermissions?: number
}

/** Django's `FileSystemStorage`: files under `location` on the local disk (VPS / Node deployments). */
export class FileSystemStorage extends Storage {
  readonly backend: string = 'filesystem'
  readonly location: string

  constructor(readonly options: FileSystemStorageOptions) {
    super()
    if (!options.location) throw new TypeError('fileSystemStorage(): `location` is required.')
    this.location = resolve(options.location)
  }

  /** Absolute path of `name` on disk; rejects names escaping `location`. */
  path(name: string): string {
    const full = resolve(this.location, name.replace(/\\/g, '/'))
    const rel = relative(this.location, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
      throw new SuspiciousFileOperation(`The joined path (${full}) is located outside of the base path.`)
    return full
  }

  protected async _save(name: string, body: FileBody, opts: BackendSaveOptions): Promise<string> {
    let current = name
    for (let attempt = 0; ; attempt++) {
      const full = this.path(current)
      await mkdir(dirname(full), { recursive: true, mode: this.options.directoryPermissions ?? 0o755 })
      let handle: Awaited<ReturnType<typeof openFile>>
      try {
        // 'wx' = O_CREAT | O_EXCL: never clobber a file created concurrently (Django does the same)
        handle = await openFile(full, opts.overwrite ? 'w' : 'wx', this.options.filePermissions ?? 0o644)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 10) {
          current = await this.getAvailableName(current)
          continue
        }
        throw e
      }
      try {
        if (body instanceof Uint8Array) await handle.writeFile(body)
        else
          for await (const chunk of body.stream() as unknown as AsyncIterable<Uint8Array>)
            await handle.write(chunk)
      } catch (e) {
        await handle.close()
        await rm(full, { force: true })
        throw e
      }
      await handle.close()
      return relative(this.location, full).split(sep).join('/')
    }
  }

  async stat(name: string): Promise<StoredFileInfo | null> {
    try {
      const st = await statFile(this.path(name))
      if (!st.isFile()) return null
      return {
        name,
        size: st.size,
        contentType: guessContentType(name) ?? DEFAULT_CONTENT_TYPE,
        etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
        lastModified: st.mtime,
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR')
        return null
      throw e
    }
  }

  async open(name: string, opts: OpenOptions = {}): Promise<StoredFile | null> {
    const info = await this.stat(name)
    if (!info) return null
    const full = this.path(name)
    const stream = (start?: number, end?: number) => () =>
      Readable.toWeb(createReadStream(full, { start, end })) as unknown as ReadableStream<Uint8Array>
    if (opts.range) {
      const r = resolveRange(opts.range, info.size)
      if (!r) return createStoredFile(info, () => bytesStream(new Uint8Array()), { offset: 0, length: 0 })
      return createStoredFile(info, stream(r.offset, r.offset + r.length - 1), r)
    }
    return createStoredFile(info, stream())
  }

  async delete(name: string): Promise<void> {
    await rm(this.path(name), { force: true })
  }

  async listdir(path?: string): Promise<ListDirResult> {
    const prefix = dirPrefix(path)
    const dir = prefix ? this.path(prefix) : this.location
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      const files = entries.filter((e) => e.isFile()).map((e) => e.name)
      return { dirs: dirs.sort(), files: files.sort() }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { dirs: [], files: [] }
      throw e
    }
  }

  url(name: string): string {
    return this.joinUrl(this.options.baseUrl, name)
  }
}

/** `STORAGES` entry for local files: `fileSystemStorage({ location: './media', baseUrl: '/media/' })`. */
export function fileSystemStorage(opts: FileSystemStorageOptions): StorageConfig {
  let storage: FileSystemStorage | undefined
  return {
    backend: 'filesystem',
    create() {
      storage ??= new FileSystemStorage(opts)
      return storage
    },
  }
}
