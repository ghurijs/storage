import { ValidationError } from '@ghuri/core'
import { isFieldFile } from './fields'

function fileNameOf(value: unknown): string {
  if (isFieldFile(value)) return value.name ?? ''
  if (typeof value === 'string') return value
  const n = (value as { name?: unknown } | null)?.name
  return typeof n === 'string' ? n : ''
}

/**
 * Django's `FileExtensionValidator`: `new FileExtensionValidator(['pdf', 'docx'])`. Extensions are compared
 * case-insensitively, without the dot.
 */
export class FileExtensionValidator {
  readonly code = 'invalid_extension'
  readonly allowedExtensions: string[] | null
  message = 'File extension “%(extension)s” is not allowed. Allowed extensions are: %(allowedExtensions)s.'

  constructor(allowedExtensions?: string[] | null, opts: { message?: string } = {}) {
    this.allowedExtensions = allowedExtensions
      ? allowedExtensions.map((e) => e.replace(/^\./, '').toLowerCase())
      : null
    if (opts.message) this.message = opts.message
  }

  validate(value: unknown): void {
    const name = fileNameOf(value)
    const base = name.slice(name.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
    if (this.allowedExtensions !== null && !this.allowedExtensions.includes(extension)) {
      throw new ValidationError(
        this.message
          .replace('%(extension)s', extension)
          .replace('%(allowedExtensions)s', this.allowedExtensions.join(', ')),
        { code: this.code },
      )
    }
  }

  deconstruct(): { type: string; args: unknown[] } {
    return { type: 'FileExtensionValidator', args: [this.allowedExtensions] }
  }
}

/** Django's `validate_image_file_extension`. */
export const validateImageFileExtension = new FileExtensionValidator([
  'png',
  'jpg',
  'jpeg',
  'jpe',
  'gif',
  'webp',
  'bmp',
  'avif',
  'heic',
  'heif',
])
