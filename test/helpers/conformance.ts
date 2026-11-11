// Shared Storage conformance tests, run against every backend.
import { describe, expect, it } from 'vitest'
import { ContentFile, FileNotFoundError, type Storage, SuspiciousFileOperation } from '../../src/index'

export interface ConformanceTarget {
  name: string
  /** Fresh, empty storage. */
  make: () => Promise<Storage> | Storage
  /** URL expected for `photos/a b.png`. */
  expectedUrl?: string
  /** Backend stores content types (fs guesses them from the extension). */
  storesContentType?: boolean
}

const enc = (s: string) => new TextEncoder().encode(s)

export function storageConformance(target: ConformanceTarget): void {
  describe(`Storage conformance: ${target.name}`, () => {
    it('saves and reads back every content type', async () => {
      const s = await target.make()
      const inputs: Array<[string, any, string]> = [
        ['a/string.txt', 'hello string', 'hello string'],
        ['a/bytes.bin', enc('hello bytes'), 'hello bytes'],
        ['a/buffer.bin', enc('hello buffer').buffer, 'hello buffer'],
        ['a/blob.txt', new Blob(['hello blob']), 'hello blob'],
        ['a/file.txt', new File(['hello file'], 'ignored.txt'), 'hello file'],
        [
          'a/stream.txt',
          new ReadableStream({
            start(c) {
              c.enqueue(enc('hello '))
              c.enqueue(enc('stream'))
              c.close()
            },
          }),
          'hello stream',
        ],
        ['a/view.bin', new DataView(enc('xxhello viewxx').buffer, 2, 10), 'hello view'],
      ]
      for (const [name, content, text] of inputs) {
        expect(await s.save(name, content)).toBe(name)
        const f = await s.open(name)
        expect(f).not.toBeNull()
        expect(await f!.text()).toBe(text)
        expect(f!.size).toBe(enc(text).byteLength)
        expect(await s.size(name)).toBe(enc(text).byteLength)
        expect(await s.exists(name)).toBe(true)
      }
    })

    it('uses the File name when no name is given', async () => {
      const s = await target.make()
      expect(await s.save(null, new ContentFile('x', 'named.txt'))).toBe('named.txt')
      await expect(s.save(null, 'no name')).rejects.toThrow(TypeError)
    })

    it('adds a random suffix instead of overwriting (Django get_available_name)', async () => {
      const s = await target.make()
      const first = await s.save('dir/report.tar.gz', 'one')
      const second = await s.save('dir/report.tar.gz', 'two')
      expect(first).toBe('dir/report.tar.gz')
      expect(second).toMatch(/^dir\/report_[a-zA-Z0-9]{7}\.tar\.gz$/)
      expect(await (await s.open(first))!.text()).toBe('one')
      expect(await (await s.open(second))!.text()).toBe('two')
      const third = await s.save('dir/report.tar.gz', 'three', { overwrite: true })
      expect(third).toBe('dir/report.tar.gz')
      expect(await (await s.open(first))!.text()).toBe('three')
    })

    it('truncates names to maxLength', async () => {
      const s = await target.make()
      const long = `${'x'.repeat(40)}.txt`
      await s.save(long, '1')
      const name = await s.save(long, '2', { maxLength: 30 })
      expect(name.length).toBeLessThanOrEqual(30)
      expect(name).toMatch(/^x+_[a-zA-Z0-9]{7}\.txt$/)
      await expect(s.save('.txt', '3', { maxLength: 3 })).rejects.toThrow(SuspiciousFileOperation)
    })

    it('rejects path traversal', async () => {
      const s = await target.make()
      await expect(s.save('../evil.txt', 'x')).rejects.toThrow(SuspiciousFileOperation)
      await expect(s.save('/abs/evil.txt', 'x')).rejects.toThrow(SuspiciousFileOperation)
      await expect(s.save('a/../../evil.txt', 'x')).rejects.toThrow(SuspiciousFileOperation)
      expect(() => s.generateFilename('../x.txt')).toThrow(SuspiciousFileOperation)
      await expect(s.listdir('../')).rejects.toThrow(SuspiciousFileOperation)
    })

    it('stat / content type / etag / modified time', async () => {
      const s = await target.make()
      await s.save('img/pic.png', new Uint8Array([1, 2, 3]))
      const info = await s.stat('img/pic.png')
      expect(info).toMatchObject({ name: 'img/pic.png', size: 3, contentType: 'image/png' })
      expect(info!.etag).toMatch(/^"[^"]+"$/)
      expect(await s.getModifiedTime('img/pic.png')).toBeInstanceOf(Date)
      expect(await s.stat('missing.png')).toBeNull()
      await expect(s.size('missing.png')).rejects.toThrow(FileNotFoundError)
      if (target.storesContentType !== false) {
        await s.save('data.bin', 'x', { contentType: 'application/x-custom' })
        expect((await s.stat('data.bin'))!.contentType).toBe('application/x-custom')
        await s.save('typed', new Blob(['x'], { type: 'text/csv' }))
        expect((await s.stat('typed'))!.contentType).toBe('text/csv')
      }
      await s.save('unknown', 'x')
      expect((await s.stat('unknown'))!.contentType).toBe('application/octet-stream')
    })

    it('opens byte ranges', async () => {
      const s = await target.make()
      await s.save('r.txt', '0123456789')
      const a = (await s.open('r.txt', { range: { offset: 2, length: 3 } }))!
      expect(a.range).toEqual({ offset: 2, length: 3 })
      expect(a.size).toBe(10)
      expect(await a.text()).toBe('234')
      const b = (await s.open('r.txt', { range: { offset: 7 } }))!
      expect(b.range).toEqual({ offset: 7, length: 3 })
      expect(await b.text()).toBe('789')
      const c = (await s.open('r.txt', { range: { suffix: 4 } }))!
      expect(c.range).toEqual({ offset: 6, length: 4 })
      expect(await c.text()).toBe('6789')
      const d = (await s.open('r.txt', { range: { offset: 8, length: 100 } }))!
      expect(await d.text()).toBe('89')
      expect(await s.open('missing.txt', { range: { offset: 0 } })).toBeNull()
    })

    it('reads bodies as stream / bytes / blob once', async () => {
      const s = await target.make()
      await s.save('b.txt', 'body')
      const f = (await s.open('b.txt'))!
      expect(f.bodyUsed).toBe(false)
      expect(new TextDecoder().decode(await f.bytes())).toBe('body')
      expect(f.bodyUsed).toBe(true)
      await expect(f.text()).rejects.toThrow(TypeError)
      const g = (await s.open('b.txt'))!
      const blob = await g.blob()
      expect(await blob.text()).toBe('body')
      const h = (await s.open('b.txt'))!
      expect(await new Response(h.body).text()).toBe('body')
    })

    it('deletes (missing files are fine)', async () => {
      const s = await target.make()
      await s.save('d/x.txt', 'x')
      await s.delete('d/x.txt')
      expect(await s.exists('d/x.txt')).toBe(false)
      expect(await s.open('d/x.txt')).toBeNull()
      await s.delete('d/x.txt')
    })

    it('lists directories', async () => {
      const s = await target.make()
      for (const n of ['top.txt', 'a/1.txt', 'a/2.txt', 'a/b/3.txt', 'a/c/4.txt', 'z/5.txt'])
        await s.save(n, n)
      expect(await s.listdir('')).toEqual({ dirs: ['a', 'z'], files: ['top.txt'] })
      expect(await s.listdir('a')).toEqual({ dirs: ['b', 'c'], files: ['1.txt', '2.txt'] })
      expect(await s.listdir('a/')).toEqual({ dirs: ['b', 'c'], files: ['1.txt', '2.txt'] })
      expect(await s.listdir('a/b')).toEqual({ dirs: [], files: ['3.txt'] })
      expect(await s.listdir('nope')).toEqual({ dirs: [], files: [] })
    })

    it('handles unicode and special characters in names', async () => {
      const s = await target.make()
      const name = 'ফাইল/ছবি (1) & co+x.txt'
      expect(await s.save(name, 'unicode')).toBe(name)
      expect(await (await s.open(name))!.text()).toBe('unicode')
      expect((await s.listdir('ফাইল')).files).toEqual(['ছবি (1) & co+x.txt'])
    })

    it('builds URLs and filenames', async () => {
      const s = await target.make()
      if (target.expectedUrl) expect(s.url('photos/a b.png')).toBe(target.expectedUrl)
      expect(s.generateFilename('photos/My Cat?.JPG')).toBe('photos/My_Cat.JPG')
      expect(s.getValidName("john's portrait in 2004.jpg")).toBe('johns_portrait_in_2004.jpg')
      expect(await s.getAvailableName('free.txt')).toBe('free.txt')
    })
  })
}
