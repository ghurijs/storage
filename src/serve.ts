// serveMedia(): stream files from a storage with conditional requests and byte ranges.
import { Http404, path, type UrlPatterns, type ViewFunction } from '@ghuri/core'
import type { Context } from 'hono'
import type { ByteRange, StoredFileInfo } from './content'
import { normpath } from './names'
import { resolveStorage, type StorageConfig } from './registry'
import type { Storage } from './storage'

export interface ServeMediaOptions {
  /** Storage alias, Storage or config (default: `'default'`). */
  storage?: string | Storage | StorageConfig
  /** Route parameter holding the file name (default `'name'`, as in `media/<path:name>`). */
  param?: string
  /** `Cache-Control` of responses (default `'public, max-age=3600'`). */
  cacheControl?: string
  /** Send `Content-Disposition: attachment` (force download). Default false. */
  download?: boolean
}

// Types a browser would execute or render as a document: sandbox them so uploads can't run script on our origin.
const ACTIVE_TYPES = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)\b/i

/** Parse a single `bytes=` range. Returns undefined to ignore the header (multi-range / malformed). */
export function parseRangeHeader(header: string | null | undefined): ByteRange | undefined {
  if (!header) return undefined
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m) return undefined
  const [, start, end] = m
  if (start === '' && end === '') return undefined
  if (start === '') return { suffix: Number(end) }
  const offset = Number(start)
  if (end === '') return { offset }
  const last = Number(end)
  if (last < offset) return undefined
  return { offset, length: last - offset + 1 }
}

function etagMatches(header: string, etag: string | undefined): boolean {
  if (!etag) return false
  if (header.trim() === '*') return true
  const strip = (t: string) => t.trim().replace(/^W\//, '')
  return header.split(',').some((t) => strip(t) === strip(etag))
}

function notModified(c: Context, info: StoredFileInfo): boolean {
  const inm = c.req.header('If-None-Match')
  if (inm !== undefined) return etagMatches(inm, info.etag)
  const ims = c.req.header('If-Modified-Since')
  if (ims && info.lastModified) {
    const since = Date.parse(ims)
    if (!Number.isNaN(since))
      return Math.floor(info.lastModified.getTime() / 1000) <= Math.floor(since / 1000)
  }
  return false
}

function baseHeaders(info: StoredFileInfo, opts: ServeMediaOptions): Headers {
  const h = new Headers()
  h.set('Content-Type', info.contentType)
  h.set('Accept-Ranges', 'bytes')
  h.set('Cache-Control', opts.cacheControl ?? 'public, max-age=3600')
  h.set('X-Content-Type-Options', 'nosniff')
  if (info.etag) h.set('ETag', info.etag)
  if (info.lastModified) h.set('Last-Modified', info.lastModified.toUTCString())
  if (ACTIVE_TYPES.test(info.contentType)) h.set('Content-Security-Policy', "default-src 'none'; sandbox")
  if (opts.download) {
    const file = info.name.split('/').pop() ?? info.name
    const ascii = file.replace(/[^\x20-\x7e]|["\\]/g, '_')
    h.set(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file)}`,
    )
  }
  return h
}

/**
 * View that streams files from a storage (Django's `django.views.static.serve` for media), with
 * `ETag`/`If-None-Match`, `Last-Modified`/`If-Modified-Since` (304), single `Range` requests (206/416) and
 * `HEAD`. Mount it under `MEDIA_URL`:
 *
 * ```ts
 * path('media/<path:name>', serveMedia())
 * ```
 */
export function serveMedia(opts: ServeMediaOptions = {}): ViewFunction {
  const param = opts.param ?? 'name'
  const view = async (c: Context): Promise<Response> => {
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    const raw = c.req.param(param)
    if (!raw) throw new Http404()
    const name = normpath(raw.replace(/\\/g, '/'))
    if (name === '.' || name.startsWith('/') || name.split('/').includes('..') || name.includes('\0'))
      throw new Http404()
    const storage = resolveStorage(opts.storage)
    const info = await storage.stat(name)
    if (!info) throw new Http404(`'${name}' could not be found.`)
    const headers = baseHeaders(info, opts)
    if (notModified(c, info)) return new Response(null, { status: 304, headers })

    let range = parseRangeHeader(c.req.header('Range'))
    const ifRange = c.req.header('If-Range')
    if (range && ifRange) {
      const ok =
        ifRange.startsWith('"') || ifRange.startsWith('W/')
          ? !!info.etag && ifRange.trim() === info.etag && !ifRange.startsWith('W/')
          : !!info.lastModified &&
            Date.parse(ifRange) >= Math.floor(info.lastModified.getTime() / 1000) * 1000
      if (!ok) range = undefined
    }
    if (range) {
      const satisfiable = 'suffix' in range ? range.suffix > 0 && info.size > 0 : range.offset < info.size
      if (!satisfiable) {
        headers.set('Content-Range', `bytes */${info.size}`)
        return new Response(null, { status: 416, headers })
      }
    }
    if (method === 'HEAD') {
      headers.set('Content-Length', String(info.size))
      return new Response(null, { status: 200, headers })
    }
    const file = await storage.open(name, range ? { range } : undefined)
    if (!file) throw new Http404(`'${name}' could not be found.`)
    if (range && file.range) {
      const { offset, length } = file.range
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${file.size}`)
      headers.set('Content-Length', String(length))
      return new Response(file.body, { status: 206, headers })
    }
    headers.set('Content-Length', String(file.size))
    return new Response(file.body, { status: 200, headers })
  }
  return view as ViewFunction
}

/**
 * URL patterns serving media at `prefix` (Django's `static(settings.MEDIA_URL, document_root=…)`):
 * `urlpatterns = [...mediaPatterns('media/'), …]`.
 */
export function mediaPatterns(prefix = 'media/', opts: ServeMediaOptions = {}): UrlPatterns {
  const route = `${prefix.replace(/^\/+/, '').replace(/\/?$/, '/')}<path:name>`
  return [path(route, serveMedia(opts), { name: 'media' })]
}
