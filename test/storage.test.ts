import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll } from 'vitest'
import { FileSystemStorage } from '../src/fs'
import { MemoryStorage, type R2BucketLike, R2Storage, S3Storage } from '../src/index'
import { storageConformance } from './helpers/conformance'
import { S3Mock } from './helpers/s3mock'

storageConformance({
  name: 'memory',
  make: () => new MemoryStorage({ baseUrl: 'https://cdn.test/m/' }),
  expectedUrl: 'https://cdn.test/m/photos/a%20b.png',
})

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

storageConformance({
  name: 'filesystem',
  make: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghuri-storage-'))
    dirs.push(dir)
    return new FileSystemStorage({ location: dir, baseUrl: '/uploads/' })
  },
  expectedUrl: '/uploads/photos/a%20b.png',
  storesContentType: false,
})

let mf: Miniflare
let bucketCount = 0
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null, { status: 204 }) } }',
    r2Buckets: Array.from({ length: 20 }, (_, i) => `B${i}`),
  })
  await mf.ready
})
afterAll(async () => {
  await mf?.dispose()
})

storageConformance({
  name: 'r2 (Miniflare binding)',
  make: async () => {
    const bucket = (await mf.getR2Bucket(`B${bucketCount++}`)) as unknown as R2BucketLike
    return new R2Storage(bucket, { publicUrl: 'https://media.example.com' })
  },
  expectedUrl: 'https://media.example.com/photos/a%20b.png',
})

storageConformance({
  name: 's3 (mock fetch, SigV4 verified)',
  make: () => {
    const creds = {
      accessKeyId: 'AKIDTEST',
      secretAccessKey: 'secret/key+1',
      region: 'us-east-1',
      bucket: 'media',
    }
    const mock = new S3Mock(creds)
    return new S3Storage({ ...creds, endpoint: 'http://minio.test:9000', fetch: mock.fetch })
  },
  expectedUrl: '/media/photos/a%20b.png',
})
