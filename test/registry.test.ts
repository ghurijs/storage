import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, ImproperlyConfigured, runWithContext } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import { fileSystemStorage } from '../src/fs'
import {
  defaultStorage,
  FileExtensionValidator,
  getValidFilename,
  MemoryStorage,
  mediaUrl,
  memoryStorage,
  NotSupportedError,
  R2Storage,
  r2,
  resolveStorage,
  SuspiciousFileOperation,
  s3,
  storages,
  upload,
  validateFileName,
} from '../src/index'
import { joinUrl, normpath, splitExt, strftime } from '../src/names'

function ctx(settings: Record<string, unknown>, env: Record<string, unknown> = {}) {
  return createContext({
    env,
    settings: { SECRET_KEY: 'x', INSTALLED_APPS: [], ROOT_URLCONF: [], ...settings } as any,
  })
}

describe('storages registry', () => {
  it('resolves aliases from STORAGES and caches per env', () => {
    let created = 0
    const cfg = {
      backend: 'custom',
      create: () => {
        created++
        return new MemoryStorage()
      },
    }
    const envA = {}
    const envB = {}
    const a1 = runWithContext(ctx({ STORAGES: { default: cfg } }, envA), () => storages.get())
    const a2 = runWithContext(ctx({ STORAGES: { default: cfg } }, envA), () => defaultStorage())
    const b = runWithContext(ctx({ STORAGES: { default: cfg } }, envB), () => storages.get('default'))
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(created).toBe(2)
    const direct = new MemoryStorage()
    expect(runWithContext(ctx({ STORAGES: { x: direct } }), () => storages.get('x'))).toBe(direct)
    expect(runWithContext(ctx({ STORAGES: { x: direct } }), () => storages.has('x'))).toBe(true)
  })

  it('explains missing configuration', () => {
    expect(() => storages.get()).toThrow(ImproperlyConfigured)
    expect(() => runWithContext(ctx({}), () => storages.get('media'))).toThrow(
      /storage alias 'media' is not configured/,
    )
  })

  it('r2() without its binding still builds URLs; I/O fails clearly', async () => {
    const settings = {
      STORAGES: { default: r2('MEDIA'), cdn: r2('MEDIA', { publicUrl: 'https://cdn.example' }) },
    }
    const [plain, cdn] = runWithContext(ctx(settings), () => [storages.get(), storages.get('cdn')])
    expect(plain).toBeInstanceOf(R2Storage)
    expect(runWithContext(ctx({ MEDIA_URL: '/files/' }), () => plain.url('a b/c.png'))).toBe(
      '/files/a%20b/c.png',
    )
    expect(plain.url('c.png')).toBe('/media/c.png')
    expect(cdn.url('avatars/me.png')).toBe('https://cdn.example/avatars/me.png')

    const missing = /R2 bucket binding 'MEDIA' was not found in env/
    await expect(plain.save('a.txt', 'x')).rejects.toThrow(ImproperlyConfigured)
    await expect(plain.save('a.txt', 'x')).rejects.toThrow(missing)
    await expect(plain.save('a.txt', 'x', { overwrite: true })).rejects.toThrow(missing)
    await expect(plain.open('a.txt')).rejects.toThrow(missing)
    await expect(plain.open('a.txt', { range: { offset: 0, length: 1 } })).rejects.toThrow(missing)
    await expect(plain.stat('a.txt')).rejects.toThrow(missing)
    await expect(plain.exists('a.txt')).rejects.toThrow(missing)
    await expect(plain.size('a.txt')).rejects.toThrow(missing)
    await expect(plain.getModifiedTime('a.txt')).rejects.toThrow(missing)
    await expect(plain.delete('a.txt')).rejects.toThrow(missing)
    await expect(plain.listdir('')).rejects.toThrow(missing)
    expect(() => (plain as R2Storage).bucket).toThrow(missing)
    await expect(plain.presignedUrl('a.txt')).rejects.toThrow(NotSupportedError)

    // a value that isn't an R2 bucket counts as missing too
    const wrong = runWithContext(ctx({ STORAGES: { default: r2('MEDIA') } }, { MEDIA: 'not-a-bucket' }), () =>
      storages.get(),
    )
    expect(wrong.url('x.png')).toBe('/media/x.png')
    await expect(wrong.exists('x.png')).rejects.toThrow(missing)
  })

  it('R2Storage constructed without a bucket builds URLs only', async () => {
    const s = new R2Storage(undefined, { publicUrl: 'https://pub-123.r2.dev/' })
    expect(s.url('a.png')).toBe('https://pub-123.r2.dev/a.png')
    await expect(s.stat('a.png')).rejects.toThrow(/R2 bucket binding was not found in env/)
  })

  it('r2() reads the binding from env', async () => {
    const fake = {
      head: async () => null,
      put: async () => null,
      get: async () => null,
      delete: async () => {},
      list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }),
    }
    const s = runWithContext(ctx({ STORAGES: { default: r2('BUCKET') } }, { BUCKET: fake }), () =>
      storages.get(),
    )
    expect(s).toBeInstanceOf(R2Storage)
    expect(s.backend).toBe('r2')
    await expect(s.presignedUrl('x')).rejects.toThrow(NotSupportedError)
    expect(runWithContext(ctx({ MEDIA_URL: 'https://cdn.example/media' }), () => s.url('a.png'))).toBe(
      'https://cdn.example/media/a.png',
    )
  })

  it('resolveStorage accepts aliases, instances, configs and factories', () => {
    const m = new MemoryStorage()
    expect(resolveStorage(m)).toBe(m)
    expect(resolveStorage(() => m)).toBe(m)
    const cfg = memoryStorage()
    expect(resolveStorage(cfg)).toBe(cfg.storage)
    expect(s3({ bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }).create({}).backend).toBe('s3')
    expect(fileSystemStorage({ location: '/tmp/x' }).create({}).backend).toBe('filesystem')
  })

  it('MEDIA_URL defaults to /media/', () => {
    expect(mediaUrl()).toBe('/media/')
    expect(runWithContext(ctx({ MEDIA_URL: '/uploads/' }), () => new MemoryStorage().url('a b/c.txt'))).toBe(
      '/uploads/a%20b/c.txt',
    )
  })

  it('memory storage rejects presigned URLs', async () => {
    await expect(new MemoryStorage().presignedUrl('a')).rejects.toThrow(/does not support presigned URLs/)
  })
})

describe('names', () => {
  it('getValidFilename', () => {
    expect(getValidFilename("john's portrait in 2004.jpg")).toBe('johns_portrait_in_2004.jpg')
    expect(getValidFilename('ছবি ১.png')).toBe('ছবি_১.png')
    expect(() => getValidFilename('???')).toThrow(SuspiciousFileOperation)
    expect(() => getValidFilename('..')).toThrow(SuspiciousFileOperation)
  })

  it('validateFileName', () => {
    expect(validateFileName('a.txt')).toBe('a.txt')
    expect(() => validateFileName('a/b.txt')).toThrow(/path elements/)
    expect(validateFileName('a/b.txt', true)).toBe('a/b.txt')
    for (const bad of ['../a', '/etc/passwd', 'a/../../b', 'C:\\x', 'a\\..\\..\\b', 'dir/', 'x\0y'])
      expect(() => validateFileName(bad, true), bad).toThrow(SuspiciousFileOperation)
  })

  it('splitExt follows Django (all suffixes)', () => {
    expect(splitExt('archive.tar.gz')).toEqual(['archive', '.tar.gz'])
    expect(splitExt('photo.jpg')).toEqual(['photo', '.jpg'])
    expect(splitExt('.env')).toEqual(['.env', ''])
    expect(splitExt('noext')).toEqual(['noext', ''])
    expect(splitExt('trailing.')).toEqual(['trailing.', ''])
  })

  it('normpath, strftime, joinUrl', () => {
    expect(normpath('a//b/./c/../d')).toBe('a/b/d')
    expect(normpath('../a')).toBe('../a')
    expect(strftime('u/%Y/%m/%d/%%', new Date('2026-03-04T05:06:07Z'))).toBe('u/2026/03/04/%')
    expect(joinUrl('https://x.test', "a/it's (1).png")).toBe('https://x.test/a/it%27s%20%281%29.png')
  })

  it('FileExtensionValidator and upload()', () => {
    const v = new FileExtensionValidator(['.PDF'])
    expect(() => v.validate('doc.pdf')).not.toThrow()
    expect(() => v.validate(new File([''], 'x.exe'))).toThrow(/“exe” is not allowed/)
    expect(() => v.validate(upload('x', 'README'))).toThrow(/“” is not allowed/)
    expect(() => upload('x', '..')).toThrow(SuspiciousFileOperation)
  })
})

describe('Workers safety', () => {
  it('the main entry does not import Node built-ins', () => {
    const src = [
      'index.ts',
      'content.ts',
      'storage.ts',
      'registry.ts',
      'fields.ts',
      'serve.ts',
      'images.ts',
      'names.ts',
      'errors.ts',
      'validators.ts',
      'backends/memory.ts',
      'backends/r2.ts',
      'backends/s3.ts',
    ]
    for (const f of src) {
      const code = readFileSync(join(import.meta.dirname, '../src', f), 'utf8')
      expect(code, f).not.toMatch(/from 'node:|from '(fs|path|os|stream)'|require\(/)
    }
  })
})
