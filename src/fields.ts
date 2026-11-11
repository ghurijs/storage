// FileField / ImageField and the FieldFile value object (Django's django.db.models.fields.files).
import { GhuriError, tryGetContext, ValidationError } from '@ghuri/core'
import {
  type BaseModel,
  CharField,
  type CharFieldOptions,
  type Dialect,
  type Field,
  type FormHint,
  type ModelClass,
  onCommit,
  postDelete,
  preSave,
  registerFieldClass,
  runValidator,
} from '@ghuri/orm'
import {
  contentName,
  createStoredFile,
  type FileContent,
  isBlob,
  isFileContent,
  isReadableStream,
  normalizeContent,
  type OpenOptions,
  resolveContentType,
  type StoredFile,
} from './content'
import { FileNotFoundError } from './errors'
import { type ImageInfo, readImageInfo } from './images'
import { basename, joinName, strftime, validateFileName } from './names'
import { resolveStorage, type StorageConfig } from './registry'
import type { PresignedUrlOptions, Storage } from './storage'

const FIELD_FILE = Symbol.for('ghuri.storage.FieldFile')
const FILE_FIELD = Symbol.for('ghuri.storage.FileField')
const FILES = Symbol.for('ghuri.storage.instanceFiles')

/** Content assigned to a file field that hasn't been uploaded yet. */
export interface PendingFile {
  content: FileContent
  contentType?: string
}

export interface FieldFileSaveOptions {
  /** Save the model instance afterwards (default true, like Django). */
  save?: boolean
  /** Content type to store (default: detected / the Blob's type / guessed from the name). */
  contentType?: string
}

function nameOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (isFieldFile(value)) return value.name
  if (typeof value === 'string') return value || null
  return null
}

/** True for FieldFile values (also across duplicate module copies). */
export function isFieldFile(v: unknown): v is FieldFile {
  return !!v && typeof v === 'object' && (v as any)[FIELD_FILE] === true
}

/** True for FileField / ImageField instances. */
export function isFileField(v: unknown): v is FileField<any> {
  return !!v && typeof v === 'object' && (v as any)[FILE_FIELD] === true
}

/**
 * The value of a `FileField` on a model instance (Django's `FieldFile`). Always present, even when the field
 * is empty (`file.isEmpty`). Holds the stored `name`; `url`, `size()`, `open()` go through the field's storage.
 *
 * Assigning a web `File`/`Blob` (or `upload(content, name)`) to the field makes it *uncommitted*: the content
 * is uploaded by `instance.save()` (before the row is written), or explicitly with `file.save(name, content)`.
 */
export class FieldFile {
  declare readonly [FIELD_FILE]: true
  /** Stored name (`avatars/me.png`), or the uploaded file's base name while uncommitted; null when empty. */
  name: string | null
  /** False while assigned content is waiting to be uploaded. */
  committed: boolean
  /** Content waiting to be uploaded (`committed === false`). */
  pending?: PendingFile

  constructor(
    public instance: BaseModel | null,
    public field: FileField<any> | null,
    name: string | null,
    pending?: PendingFile,
  ) {
    this.name = name || null
    this.pending = pending
    this.committed = !pending
  }

  /** True when no file is associated (Django: `bool(field_file)` is False). */
  get isEmpty(): boolean {
    return !this.name
  }

  /** The storage of the field. */
  get storage(): Storage {
    return this.requireField().storage
  }

  protected requireField(): FileField<any> {
    if (!this.field) throw new GhuriError('This file is not attached to a model field yet.')
    return this.field
  }

  protected requireFile(): string {
    if (!this.name) {
      throw new GhuriError(`The '${this.field?.name ?? 'file'}' attribute has no file associated with it.`)
    }
    return this.name
  }

  /** Public URL of the file (`storage.url(name)`). Throws when empty. */
  get url(): string {
    return this.storage.url(this.requireFile())
  }

  /** Signed, expiring URL (S3-compatible storages only). */
  presignedUrl(opts?: PresignedUrlOptions): Promise<string> {
    return this.storage.presignedUrl(this.requireFile(), opts)
  }

  /** Size in bytes (of the pending content while uncommitted). */
  async size(): Promise<number> {
    if (!this.committed && this.pending) return (await normalizeContent(this.pending.content)).size
    return this.storage.size(this.requireFile())
  }

  /** True when the stored file exists. */
  async exists(): Promise<boolean> {
    if (!this.name) return false
    if (!this.committed) return true
    return this.storage.exists(this.name)
  }

  /** Open the file for reading (the pending content while uncommitted). Throws `FileNotFoundError`. */
  async open(opts?: OpenOptions): Promise<StoredFile> {
    const name = this.requireFile()
    if (!this.committed && this.pending) {
      const n = await normalizeContent(this.pending.content)
      const body = n.body
      this.pending.content = body // streams are consumed by normalizeContent
      return createStoredFile(
        { name, size: n.size, contentType: resolveContentType(name, this.pending.contentType, n.type) },
        () => (body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : body).stream(),
      )
    }
    const file = await this.storage.open(name, opts)
    if (!file) throw new FileNotFoundError(name)
    return file
  }

  /**
   * Store `content` (Django's `FieldFile.save`): the name goes through the field's `uploadTo` and the storage's
   * `generateFilename` / `getAvailableName`, then the model is saved unless `{ save: false }`.
   */
  async save(name: string, content: FileContent, opts: FieldFileSaveOptions = {}): Promise<void> {
    const field = this.requireField()
    let data = content
    if (isReadableStream(data)) data = new Uint8Array(await new Response(data).arrayBuffer())
    const prepared = await field.prepareUpload(this, data)
    const generated = field.generateFilename(this.instance, name)
    this.name = await field.storage.save(generated, data, {
      maxLength: field.maxLength,
      contentType: opts.contentType ?? prepared.contentType ?? this.pending?.contentType,
    })
    this.committed = true
    this.pending = undefined
    if (this.instance) (this.instance as any)[field.attname] = this
    if (opts.save ?? true) {
      if (!this.instance) throw new GhuriError('Cannot save: this file is not attached to a model instance.')
      await this.instance.save()
    }
  }

  /** Delete the stored file, clear the field and save the model unless `{ save: false }`. */
  async delete(opts: { save?: boolean } = {}): Promise<void> {
    if (!this.name) return
    const field = this.requireField()
    if (this.committed) await field.storage.delete(this.name)
    this.name = null
    this.pending = undefined
    this.committed = true
    field.clearFile(this)
    if (this.instance) (this.instance as any)[field.attname] = this
    if ((opts.save ?? true) && this.instance) await this.instance.save()
  }

  /** Same stored name. */
  equals(other: unknown): boolean {
    return nameOf(other) === this.name
  }

  /** The stored name (`''`/null when empty) — what fixtures and `model.toJSON()` contain. Use `.url` for links. */
  toJSON(): string | null {
    return this.name ?? (this.field?.null ? null : '')
  }

  toString(): string {
    return this.name ?? ''
  }
}
Object.defineProperty(FieldFile.prototype, FIELD_FILE, { value: true })

/** FieldFile of an ImageField: adds `dimensions()` and the `width` / `height` dimension fields. */
export class ImageFieldFile extends FieldFile {
  /** Width from the model's `widthField` (null when not configured / unknown). */
  get width(): number | null {
    const f = this.field as ImageField<any> | null
    return f?.widthField && this.instance ? ((this.instance as any)[f.widthField] ?? null) : null
  }
  get height(): number | null {
    const f = this.field as ImageField<any> | null
    return f?.heightField && this.instance ? ((this.instance as any)[f.heightField] ?? null) : null
  }

  /** Read `{ width, height }` from the stored file's header (or the pending content). */
  async dimensions(): Promise<{ width: number; height: number } | null> {
    if (!this.name) return null
    let info: ImageInfo | null
    if (!this.committed && this.pending) info = await readImageInfo(this.pending.content)
    else {
      const head = await this.open({ range: { offset: 0, length: 64 * 1024 } })
      const bytes = await head.bytes()
      info = await readImageInfo(bytes)
      if (!info && head.size > bytes.byteLength) info = await readImageInfo(await (await this.open()).bytes())
    }
    return info && info.width !== null && info.height !== null
      ? { width: info.width, height: info.height }
      : null
  }
}

/** Unbound pending file for typed assignment: `post.avatar = upload(file)` / `new Post({ avatar: upload(file) })`. */
export function upload(content: FileContent, name?: string, opts: { contentType?: string } = {}): FieldFile {
  const filename = name ?? contentName(content)
  if (!filename)
    throw new TypeError('upload(): pass a name for content that has none (only File has a name).')
  const base = basename(filename)
  validateFileName(base)
  return new FieldFile(null, null, base, { content, contentType: opts.contentType })
}

// ---- fields -------------------------------------------------------------------------------------

export type UploadTo = string | ((instance: any, filename: string) => string)

export interface FileFieldOptions extends CharFieldOptions {
  /**
   * Directory (strftime tokens allowed: `'photos/%Y/%m/'`) or `(instance, filename) => name` deciding the
   * stored name. Default: storage root.
   */
  uploadTo?: UploadTo | { callable: string }
  /** Storage alias in `STORAGES` (default `'default'`), a Storage, a config, or a factory. */
  storage?: string | Storage | StorageConfig | (() => Storage)
  /** `accept` attribute for the admin's file input (`'.pdf,application/pdf'`). */
  accept?: string
  /** Delete the stored file when the instance is deleted (default: the `DELETE_FILES_ON_MODEL_DELETE` setting). */
  deleteWithModel?: boolean
}

/**
 * The construct signature FileField inherits: CharField at runtime (varchar column, `instanceof CharField`),
 * typed as `Field<FieldFile, …>`. `null` is dropped from the phantom options so model instances are typed
 * `FieldFile` even with `null: true` — the attribute is always a FieldFile (check `file.isEmpty`).
 */
const FileFieldBase = CharField as unknown as {
  new <O extends CharFieldOptions>(options?: O): Field<FieldFile, Omit<O, 'null'>> & { maxLength?: number }
  readonly internalType: string
}

const DEFAULT_MAX_LENGTH = 100

/**
 * Django's `FileField`: stores a file in a storage and its name in a `varchar(maxLength)` column (default 100).
 * The instance attribute is a `FieldFile`.
 *
 * ```ts
 * class Doc extends Model({ file: new FileField({ uploadTo: 'docs/%Y/' }) }) {}
 * const doc = new Doc({ file: upload(formFile) }); await doc.save(); doc.file.url
 * ```
 */
export class FileField<const O extends FileFieldOptions = {}> extends FileFieldBase<O> {
  static override readonly internalType: string = 'FileField'
  declare readonly [FILE_FIELD]: true

  constructor(options: O = {} as O) {
    super(options)
    this.maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
    if (this.primaryKey) throw new TypeError("FileField does not accept 'primaryKey'.")
  }

  /** The storage this field writes to (resolved per request / env). */
  get storage(): Storage {
    return resolveStorage(this.options.storage)
  }

  get uploadTo(): UploadTo {
    const u = this.options.uploadTo
    return typeof u === 'string' || typeof u === 'function' ? u : ''
  }

  /** Whether files are deleted with their instance. */
  get deleteWithModel(): boolean {
    if (this.options.deleteWithModel !== undefined) return this.options.deleteWithModel
    return tryGetContext()?.settings.DELETE_FILES_ON_MODEL_DELETE === true
  }

  /** Django's `generate_filename`: apply `uploadTo`, then the storage's `generateFilename`. */
  generateFilename(instance: BaseModel | null, filename: string): string {
    const uploadTo = this.uploadTo
    const name =
      typeof uploadTo === 'function' ? uploadTo(instance, filename) : joinName(strftime(uploadTo), filename)
    validateFileName(name, true)
    return this.storage.generateFilename(name)
  }

  /** Hook run before content is uploaded (ImageField validates and reads dimensions). */
  async prepareUpload(_file: FieldFile, _content: FileContent): Promise<{ contentType?: string }> {
    return {}
  }

  /** Hook run when the file is deleted (ImageField clears dimension fields). */
  clearFile(_file: FieldFile): void {}

  /** FieldFile class of this field. */
  protected createFile(instance: BaseModel | null, name: string | null, pending?: PendingFile): FieldFile {
    return new FieldFile(instance, this, name, pending)
  }

  /** Turn an assigned value into this instance's FieldFile. */
  wrapValue(instance: BaseModel | null, value: unknown): FieldFile {
    if (value === null || value === undefined || value === '') return this.createFile(instance, null)
    if (typeof value === 'string') return this.createFile(instance, value)
    if (isFieldFile(value)) {
      if (value.instance === instance && value.field === this) return value
      const f = this.createFile(instance, value.name, value.committed ? undefined : value.pending)
      if (!value.committed && !value.pending) f.committed = false
      return f
    }
    if (isBlob(value)) {
      const name = contentName(value) ?? 'file'
      return this.createFile(instance, basename(name), { content: value })
    }
    throw new TypeError(
      `${this}: assign a File, a Blob, a stored name (string), null, or upload(content, name) — got ${Object.prototype.toString.call(value)}.`,
    )
  }

  override contributeToClass(model: ModelClass, name: string): void {
    super.contributeToClass(model, name)
    const field = this
    const attname = this.attname
    Object.defineProperty(model.prototype, attname, {
      configurable: true,
      enumerable: false,
      get(this: BaseModel) {
        const files = filesOf(this)
        let f = files[attname]
        if (!f) {
          f = field.createFile(this, null)
          files[attname] = f
        }
        return f
      },
      set(this: BaseModel, value: unknown) {
        filesOf(this)[attname] = field.wrapValue(this, value)
      },
    })
  }

  // ---- values -------------------------------------------------------------------------------------

  override toPython(value: unknown): FieldFile {
    if (isFieldFile(value)) return value
    if (value === null || value === undefined || typeof value === 'string' || isBlob(value))
      return this.wrapValue(null, value)
    if (isFileContent(value))
      throw new ValidationError('Pass binary content with upload(content, name).', { code: 'invalid' })
    throw new ValidationError('No file was submitted. Check the encoding type on the form.', {
      code: 'invalid',
    })
  }

  override toDb(value: FieldFile | string | null | undefined, _dialect?: Dialect): unknown {
    const name = nameOf(value)
    return name ?? (this.null ? null : '')
  }

  override fromDb(value: unknown, _dialect?: Dialect): any {
    return value === null || value === undefined ? (this.null ? null : '') : String(value)
  }

  override getPrepValue(value: unknown): unknown {
    if (isFieldFile(value)) return value.name ?? ''
    return value
  }

  override valueFromObject(instance: BaseModel): unknown {
    return this.toDb((instance as any)[this.attname])
  }

  override preSave(instance: BaseModel, _add: boolean): unknown {
    const file = (instance as any)[this.attname] as FieldFile | undefined
    if (file && !file.committed) {
      throw new GhuriError(
        `${this}: the assigned file has not been uploaded. Use instance.save() (it uploads pending files) or ` +
          `await instance.${this.name}.save(name, content) before bulk operations.`,
      )
    }
    return this.toDb(file)
  }

  override validate(value: FieldFile | null | undefined, _instance?: BaseModel): void {
    if (!this.editable) return
    const file = isFieldFile(value) ? value : null
    const name = nameOf(value)
    if (!name && !(file && !file.committed)) {
      if (!this.blank) throw this.error('blank')
      return
    }
    if (name && (file?.committed ?? true) && this.maxLength !== undefined && name.length > this.maxLength) {
      throw new ValidationError(
        `Ensure this filename has at most ${this.maxLength} characters (it has ${name.length}).`,
        { code: 'max_length' },
      )
    }
    const messages: string[] = []
    for (const v of this.validators) {
      try {
        runValidator(v, value)
      } catch (e) {
        if (e instanceof ValidationError) messages.push(...e.messages)
        else throw e
      }
    }
    if (messages.length) throw new ValidationError(messages)
  }

  // ---- introspection --------------------------------------------------------------------------------

  protected override deconstructExtra(): Record<string, unknown> {
    const extra: Record<string, unknown> = {}
    if (this.maxLength !== DEFAULT_MAX_LENGTH) extra.maxLength = this.maxLength
    const u = this.options.uploadTo
    if (typeof u === 'string' && u) extra.uploadTo = u
    else if (typeof u === 'function') extra.uploadTo = { callable: u.name || 'anonymous' }
    else if (u && typeof u === 'object' && 'callable' in u) extra.uploadTo = { callable: u.callable } // historical
    if (typeof this.options.storage === 'string' && this.options.storage !== 'default')
      extra.storage = this.options.storage
    return extra
  }

  override formHint(): FormHint {
    const hint: FormHint = { widget: 'file' }
    if (this.options.accept) hint.accept = this.options.accept
    return this.withHintCommon(hint)
  }

  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'string' }
  }

  /** JSON Schema: a URL string for output (`format: 'uri'`), binary for input (multipart uploads). */
  override jsonSchema(mode: 'output' | 'input' = 'output'): Record<string, unknown> {
    const schema = super.jsonSchema()
    delete schema.default
    if (mode === 'input') {
      schema.format = 'binary'
      if (this.options.accept) schema.contentMediaType = this.options.accept
    } else {
      schema.format = 'uri'
    }
    return schema
  }
}
Object.defineProperty(FileField.prototype, FILE_FIELD, { value: true })

function filesOf(instance: BaseModel): Record<string, FieldFile> {
  let files = (instance as any)[FILES] as Record<string, FieldFile> | undefined
  if (!files) {
    files = {}
    Object.defineProperty(instance, FILES, { value: files, enumerable: false, configurable: true })
  }
  return files
}

export interface ImageFieldOptions extends FileFieldOptions {
  /** Name of an integer field updated with the image width on upload. */
  widthField?: string
  /** Name of an integer field updated with the image height on upload. */
  heightField?: string
}

export const INVALID_IMAGE_MESSAGE =
  'Upload a valid image. The file you uploaded was either not an image or a corrupted image.'

/**
 * Django's `ImageField`: a FileField that only accepts images (PNG, JPEG, GIF, WebP, BMP, AVIF, HEIC —
 * checked by magic bytes, not the client's MIME type) and can record dimensions in `widthField`/`heightField`.
 */
export class ImageField<const O extends ImageFieldOptions = {}> extends FileField<O> {
  static override readonly internalType: string = 'ImageField'

  get widthField(): string | undefined {
    return this.options.widthField
  }
  get heightField(): string | undefined {
    return this.options.heightField
  }

  protected override createFile(
    instance: BaseModel | null,
    name: string | null,
    pending?: PendingFile,
  ): FieldFile {
    return new ImageFieldFile(instance, this, name, pending)
  }

  override async prepareUpload(file: FieldFile, content: FileContent): Promise<{ contentType?: string }> {
    const info = await readImageInfo(content)
    if (!info) throw new ValidationError({ [this.name]: [INVALID_IMAGE_MESSAGE] }, { code: 'invalid_image' })
    const instance = file.instance as any
    if (instance) {
      if (this.widthField) instance[this.widthField] = info.width
      if (this.heightField) instance[this.heightField] = info.height
    }
    return { contentType: info.mimeType }
  }

  override clearFile(file: FieldFile): void {
    const instance = file.instance as any
    if (!instance) return
    if (this.widthField) instance[this.widthField] = null
    if (this.heightField) instance[this.heightField] = null
  }

  protected override deconstructExtra(): Record<string, unknown> {
    const extra = super.deconstructExtra()
    if (this.widthField) extra.widthField = this.widthField
    if (this.heightField) extra.heightField = this.heightField
    return extra
  }

  override formHint(): FormHint {
    const hint = super.formHint()
    hint.accept ??= 'image/*'
    return hint
  }

  override jsonSchema(mode: 'output' | 'input' = 'output'): Record<string, unknown> {
    const schema = super.jsonSchema(mode)
    if (mode === 'input') schema.contentMediaType ??= 'image/*'
    return schema
  }
}

registerFieldClass(FileField as any)
registerFieldClass(ImageField as any)

// ---- model lifecycle hooks ------------------------------------------------------------------------

function fileFieldsOf(instance: BaseModel): FileField<any>[] {
  const meta = (instance.constructor as ModelClass)._meta
  return meta.concreteFields.filter(isFileField) as FileField<any>[]
}

// Upload pending files before the row is written (Django's FileField.pre_save → file.save(save=False)).
preSave.connect(
  async ({ instance, updateFields }) => {
    for (const field of fileFieldsOf(instance)) {
      if (updateFields && !updateFields.includes(field.name)) continue
      const file = (instance as any)[field.attname] as FieldFile
      if (!file || file.committed) continue
      if (!file.pending || !file.name) {
        file.committed = true
        continue
      }
      await file.save(file.name, file.pending.content, { save: false, contentType: file.pending.contentType })
    }
  },
  { uid: 'ghuri.storage.uploadPendingFiles' },
)

// Optional cleanup (DELETE_FILES_ON_MODEL_DELETE / deleteWithModel), deferred until the transaction commits.
postDelete.connect(
  async ({ instance, using }) => {
    for (const field of fileFieldsOf(instance)) {
      if (!field.deleteWithModel) continue
      const file = (instance as any)[field.attname] as FieldFile
      if (!file?.name || !file.committed) continue
      const name = file.name
      const storage = field.storage
      await onCommit(
        async () => {
          try {
            await storage.delete(name)
          } catch (e) {
            console.error(`Could not delete '${name}' after deleting ${String(instance)}:`, e)
          }
        },
        { using },
      )
    }
  },
  { uid: 'ghuri.storage.deleteFilesWithModel' },
)
