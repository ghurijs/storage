# Changelog

## 0.1.0-alpha.1

- `r2()` no longer needs its bucket binding to build URLs: a missing (or invalid) binding is reported by the
  I/O methods (`save`, `open`, `stat`, `exists`, `size`, `getModifiedTime`, `delete`, `listdir`) with the same
  `ImproperlyConfigured` message, not when the storage is created, so `url()` and `FieldFile.url` work in tests
  without a stubbed `MEDIA` binding. `R2Storage`'s constructor accepts a missing bucket and `bucket` is now a
  getter that throws when it is absent.
- `s3()` creates its SigV4 client on first use: `url()` works without `accessKeyId` / `secretAccessKey`; requests
  and `presignedUrl()` throw `ImproperlyConfigured` naming the missing option (before, aws4fetch threw a
  `TypeError` as soon as the storage was created).

## 0.1.0-alpha.0

- `Storage` base class (Django's storage API): `save` (Blob, File, ArrayBuffer, typed arrays, ReadableStream,
  string), `open` with byte ranges, `stat`, `exists`, `size`, `getModifiedTime`, `delete`, `listdir`, `url`,
  `presignedUrl`, `generateFilename`, `getValidName`, `getAvailableName` (random 7-char suffix, `maxLength`
  truncation), `SuspiciousFileOperation` on path traversal.
- Backends: `r2(binding)` (Workers R2 binding), `s3({...})` (SigV4 via aws4fetch; AWS S3, R2 S3 API, MinIO;
  presigned GET/PUT URLs), `memoryStorage()`, `fileSystemStorage()` from `@ghuri/storage/fs` (Node).
- Settings `STORAGES`, `MEDIA_URL`, `DELETE_FILES_ON_MODEL_DELETE`; `storages.get(alias)` cached per env,
  `defaultStorage()`, `resolveStorage()`.
- `FileField` / `ImageField` (varchar name column, `uploadTo` with strftime tokens or a callable, storage
  alias), `FieldFile` / `ImageFieldFile` values, `upload()` / `ContentFile` helpers, pending uploads committed
  on `model.save()`, image validation by magic bytes with `widthField` / `heightField`, optional file cleanup
  on delete, `formHint()`, `jsonSchema()`, `deconstruct()` + `registerFieldClass` for migrations.
- Pure-TS image header parsing (PNG, JPEG, GIF, WebP, BMP; AVIF/HEIC detection).
- `FileExtensionValidator`, `validateImageFileExtension`.
- `serveMedia()` view and `mediaPatterns()`: ETag / Last-Modified (304), single Range (206/416), HEAD,
  nosniff and sandbox CSP for active content.
