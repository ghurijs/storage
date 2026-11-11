import { createContext, setGlobalContext, ValidationError } from '@ghuri/core'
import { CharField, fieldFromSpec, getFieldClass, IntegerField, Model, registerModels } from '@ghuri/orm'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ContentFile,
  FieldFile,
  FileExtensionValidator,
  FileField,
  ImageField,
  ImageFieldFile,
  INVALID_IMAGE_MESSAGE,
  MemoryStorage,
  memoryStorage,
  upload,
} from '../src/index'
import { gif, jpeg, png, webpLossy } from './helpers/images'

const media = memoryStorage()
const other = new MemoryStorage({ baseUrl: 'https://other.test/' })
const settings: Record<string, any> = {
  SECRET_KEY: 'x',
  DEBUG: true,
  INSTALLED_APPS: [],
  ROOT_URLCONF: [],
  MEDIA_URL: '/m/',
  STORAGES: { default: media, other },
}
setGlobalContext(createContext({ env: {}, settings: settings as any }))

function byTitle(instance: { title: string }, filename: string) {
  return `att/${instance.title}/${filename}`
}

class Doc extends Model({
  title: new CharField({ maxLength: 50, blank: true }),
  file: new FileField({ uploadTo: 'docs/%Y/', blank: true }),
  attachment: new FileField({ uploadTo: byTitle, storage: 'other', null: true, blank: true }),
  pdf: new FileField({ blank: true, validators: [new FileExtensionValidator(['pdf'])], maxLength: 40 }),
}) {}

class Photo extends Model({
  caption: new CharField({ maxLength: 50, blank: true }),
  image: new ImageField({ uploadTo: 'photos/', widthField: 'width', heightField: 'height' }),
  width: new IntegerField({ null: true, blank: true }),
  height: new IntegerField({ null: true, blank: true }),
}) {}

class Avatar extends Model({
  image: new ImageField({ deleteWithModel: true, blank: true }),
}) {}

registerModels('files', [Doc, Photo, Avatar])

const field = (model: { _meta: { getField(n: string): unknown } }, name: string) =>
  model._meta.getField(name) as ImageField
const store = () => media.storage.files
const text = (s: string) => new TextEncoder().encode(s)
const year = new Date().getUTCFullYear()

describe.each(['sqlite', 'pglite'] as const)('FileField / ImageField on %s', (backend) => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await setupTestDatabase({ using: backend, models: [Doc, Photo, Avatar] })
  })
  afterAll(async () => {
    await db.teardown()
  })
  beforeEach(async () => {
    await db.flush()
    media.storage.clear()
    other.clear()
    delete settings.DELETE_FILES_ON_MODEL_DELETE
  })

  it('uploads an assigned File on save, then reloads it', async () => {
    const doc = new Doc({ title: 'a' })
    expect(doc.file).toBeInstanceOf(FieldFile)
    expect(doc.file.isEmpty).toBe(true)
    doc.file = new File(['hello world'], 'Hello World!.txt', { type: 'text/plain' }) as any
    expect(doc.file.committed).toBe(false)
    expect(doc.file.name).toBe('Hello World!.txt')
    expect(await doc.file.size()).toBe(11)
    await doc.save()
    const name = `docs/${year}/Hello_World.txt`
    expect(doc.file.name).toBe(name)
    expect(doc.file.committed).toBe(true)
    expect(doc.file.url).toBe(`/m/${name}`)
    expect(store().get(name)?.contentType).toBe('text/plain')

    const loaded = await Doc.objects.get({ pk: doc.pk })
    expect(loaded.file).toBeInstanceOf(FieldFile)
    expect(loaded.file.name).toBe(name)
    expect(loaded.file.instance).toBe(loaded)
    expect(await loaded.file.size()).toBe(11)
    expect(await (await loaded.file.open()).text()).toBe('hello world')
    expect(await loaded.file.exists()).toBe(true)
    expect(loaded.attachment.isEmpty).toBe(true)

    expect(await Doc.objects.filter({ file: name }).count()).toBe(1)
    expect(await Doc.objects.filter({ file: loaded.file }).count()).toBe(1)
    expect(await Doc.objects.valuesList('file', { flat: true })).toEqual([name])
    const raw = await db.connection.execute('SELECT file, attachment FROM files_doc')
    expect(raw.rows[0]).toEqual({ file: name, attachment: null })
  })

  it('serializes to the stored name', async () => {
    const doc = await Doc.objects.create({ title: 'j', file: upload('x', 'j.txt') })
    expect(JSON.parse(JSON.stringify(doc.toJSON()))).toMatchObject({
      file: `docs/${year}/j.txt`,
      attachment: null,
      pdf: '',
    })
    expect(JSON.parse(JSON.stringify(doc)).file).toBe(`docs/${year}/j.txt`)
    expect(String(doc.file)).toBe(`docs/${year}/j.txt`)
    const copy = new Doc(JSON.parse(JSON.stringify(doc)))
    expect(copy.file.name).toBe(doc.file.name)
    expect(copy.file.committed).toBe(true)
  })

  it('gives colliding uploads unique names', async () => {
    const a = await Doc.objects.create({ file: upload(text('1'), 'same.txt') })
    const b = await Doc.objects.create({ file: upload(text('2'), 'same.txt') })
    expect(a.file.name).toBe(`docs/${year}/same.txt`)
    expect(b.file.name).toMatch(new RegExp(`^docs/${year}/same_[A-Za-z0-9]{7}\\.txt$`))
    expect(await (await a.file.open()).text()).toBe('1')
    expect(await (await b.file.open()).text()).toBe('2')
  })

  it('supports callable uploadTo and storage aliases', async () => {
    const doc = new Doc({ title: 'team', attachment: upload(new Blob(['z']), 'notes.md') })
    await doc.save()
    expect(doc.attachment.name).toBe('att/team/notes.md')
    expect(doc.attachment.url).toBe('https://other.test/att/team/notes.md')
    expect(other.files.has('att/team/notes.md')).toBe(true)
    expect(store().size).toBe(0)
  })

  it('FieldFile.save() / delete() like Django', async () => {
    const doc = await Doc.objects.create({ title: 'x' })
    await doc.file.save('report.txt', new ContentFile('v1'))
    const reloaded = await Doc.objects.get({ pk: doc.pk })
    expect(reloaded.file.name).toBe(`docs/${year}/report.txt`)

    await reloaded.file.save('draft.txt', 'v2', { save: false })
    expect((await Doc.objects.get({ pk: doc.pk })).file.name).toBe(`docs/${year}/report.txt`)
    await reloaded.save()
    expect((await Doc.objects.get({ pk: doc.pk })).file.name).toBe(`docs/${year}/draft.txt`)

    await reloaded.file.delete()
    expect(reloaded.file.isEmpty).toBe(true)
    expect(store().has(`docs/${year}/draft.txt`)).toBe(false)
    expect((await Doc.objects.get({ pk: doc.pk })).file.name).toBeNull()
    expect(() => reloaded.file.url).toThrow(/has no file associated/)
  })

  it('accepts names, nulls and FieldFiles from other instances', async () => {
    await media.storage.save('existing/a.txt', 'a')
    const doc = new Doc({ file: 'existing/a.txt' })
    await doc.save()
    expect(doc.file.url).toBe('/m/existing/a.txt')
    const other = new Doc()
    other.file = doc.file
    expect(other.file).not.toBe(doc.file)
    expect(other.file.instance).toBe(other)
    expect(other.file.name).toBe('existing/a.txt')
    other.file = null as any
    expect(other.file.isEmpty).toBe(true)
    expect(() => {
      ;(other as any).file = 42
    }).toThrow(TypeError)
    await doc.refreshFromDb()
    expect(doc.file.name).toBe('existing/a.txt')
    expect(doc.file.instance).toBe(doc)
  })

  it('validates in fullClean (blank, extension, max length)', async () => {
    const photo = new Photo()
    await expect(photo.fullClean()).rejects.toMatchObject({
      messageDict: { image: ['This field cannot be blank.'] },
    })
    const doc = new Doc({ pdf: upload('x', 'notes.txt') })
    const err = await doc.fullClean().catch((e) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.messageDict.pdf[0]).toMatch(/File extension “txt” is not allowed/)
    const long = new Doc({ pdf: `${'x'.repeat(50)}.pdf` })
    await expect(long.fullClean()).rejects.toMatchObject({
      messageDict: { pdf: ['Ensure this filename has at most 40 characters (it has 54).'] },
    })
    const ok = new Doc({ pdf: upload('%PDF', 'Quarterly Report.pdf') })
    await ok.fullClean()
    expect(ok.pdf).toBeInstanceOf(FieldFile)
    await ok.save()
    expect(ok.pdf.name).toBe('Quarterly_Report.pdf')
  })

  it('truncates generated names to maxLength', async () => {
    await Doc.objects.create({ pdf: upload('1', `${'n'.repeat(36)}.pdf`) })
    const second = await Doc.objects.create({ pdf: upload('2', `${'n'.repeat(36)}.pdf`) })
    expect(second.pdf.name!.length).toBeLessThanOrEqual(40)
  })

  it('ImageField validates images and records dimensions', async () => {
    const photo = new Photo({ caption: 'p' })
    photo.image = new File([png(320, 240) as Uint8Array<ArrayBuffer>], 'shot.png') as any
    await photo.save()
    expect(photo.image).toBeInstanceOf(ImageFieldFile)
    expect(photo.width).toBe(320)
    expect(photo.height).toBe(240)
    expect(photo.image.name).toBe('photos/shot.png')
    const loaded = await Photo.objects.get({ pk: photo.pk })
    expect([loaded.width, loaded.height]).toEqual([320, 240])
    expect((loaded.image as ImageFieldFile).width).toBe(320)
    expect(await (loaded.image as ImageFieldFile).dimensions()).toEqual({ width: 320, height: 240 })

    for (const [bytes, w, h, type] of [
      [jpeg(100, 50), 100, 50, 'image/jpeg'],
      [gif(7, 8), 7, 8, 'image/gif'],
      [webpLossy(64, 32), 64, 32, 'image/webp'],
    ] as const) {
      // client-sent MIME type / extension are not trusted: the stored type comes from the magic bytes
      const p = await Photo.objects.create({
        image: upload(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'text/html' }), 'upload.bin'),
      })
      expect([p.width, p.height]).toEqual([w, h])
      expect(store().get(p.image.name!)?.contentType).toBe(type)
    }
  })

  it('ImageField rejects non-images without writing the row or the file', async () => {
    const photo = new Photo({ image: upload('<script>alert(1)</script>', 'evil.png') })
    const err = await photo.save().catch((e) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.messageDict).toEqual({ image: [INVALID_IMAGE_MESSAGE] })
    expect(photo.pk).toBeNull()
    expect(await Photo.objects.count()).toBe(0)
    expect(store().size).toBe(0)
  })

  it('ImageField delete clears dimensions', async () => {
    const photo = await Photo.objects.create({ image: upload(png(2, 3), 'a.png') })
    await photo.image.delete()
    const loaded = await Photo.objects.get({ pk: photo.pk })
    expect([loaded.width, loaded.height, loaded.image.name]).toEqual([null, null, null])
  })

  it('keeps files on model delete by default; deletes them when configured', async () => {
    const doc = await Doc.objects.create({ file: upload('keep', 'keep.txt') })
    await doc.delete()
    expect(store().has(`docs/${year}/keep.txt`)).toBe(true)

    settings.DELETE_FILES_ON_MODEL_DELETE = true
    const gone = await Doc.objects.create({ file: upload('gone', 'gone.txt') })
    await Doc.objects.filter({ pk: gone.pk }).delete()
    expect(store().has(`docs/${year}/gone.txt`)).toBe(false)
    delete settings.DELETE_FILES_ON_MODEL_DELETE

    const avatar = await Avatar.objects.create({ image: upload(gif(1, 1), 'me.gif') })
    expect(store().has('me.gif')).toBe(true)
    await avatar.delete()
    expect(store().has('me.gif')).toBe(false)
  })

  it('does not upload when the field is excluded from updateFields; refuses bulk writes of pending files', async () => {
    const doc = await Doc.objects.create({ title: 'u' })
    doc.title = 'v'
    doc.file = upload('later', 'later.txt')
    await doc.save({ updateFields: ['title'] })
    expect(doc.file.committed).toBe(false)
    expect(store().size).toBe(0)
    await expect(Doc.objects.bulkCreate([new Doc({ file: upload('b', 'b.txt') })])).rejects.toThrow(
      /has not been uploaded/,
    )
  })
})

describe('FileField schema & introspection', () => {
  it('maps to varchar(maxLength) on both dialects', () => {
    const f = field(Doc, 'file') as FileField
    expect(f.maxLength).toBe(100)
    expect(f.dbType('sqlite')).toBe('varchar(100)')
    expect(f.dbType('postgresql')).toBe('varchar(100)')
    expect((field(Doc, 'pdf') as FileField).dbType('postgresql')).toBe('varchar(40)')
    expect(field(Photo, 'image').dbType('sqlite')).toBe('varchar(100)')
    expect(f.internalType).toBe('FileField')
    expect(f).toBeInstanceOf(CharField)
  })

  it('deconstructs to JSON for migrations and rebuilds with fieldFromSpec', () => {
    expect(field(Doc, 'file').deconstruct()).toEqual({
      type: 'FileField',
      options: { blank: true, uploadTo: 'docs/%Y/' },
    })
    expect(field(Doc, 'attachment').deconstruct()).toEqual({
      type: 'FileField',
      options: { null: true, blank: true, uploadTo: { callable: 'byTitle' }, storage: 'other' },
    })
    const pdf = field(Doc, 'pdf').deconstruct()
    expect(pdf.options).toMatchObject({
      maxLength: 40,
      validators: [{ type: 'FileExtensionValidator', args: [['pdf']] }],
    })
    const img = field(Photo, 'image').deconstruct()
    expect(img).toEqual({
      type: 'ImageField',
      options: { uploadTo: 'photos/', widthField: 'width', heightField: 'height' },
    })
    expect(JSON.parse(JSON.stringify(img))).toEqual(img)
    expect(getFieldClass('FileField')).toBe(FileField)
    expect(getFieldClass('ImageField')).toBe(ImageField)
    const rebuilt = fieldFromSpec({ ...field(Doc, 'attachment').deconstruct() })
    expect(rebuilt).toBeInstanceOf(FileField)
    expect(rebuilt.null).toBe(true)
    expect(rebuilt.dbType('sqlite')).toBe('varchar(100)')
    const rebuiltImg = fieldFromSpec({ type: 'ImageField', maxLength: 255, widthField: 'w' }) as ImageField
    expect(rebuiltImg.widthField).toBe('w')
    expect(rebuiltImg.dbType('postgresql')).toBe('varchar(255)')
  })

  it('formHint and jsonSchema', () => {
    expect(field(Doc, 'file').formHint()).toMatchObject({ widget: 'file', required: false, label: 'File' })
    expect(field(Photo, 'image').formHint()).toMatchObject({
      widget: 'file',
      accept: 'image/*',
      required: true,
    })
    const f = field(Doc, 'attachment') as FileField
    expect(f.jsonSchema()).toMatchObject({ type: ['string', 'null'], format: 'uri', title: 'Attachment' })
    expect(f.jsonSchema('input')).toMatchObject({ format: 'binary' })
    expect((field(Photo, 'image') as ImageField).jsonSchema('input')).toMatchObject({
      type: 'string',
      format: 'binary',
      contentMediaType: 'image/*',
    })
  })

  it('toPython coerces form input', () => {
    const f = field(Doc, 'file') as FileField
    expect(f.toPython('a/b.txt').name).toBe('a/b.txt')
    const pending = f.toPython(new File(['x'], 'C:\\fakepath\\up.txt'))
    expect(pending.name).toBe('up.txt')
    expect(pending.committed).toBe(false)
    expect(() => f.toPython(42)).toThrow(ValidationError)
    expect(() => upload(new Uint8Array([1]))).toThrow(TypeError)
  })
})
