// @ghuri/storage — Django's file storage API and FileField/ImageField for Ghuri. See ARCHITECTURE.md §8.
// Workers-safe: no Node-only imports here (the filesystem backend lives in '@ghuri/storage/fs').

export { MemoryStorage, type MemoryStorageOptions, memoryStorage } from './backends/memory'
export {
  type R2BucketLike,
  type R2HttpMetadataLike,
  type R2ObjectBodyLike,
  type R2ObjectLike,
  R2Storage,
  type R2StorageOptions,
  r2,
} from './backends/r2'
export { S3Storage, type S3StorageOptions, s3 } from './backends/s3'
export {
  type ByteRange,
  ContentFile,
  createStoredFile,
  DEFAULT_CONTENT_TYPE,
  type FileBody,
  type FileContent,
  guessContentType,
  type OpenOptions,
  resolveRange,
  type StoredFile,
  type StoredFileInfo,
} from './content'
export { FileNotFoundError, NotSupportedError, StorageError, SuspiciousFileOperation } from './errors'
export {
  FieldFile,
  type FieldFileSaveOptions,
  FileField,
  type FileFieldOptions,
  ImageField,
  ImageFieldFile,
  type ImageFieldOptions,
  INVALID_IMAGE_MESSAGE,
  isFieldFile,
  isFileField,
  type PendingFile,
  type UploadTo,
  upload,
} from './fields'
export {
  detectImageFormat,
  getImageDimensions,
  getImageInfo,
  type ImageFormat,
  type ImageInfo,
  readImageInfo,
} from './images'
export { getValidFilename, validateFileName } from './names'
export {
  DEFAULT_STORAGE_ALIAS,
  defaultStorage,
  resolveStorage,
  type StorageConfig,
  storages,
} from './registry'
export { mediaPatterns, parseRangeHeader, type ServeMediaOptions, serveMedia } from './serve'
export {
  type BackendSaveOptions,
  isStorage,
  type ListDirResult,
  mediaUrl,
  type PresignedUrlOptions,
  type SaveOptions,
  Storage,
} from './storage'
export { FileExtensionValidator, validateImageFileExtension } from './validators'
