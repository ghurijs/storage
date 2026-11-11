import { type Env, ImproperlyConfigured, tryGetContext } from '@ghuri/core'
import { isStorage, type Storage } from './storage'

/** Entry of the `STORAGES` setting (same `{ backend, create(env) }` shape as cache / database configs). */
export interface StorageConfig {
  backend: string
  create(env: Env): Storage
}

declare module '@ghuri/core' {
  interface GhuriSettings {
    /** Storage backends by alias (`default` is used by FileField unless `storage` is given). */
    STORAGES?: Record<string, StorageConfig | Storage>
    /** Base URL of media files (default `/media/`); used by backends without a `publicUrl` / `baseUrl`. */
    MEDIA_URL?: string
    /** Delete stored files when a model instance is deleted (default false, like Django). */
    DELETE_FILES_ON_MODEL_DELETE?: boolean
  }
}

export const DEFAULT_STORAGE_ALIAS = 'default'

const instances = new WeakMap<StorageConfig, WeakMap<object, Storage>>()
const NO_ENV = {}

function configFor(alias: string): StorageConfig | Storage {
  const ctx = tryGetContext()
  const cfg = ctx?.settings.STORAGES?.[alias]
  if (cfg) return cfg
  if (!ctx) {
    throw new ImproperlyConfigured(
      `No Ghuri context to read STORAGES from (storage alias '${alias}'). Run inside a request, ` +
        'runWithContext() or after app.setup(env).',
    )
  }
  throw new ImproperlyConfigured(
    `The storage alias '${alias}' is not configured. Add it to STORAGES, e.g. ` +
      `STORAGES: { ${alias}: r2('MEDIA') }.`,
  )
}

function instantiate(cfg: StorageConfig): Storage {
  const env = tryGetContext()?.env ?? NO_ENV
  let perEnv = instances.get(cfg)
  if (!perEnv) {
    perEnv = new WeakMap()
    instances.set(cfg, perEnv)
  }
  let storage = perEnv.get(env)
  if (!storage) {
    storage = cfg.create(env)
    perEnv.set(env, storage)
  }
  return storage
}

function isConfig(v: unknown): v is StorageConfig {
  return !!v && typeof v === 'object' && typeof (v as StorageConfig).create === 'function'
}

/** Configured storages (Django's `storages`): `storages.get('default')`. Cached per env (per isolate). */
export const storages = {
  get(alias: string = DEFAULT_STORAGE_ALIAS): Storage {
    const cfg = configFor(alias)
    if (isStorage(cfg)) return cfg
    if (!isConfig(cfg)) throw new ImproperlyConfigured(`STORAGES['${alias}'] is not a storage config.`)
    return instantiate(cfg)
  },
  /** True when `alias` is configured in the current settings. */
  has(alias: string): boolean {
    return !!tryGetContext()?.settings.STORAGES?.[alias]
  },
}

/** The `default` storage (Django's `default_storage`), resolved from the current context. */
export function defaultStorage(): Storage {
  return storages.get(DEFAULT_STORAGE_ALIAS)
}

/** Resolve a storage reference: an alias, a Storage, a config or a factory. */
export function resolveStorage(ref: string | Storage | StorageConfig | (() => Storage) | undefined): Storage {
  if (ref === undefined) return defaultStorage()
  if (typeof ref === 'string') return storages.get(ref)
  if (isStorage(ref)) return ref
  if (isConfig(ref)) return instantiate(ref)
  if (typeof ref === 'function') return ref()
  throw new ImproperlyConfigured('Invalid storage reference.')
}
