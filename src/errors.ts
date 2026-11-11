import { GhuriError, SuspiciousOperation } from '@ghuri/core'

/** Base class of storage errors (backend failures, unsupported operations). */
export class StorageError extends GhuriError {
  /** HTTP status of the backend response, when the backend is HTTP based (S3). */
  readonly status?: number
  /** Backend error code (e.g. S3's `NoSuchBucket`). */
  readonly code?: string
  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.status = options.status
    this.code = options.code
  }
}

/** The named file does not exist in the storage (Django raises `FileNotFoundError`). */
export class FileNotFoundError extends StorageError {
  constructor(readonly fileName: string) {
    super(`File '${fileName}' does not exist.`, { status: 404, code: 'NotFound' })
  }
}

/** A file name that could escape the storage root or is otherwise unsafe (Django's `SuspiciousFileOperation`). */
export class SuspiciousFileOperation extends SuspiciousOperation {}

/** The backend can't do this (e.g. presigned URLs on an R2 binding). */
export class NotSupportedError extends StorageError {}
