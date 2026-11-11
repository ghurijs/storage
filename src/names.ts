// File name helpers (Django's django.utils.text.get_valid_filename, validate_file_name, posixpath bits).
import { SuspiciousFileOperation } from './errors'

/** POSIX `normpath` for storage names: collapses `//`, `.` and `x/..`; keeps a leading `/` or `..`. */
export function normpath(p: string): string {
  if (!p) return '.'
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined || '.'
}

/** `[dirname, basename]` of a `/`-separated name. */
export function splitName(name: string): [string, string] {
  const i = name.lastIndexOf('/')
  return i === -1 ? ['', name] : [name.slice(0, i), name.slice(i + 1)]
}

export function joinName(dir: string, file: string): string {
  if (!dir) return file
  return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`
}

/** Base name of an uploaded file name (browsers may send `C:\fakepath\x.png`). */
export function basename(name: string): string {
  return splitName(name.replace(/\\/g, '/'))[1]
}

/**
 * Split a base name into root and extension the way Django does (all suffixes, like `pathlib`):
 * `archive.tar.gz` → `['archive', '.tar.gz']`, `.env` → `['.env', '']`.
 */
export function splitExt(fileName: string): [string, string] {
  if (!fileName || fileName.endsWith('.')) return [fileName, '']
  const lead = fileName.match(/^\.+/)?.[0] ?? ''
  const rest = fileName.slice(lead.length)
  const dot = rest.indexOf('.')
  if (dot <= 0) return [fileName, '']
  const ext = rest.slice(dot)
  if (ext.split('.').some((s, i) => i > 0 && s === '')) {
    // `a..b` → Python's suffixes ignore empty parts; fall back to the last suffix
    const last = rest.lastIndexOf('.')
    return [lead + rest.slice(0, last), rest.slice(last)]
  }
  return [lead + rest.slice(0, dot), ext]
}

/**
 * Django's `get_valid_filename`: strip, spaces → `_`, drop everything but letters, digits, `-`, `_`, `.`.
 * `"john's portrait in 2004.jpg"` → `johns_portrait_in_2004.jpg`.
 */
export function getValidFilename(name: string): string {
  const s = String(name)
    .trim()
    .replace(/ /g, '_')
    .replace(/[^-\p{L}\p{M}\p{N}_.]/gu, '')
  if (s === '' || s === '.' || s === '..')
    throw new SuspiciousFileOperation(`Could not derive file name from '${name}'.`)
  return s
}

/**
 * Django's `validate_file_name`: reject empty / `.` / `..` base names; with `allowRelativePath`, reject
 * absolute paths and `..` components, otherwise reject any directory component. Returns the name.
 */
export function validateFileName(name: string, allowRelativePath = false): string {
  if (name.includes('\0')) throw new SuspiciousFileOperation(`File name '${name}' contains a NUL byte.`)
  const normalized = name.replace(/\\/g, '/')
  const base = splitName(normalized)[1]
  if (base === '' || base === '.' || base === '..')
    throw new SuspiciousFileOperation(`Could not derive file name from '${name}'.`)
  if (allowRelativePath) {
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..'))
      throw new SuspiciousFileOperation(`Detected path traversal attempt in '${name}'.`)
  } else if (normalized !== base) {
    throw new SuspiciousFileOperation(`File name '${name}' includes path elements.`)
  }
  return name
}

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** Random `[a-zA-Z0-9]{length}` string (Django's `get_random_string`). */
export function randomString(length = 7): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let s = ''
  for (const b of bytes) s += ALPHANUM[b % ALPHANUM.length]
  return s
}

/** Expand strftime-style tokens in `uploadTo` (`'photos/%Y/%m/%d/'`), in UTC. */
export function strftime(format: string, date: Date = new Date()): string {
  if (!format.includes('%')) return format
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000) + 1
  const map: Record<string, string> = {
    Y: String(date.getUTCFullYear()),
    y: pad(date.getUTCFullYear() % 100),
    m: pad(date.getUTCMonth() + 1),
    d: pad(date.getUTCDate()),
    H: pad(date.getUTCHours()),
    M: pad(date.getUTCMinutes()),
    S: pad(date.getUTCSeconds()),
    j: pad(dayOfYear, 3),
    s: String(Math.floor(date.getTime() / 1000)),
    '%': '%',
  }
  return format.replace(/%([YymdHMSjs%])/g, (_, k: string) => map[k])
}

/** Percent-encode a storage name for URLs, keeping `/` separators (Django's `filepath_to_uri`). */
export function encodeName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .map((s) =>
      encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join('/')
}

/** Join a base URL and a storage name: `('/media/', 'a b.png')` → `/media/a%20b.png`. */
export function joinUrl(base: string, name: string): string {
  const b = base.endsWith('/') ? base : `${base}/`
  return b + encodeName(name.replace(/^\/+/, ''))
}
