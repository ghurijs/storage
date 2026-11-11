// Tiny Ghuri project used by workerd.test.ts: D1 + R2 + FileField/ImageField + serveMedia, run in workerd.
import { AppConfig, createApp, defineSettings, Http404, json, path } from '@ghuri/core'
import { d1, IntegerField, Model } from '@ghuri/orm'
import type { Context } from 'hono'
import { FileField, ImageField, r2, serveMedia, storages } from '../../src/index'

export class Doc extends Model({
  file: new FileField({ uploadTo: 'docs/%Y/', blank: true }),
  image: new ImageField({ uploadTo: 'img/', widthField: 'width', heightField: 'height', blank: true }),
  width: new IntegerField({ null: true, blank: true }),
  height: new IntegerField({ null: true, blank: true }),
}) {}

class FilesConfig extends AppConfig {
  name = 'files'
  models = { Doc }
}

async function uploadView(c: Context) {
  const form = await c.req.formData()
  const doc = new Doc()
  const file = form.get('file')
  const image = form.get('image')
  if (file instanceof File) (doc as any).file = file
  if (image instanceof File) (doc as any).image = image
  try {
    await doc.save()
  } catch (e: any) {
    return json(c, { error: e.messageDict ?? e.message }, 400)
  }
  return json(
    c,
    {
      id: doc.pk,
      file: doc.file.name,
      url: doc.file.isEmpty ? null : doc.file.url,
      width: doc.width,
      height: doc.height,
    },
    201,
  )
}

async function detailView(c: Context) {
  const doc = await Doc.objects.filter({ pk: Number(c.req.param('id')) }).first()
  if (!doc) throw new Http404()
  const opened = await doc.file.open()
  return json(c, {
    name: doc.file.name,
    size: await doc.file.size(),
    text: await opened.text(),
    json: doc.toJSON(),
  })
}

async function listView(c: Context) {
  return json(c, await storages.get().listdir(c.req.query('dir') ?? ''))
}

const settings = defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  INSTALLED_APPS: [FilesConfig],
  DATABASES: { default: d1('DB') },
  STORAGES: { default: r2('MEDIA') },
  MEDIA_URL: '/media/',
  ROOT_URLCONF: [
    path('upload/', uploadView),
    path('docs/<int:id>/', detailView),
    path('ls/', listView),
    path('media/<path:name>', serveMedia()),
  ],
}))

export default createApp(settings)
