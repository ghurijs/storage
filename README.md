# @ghuri/storage

Django's file storage API for [Ghuri](https://github.com/ghurijs/ghuri): `Storage` backends for
**Cloudflare R2**, **S3-compatible** services (AWS S3, R2's S3 API, MinIO), the **local filesystem**
and **memory**, plus `FileField` / `ImageField` model fields and a `serveMedia()` view.

Your code talks to `storages.get()` / `FileField`, never to `env.MEDIA` directly, so moving from R2 to S3
or to a disk on a VPS is a settings change.

> Status: alpha (`0.1.0-alpha.0`). APIs may change.

```bash
npm install @ghuri/storage@next
```

- [Quick start](#quick-start)
- [Settings](#settings)
- [Backends](#backends): [R2](#cloudflare-r2-binding) · [S3 / R2 S3 API / MinIO](#s3-compatible-aws-s3-r2-s3-api-minio) · [filesystem](#filesystem-node--vps) · [memory](#memory-tests)
- [The Storage API](#the-storage-api)
- [FileField and ImageField](#filefield-and-imagefield)
- [Serving media](#serving-media)
- [Presigned URLs and direct uploads](#presigned-urls-and-direct-uploads)
- [Moving from R2 to S3 (or a disk)](#moving-from-r2-to-s3-or-a-disk)
- [Custom backends](#custom-backends)

## Quick start

```ts
// src/settings.ts
import { defineSettings, path } from '@ghuri/core'
import { d1 } from '@ghuri/orm'
import { r2, serveMedia } from '@ghuri/storage'

export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  INSTALLED_APPS: [BlogConfig],
  DATABASES: { default: d1('DB') },
  STORAGES: { default: r2('MEDIA') },          // R2 binding named MEDIA in wrangler.jsonc
  MEDIA_URL: '/media/',
  ROOT_URLCONF: urlpatterns,                   // includes path('media/<path:name>', serveMedia())
}))
```

```ts
// src/blog/models.ts
import { CharField, IntegerField, Model } from '@ghuri/orm'
import { FileField, ImageField } from '@ghuri/storage'

export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  attachment: new FileField({ uploadTo: 'attachments/%Y/%m/', blank: true }),
  cover: new ImageField({ uploadTo: 'covers/', widthField: 'coverWidth', heightField: 'coverHeight', blank: true }),
  coverWidth: new IntegerField({ null: true, blank: true }),
  coverHeight: new IntegerField({ null: true, blank: true }),
}) {}
```

```ts
// a view handling <form enctype="multipart/form-data">
import { upload } from '@ghuri/storage'

async function createPost(c: Context) {
  const form = await c.req.formData()
  const post = new Post({ title: String(form.get('title')) })
  const cover = form.get('cover')
  if (cover instanceof File) post.cover = upload(cover)   // or: (post as any).cover = cover
  await post.save()                 // uploads to R2 first, then writes the row
  return json(c, { id: post.pk, cover: post.cover.url, width: post.coverWidth })
}
```

## Settings

| Key | Default | Meaning |
|---|---|---|
| `STORAGES` | — | `{ alias: StorageConfig \| Storage }`. `default` is used by `FileField` and `defaultStorage()`. |
| `MEDIA_URL` | `'/media/'` | Base URL for backends without their own `publicUrl` / `baseUrl`. |
| `DELETE_FILES_ON_MODEL_DELETE` | `false` | Delete stored files when model instances are deleted (see [deletion](#deleting-files)). |

The keys are added to `GhuriSettings` by declaration merging, so they are type-checked once you import
`@ghuri/storage`. Each `STORAGES` entry is a config `{ backend, create(env) }` (like `CACHES`), created once
per `env` (per isolate on Workers) and cached; `storages.get(alias)` returns the instance for the current
request. A plain `Storage` instance is accepted too.

```ts
STORAGES: {
  default: r2('MEDIA', { publicUrl: 'https://media.example.com' }),
  private: s3({ endpoint: env.S3_ENDPOINT, bucket: 'private', accessKeyId: env.S3_KEY, secretAccessKey: env.S3_SECRET }),
}
```

## Backends

### Cloudflare R2 (binding)

```jsonc
// wrangler.jsonc
{
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "my-app-media" }]
}
```

```ts
import { r2 } from '@ghuri/storage'
STORAGES: { default: r2('MEDIA', { publicUrl: 'https://media.example.com', cacheControl: 'public, max-age=31536000' }) }
```

- `binding`: the binding name (or the bucket object). `url()` does no I/O and works without the binding
  (tests, scripts); `save`, `open`, `stat`, `exists`, `size`, `delete` and `listdir` raise `ImproperlyConfigured`
  when it is missing.
- `publicUrl`: a custom domain or `https://pub-<hash>.r2.dev` connected to the bucket. Without it `url()`
  uses `MEDIA_URL` and you serve files through [`serveMedia()`](#serving-media) (R2 egress is free).
- Content type, `cacheControl` and `contentDisposition` are stored as R2 `httpMetadata`; `metadata` as
  `customMetadata`. Ranges are served natively.
- **Presigned URLs are not available on bindings** (`presignedUrl()` throws `NotSupportedError`). If you need
  them, add a second storage with `s3()` pointing at R2's S3 endpoint (below) — it can address the same bucket.
- `wrangler dev` gives you a local bucket; `wrangler r2 bucket create my-app-media` creates the real one.

### S3-compatible (AWS S3, R2 S3 API, MinIO)

```ts
import { s3 } from '@ghuri/storage'

// Cloudflare R2 via its S3 API (works outside Workers too; region defaults to "auto")
s3({ endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, bucket: 'my-app-media',
     accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY })

// AWS S3 (virtual-hosted URLs; endpoint defaults to https://s3.<region>.amazonaws.com)
s3({ region: 'eu-west-1', bucket: 'my-app-media', accessKeyId: env.AWS_ACCESS_KEY_ID,
     secretAccessKey: env.AWS_SECRET_ACCESS_KEY, publicUrl: 'https://d123.cloudfront.net' })

// MinIO / any self-hosted S3 (path-style URLs)
s3({ endpoint: 'http://localhost:9000', bucket: 'media', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' })
```

Options: `endpoint`, `bucket`, `accessKeyId`, `secretAccessKey`, `sessionToken?`, `region?` (`auto` for R2
endpoints, else `us-east-1`), `publicUrl?`, `forcePathStyle?` (default: path-style except on
`amazonaws.com`), `cacheControl?`, `fetch?` (custom fetch). Requests are signed with SigV4 by
[aws4fetch](https://github.com/mhart/aws4fetch) — no AWS SDK, works on Workers and Node.

On AWS grant `s3:ListBucket` as well as `s3:GetObject`/`s3:PutObject`/`s3:DeleteObject`: without it S3
answers `403` instead of `404` for missing keys, which breaks `exists()` (used to pick free names).

Credentials are only needed for requests and `presignedUrl()`: without `accessKeyId` / `secretAccessKey` those
raise `ImproperlyConfigured`, while `url()` still works.

`url()` returns `publicUrl` + name (or `MEDIA_URL` + name); private buckets use
[`presignedUrl()`](#presigned-urls-and-direct-uploads).

### Filesystem (Node / VPS)

```ts
import { fileSystemStorage } from '@ghuri/storage/fs'   // uses node:fs: for Node; importable but not useful on Workers
STORAGES: { default: fileSystemStorage({ location: '/var/www/media', baseUrl: '/media/' }) }
```

Django's `FileSystemStorage`: files under `location` (`MEDIA_ROOT`), created with `O_EXCL` so concurrent
uploads never overwrite each other, names that escape `location` are rejected. Options: `location`,
`baseUrl?`, `filePermissions?` (0o644), `directoryPermissions?` (0o755). Content types are guessed from the
extension. Serve the directory with nginx/Caddy (`location /media/ { alias /var/www/media/; }`) or with
`serveMedia()`.

### Memory (tests)

```ts
import { memoryStorage } from '@ghuri/storage'
const media = memoryStorage()            // media.storage is the MemoryStorage (files, clear())
STORAGES: { default: media }
```

## The Storage API

```ts
import { defaultStorage, storages } from '@ghuri/storage'
const storage = storages.get()            // or storages.get('private'), defaultStorage()

const name = await storage.save('reports/q1.csv', csvString, { contentType: 'text/csv' })
// → 'reports/q1.csv', or 'reports/q1_Ab3dE9x.csv' if that name was taken
const file = await storage.open(name)     // StoredFile | null
await file?.text()                        // or .body (ReadableStream), .bytes(), .arrayBuffer(), .blob()
await storage.open(name, { range: { offset: 0, length: 1024 } })   // byte ranges (also { suffix: n })
await storage.exists(name); await storage.size(name); await storage.getModifiedTime(name)
await storage.stat(name)                  // { name, size, contentType, etag, lastModified } | null
storage.url(name)                         // public URL
await storage.listdir('reports')          // { dirs: string[], files: string[] }
await storage.delete(name)                // missing files are fine
```

| Method | Notes |
|---|---|
| `save(name \| null, content, opts?)` | `content`: `Blob \| File \| ArrayBuffer \| Uint8Array/ArrayBufferView \| ReadableStream \| string`. `name = null` uses the File's name. Returns the final name. Options: `contentType`, `maxLength`, `overwrite`, `cacheControl`, `contentDisposition`, `metadata`. |
| `open(name, { range? })` | `StoredFile` (single-use body) or `null`. `size` is the full object size, `range` the slice returned. |
| `stat(name)` | Metadata or `null`. |
| `exists` / `size` / `getModifiedTime` | `size`/`getModifiedTime` throw `FileNotFoundError`. |
| `delete(name)` | Idempotent. |
| `url(name)` | Public URL (synchronous). |
| `presignedUrl(name, opts?)` | S3 backends only; others throw `NotSupportedError`. |
| `listdir(path?)` | Immediate sub-directories and files of `path`. |
| `generateFilename(name)` | Django's `generate_filename`: cleans the base name (`My Cat?.JPG` → `My_Cat.JPG`), rejects `..`. |
| `getValidName(name)` | Django's `get_valid_filename`. |
| `getAvailableName(name, maxLength?)` | Free name: appends `_` + 7 random chars before the extension(s) on collision, truncating to `maxLength`. |

Content type resolution on save: explicit `contentType` › the Blob's `type` › guessed from the extension ›
`application/octet-stream`. `ReadableStream` content is buffered first (R2 and S3 need a known length).
Unsafe names (absolute paths, `..`, NUL bytes) raise `SuspiciousFileOperation` (a `SuspiciousOperation`, so
views answer 400).

## FileField and ImageField

```ts
new FileField({
  uploadTo: 'docs/%Y/%m/',                    // strftime tokens (UTC), or (instance, filename) => 'docs/' + instance.slug + '/' + filename
  storage: 'private',                         // alias (default 'default'), a Storage, a config or () => Storage
  maxLength: 100,                             // varchar length of the stored name (default 100)
  accept: '.pdf,application/pdf',             // admin <input accept>
  deleteWithModel: false,                     // see "Deleting files"
  validators: [new FileExtensionValidator(['pdf'])],
  blank: true, null: false,                   // usual field options
})
new ImageField({ uploadTo: 'photos/', widthField: 'width', heightField: 'height' })
```

Both store the file **name** in a `varchar(maxLength)` column (FileField extends `CharField`), so the column
is portable across D1, SQLite and Postgres, and `dumpdata`/`loaddata` move names, not bytes.

### The FieldFile value

`post.attachment` is always a `FieldFile` (also when empty — check `isEmpty`):

| Member | |
|---|---|
| `name` | Stored name (`'docs/2026/04/report.pdf'`), `null` when empty. |
| `url` | `storage.url(name)`; throws when empty. |
| `isEmpty`, `committed` | `committed` is `false` while assigned content waits to be uploaded. |
| `await size()`, `await exists()`, `await open(opts?)` | Through the storage (or the pending content). |
| `await presignedUrl(opts?)` | S3 backends. |
| `await save(name, content, { save = true })` | Django's `FieldFile.save`: applies `uploadTo` + `generateFilename`, uploads, then saves the model unless `save: false`. |
| `await delete({ save = true })` | Deletes the stored file, clears the field (and image dimensions), saves the model. |
| `toJSON()` / `String(file)` | **The stored name** (`''`/`null` when empty). |
| `storage`, `instance`, `field` | |

**Why `toJSON()` is the name, not the URL:** `model.toJSON()` feeds fixtures (`dumpdata`) and must
round-trip through `new Model(json)` and across backends; URLs depend on the request and on settings
(`MEDIA_URL`, `publicUrl`). Use `file.url` for clients (REST serializers should output the URL).

### Assigning files

```ts
post.cover = upload(file)                     // typed helper: File/Blob/bytes/stream (+ name for non-File content)
post.cover = upload(bytes, 'cover.png')
await post.save()                             // uploads pending files first (preSave), then INSERT/UPDATE

post.cover = 'covers/existing.png'            // a name already in the storage (constructor/JSON: same)
post.cover = null                             // clear (the stored file is kept)
await post.cover.save('cover.png', new ContentFile(bytes))   // Django style, saves the model too
```

At runtime you can also assign a web `File`/`Blob` directly (`post.cover = file as any`); `upload()` exists
because model attributes are typed as `FieldFile`. Uploaded file names are reduced to their base name
(`C:\fakepath\x.png` → `x.png`) and cleaned by `generateFilename`; collisions get a random suffix.

Pending files are uploaded by `instance.save()` (and `Model.objects.create()`), respecting
`save({ updateFields })`. Bulk operations (`bulkCreate`, `update()`) can't upload and raise an error for
pending files — upload with `file.save(name, content, { save: false })` first.

### ImageField

- Accepts PNG, JPEG, GIF, WebP, BMP, AVIF and HEIC, detected from **magic bytes** — the client's MIME type and
  extension are ignored, and the detected type is what gets stored as Content-Type. Anything else raises
  `ValidationError({ cover: ['Upload a valid image. …'] })` from `save()` before the row or the file is written.
- `widthField` / `heightField` are filled on upload (PNG, JPEG, GIF, WebP, BMP headers are parsed in pure
  TypeScript; AVIF/HEIC dimensions are `null`) and cleared by `delete()`.
- `ImageFieldFile` adds `width`, `height` (from those fields) and `await dimensions()` (reads the header).
- Helpers: `getImageInfo(bytes)`, `getImageDimensions(bytes)`, `readImageInfo(content)`, `detectImageFormat(bytes)`.

### Validation

`fullClean()` checks `blank`, the stored name's `maxLength` and your validators (they receive the
`FieldFile`). Bundled: `FileExtensionValidator(['pdf'])`, `validateImageFileExtension`. Image content is
validated asynchronously at upload time (see above).

### Deleting files

Like Django, deleting a model instance **keeps** its files (other rows, backups or caches may still point at
them). Opt in globally with `DELETE_FILES_ON_MODEL_DELETE: true` or per field with `deleteWithModel: true`;
files are then deleted after the transaction commits (also for cascades and `qs.delete()`). Replacing a
file does not delete the old one.

### Admin, REST, migrations

- `formHint()` → `{ widget: 'file', accept?, label, required, … }` (ImageField: `accept: 'image/*'`).
- `jsonSchema()` → `{ type: 'string', format: 'uri' }` (output); `jsonSchema('input')` →
  `{ type: 'string', format: 'binary', contentMediaType? }` for multipart uploads.
- `deconstruct()` → `{ type: 'FileField' | 'ImageField', options: { uploadTo?, storage?, maxLength? (≠ 100),
  widthField?, heightField?, … } }`; callables become `{ callable: name }`. Both classes are registered with
  `registerFieldClass`, so migrations rebuild them with `fieldFromSpec`.

## Serving media

```ts
import { path } from '@ghuri/core'
import { mediaPatterns, serveMedia } from '@ghuri/storage'

export const urlpatterns = [
  path('media/<path:name>', serveMedia()),             // default storage
  // or: ...mediaPatterns('media/'),
  path('private-media/<path:name>', serveMedia({ storage: 'private', cacheControl: 'private, max-age=60' })),
]
```

`serveMedia(opts?)` streams files from a storage (`storage`, `param` = `'name'`, `cacheControl` =
`'public, max-age=3600'`, `download`) and handles:

- `ETag` / `If-None-Match` and `Last-Modified` / `If-Modified-Since` → `304`
- single `Range` requests → `206` with `Content-Range`, unsatisfiable → `416`, `If-Range`
  (multi-range requests get the full file)
- `HEAD`, `405` for other methods, `404` for missing files and `..` traversal
- `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox` for HTML/SVG/XML so uploaded
  documents can't run script on your origin; `download: true` adds `Content-Disposition: attachment`.

On Workers this is a good way to serve a private R2 bucket (add auth by wrapping the view). With a public
bucket/CDN set `publicUrl` and skip the view. On a VPS, let nginx serve `location` directly.

## Presigned URLs and direct uploads

```ts
const storage = storages.get('private')                     // an s3() storage
await storage.presignedUrl('invoices/42.pdf', { expiresIn: 300 })                 // GET, 5 minutes
await storage.presignedUrl('invoices/42.pdf', { download: 'Invoice 42.pdf' })     // force download name
await storage.presignedUrl(`uploads/${crypto.randomUUID()}.jpg`, { method: 'PUT', expiresIn: 600 })
await post.attachment.presignedUrl({ expiresIn: 60 })
```

`expiresIn` is in seconds (1 – 604800). PUT URLs let browsers upload straight to S3/R2/MinIO (configure the
bucket's CORS); afterwards assign the key: `post.attachment = key`.

## Moving from R2 to S3 (or a disk)

The database only stores names, so moving is: copy the objects, change `STORAGES`.

1. Copy the bucket — `rclone sync r2:my-app-media s3:my-app-media` (rclone speaks both), or with Ghuri:

   ```ts
   const from = storages.get('old'), to = storages.get('default')
   async function copy(dir = '') {
     const { dirs, files } = await from.listdir(dir)
     for (const f of files) {
       const name = dir ? `${dir}/${f}` : f
       const file = (await from.open(name))!
       await to.save(name, await file.blob(), { overwrite: true, contentType: file.contentType })
     }
     for (const d of dirs) await copy(dir ? `${dir}/${d}` : d)
   }
   ```

2. Switch settings: `STORAGES: { default: s3({...}) }` (or `fileSystemStorage({...})` from
   `@ghuri/storage/fs` on Node). Keep the old one under another alias during the copy.
3. If URLs were public, point the CDN / `publicUrl` at the new bucket.

## Custom backends

Extend `Storage` and implement `_save`, `stat`, `open`, `delete`, `listdir`, `url` (and optionally
`presignedUrl`); naming, collision handling, `exists`, `size` and content normalization come from the base
class. Wrap it in a config for `STORAGES`:

```ts
class MyStorage extends Storage {
  readonly backend = 'mine'
  protected async _save(name: string, body: Uint8Array | Blob, opts: BackendSaveOptions) { /* … */ return name }
  async stat(name: string) { /* … */ }
  async open(name: string, opts?: OpenOptions) { return createStoredFile(info, stream, range) }
  async delete(name: string) {}
  async listdir(path?: string) { return { dirs: [], files: [] } }
  url(name: string) { return this.joinUrl('https://files.example.com/', name) }
}
STORAGES: { default: { backend: 'mine', create: (env) => new MyStorage(env.API_KEY) } }
```

## Errors

`StorageError` (backend failures; `status`, `code`), `FileNotFoundError`, `NotSupportedError`,
`SuspiciousFileOperation` (extends core's `SuspiciousOperation`).

## Runtime notes

- The main entry is Workers-safe (web APIs only); `@ghuri/storage/fs` needs Node.
- Workers limit request bodies (100 MB on most plans); for bigger files use presigned PUT uploads.
- Uploads are buffered in memory when the input is a stream.

## License

MIT
