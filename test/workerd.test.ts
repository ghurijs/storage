// Proves @ghuri/storage (with core + orm) runs in real workerd with `nodejs_compat`: a D1 model with
// FileField/ImageField stores uploads in an R2 binding and serveMedia streams them back with ranges.
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { png } from './helpers/images'

const base = 'https://example.com'
let mf: Miniflare

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser', 'import'],
    external: ['node:*', 'cloudflare:*', 'postgres', 'better-sqlite3', '@electric-sql/pglite', 'miniflare'],
    write: false,
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

/** POST a FormData (encoded by Node, since Miniflare's fetch has its own FormData class). */
async function postForm(path: string, form: FormData) {
  const req = new Request(`${base}${path}`, { method: 'POST', body: form })
  return mf.dispatchFetch(req.url, {
    method: 'POST',
    headers: { 'content-type': req.headers.get('content-type')! },
    body: new Uint8Array(await req.arrayBuffer()),
  })
}

describe('workerd (D1 + R2 binding)', () => {
  beforeAll(async () => {
    const script = await bundle()
    mf = new Miniflare({
      modules: true,
      script,
      compatibilityDate: '2025-06-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      r2Buckets: ['MEDIA'],
      bindings: { SECRET_KEY: 'workerd-secret' },
    })
    const db = await mf.getD1Database('DB')
    await db.exec(
      'CREATE TABLE "files_doc" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "file" varchar(100) NOT NULL, "image" varchar(100) NOT NULL, "width" integer, "height" integer)',
    )
  }, 60_000)

  afterAll(async () => {
    await mf?.dispose()
  })

  it('uploads multipart files into R2 through FileField / ImageField', async () => {
    const form = new FormData()
    form.append('file', new File(['hello from workerd'], 'Hello There.txt', { type: 'text/plain' }))
    form.append('image', new File([png(40, 30)], 'pixel.png', { type: 'image/png' }))
    const res = await postForm('/upload/', form)
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    const year = new Date().getUTCFullYear()
    expect(body).toMatchObject({
      file: `docs/${year}/Hello_There.txt`,
      url: `/media/docs/${year}/Hello_There.txt`,
      width: 40,
      height: 30,
    })

    const bucket = await mf.getR2Bucket('MEDIA')
    const obj = await bucket.head(`docs/${year}/Hello_There.txt`)
    expect(obj?.httpMetadata?.contentType).toBe('text/plain')
    expect((await bucket.head('img/pixel.png'))?.httpMetadata?.contentType).toBe('image/png')

    const detail = (await (await mf.dispatchFetch(`${base}/docs/${body.id}/`)).json()) as any
    expect(detail).toMatchObject({
      name: `docs/${year}/Hello_There.txt`,
      size: 18,
      text: 'hello from workerd',
    })
    expect(detail.json).toMatchObject({
      file: `docs/${year}/Hello_There.txt`,
      image: 'img/pixel.png',
      width: 40,
    })

    const media = await mf.dispatchFetch(`${base}${body.url}`, { headers: { Range: 'bytes=11-17' } })
    expect(media.status).toBe(206)
    expect(await media.text()).toBe('workerd')
    expect(media.headers.get('content-range')).toBe('bytes 11-17/18')

    const ls = (await (await mf.dispatchFetch(`${base}/ls/?dir=docs/${year}`)).json()) as any
    expect(ls).toEqual({ dirs: [], files: ['Hello_There.txt'] })
  })

  it('rejects fake images before touching D1 or R2', async () => {
    const form = new FormData()
    form.append('image', new File(['<html>'], 'fake.png', { type: 'image/png' }))
    const res = await postForm('/upload/', form)
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toEqual({
      image: ['Upload a valid image. The file you uploaded was either not an image or a corrupted image.'],
    })
    const bucket = await mf.getR2Bucket('MEDIA')
    expect(await bucket.head('img/fake.png')).toBeNull()
  })
})
