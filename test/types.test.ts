// Compile-time checks (run by `tsc --noEmit`); the runtime assertions are trivial.
import { defineSettings } from '@ghuri/core'
import { CharField, Model } from '@ghuri/orm'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type FieldFile, FileField, ImageField, memoryStorage, upload } from '../src/index'

class Thing extends Model({
  name: new CharField({ maxLength: 10 }),
  doc: new FileField({ uploadTo: 'x/' }),
  optional: new FileField({ null: true, blank: true }),
  pic: new ImageField({ blank: true }),
}) {}

describe('types', () => {
  it('model attributes are FieldFiles (also with null: true)', () => {
    expectTypeOf<Thing['doc']>().toEqualTypeOf<FieldFile>()
    expectTypeOf<Thing['optional']>().toEqualTypeOf<FieldFile>()
    expectTypeOf<Thing['pic']>().toEqualTypeOf<FieldFile>()
    const t = new Thing({ name: 'a', doc: 'x/a.txt', pic: upload(new File([], 'a.png')) })
    expectTypeOf<Thing['doc']['url']>().toBeString()
    t.doc = upload('content', 'b.txt')
    expect(t.doc.name).toBe('b.txt')
  })

  it('settings keys are typed', () => {
    defineSettings(() => ({
      SECRET_KEY: 'x',
      INSTALLED_APPS: [],
      ROOT_URLCONF: [],
      STORAGES: { default: memoryStorage() },
      MEDIA_URL: '/media/',
      DELETE_FILES_ON_MODEL_DELETE: true,
    }))
    defineSettings(() => ({
      SECRET_KEY: 'x',
      INSTALLED_APPS: [],
      ROOT_URLCONF: [],
      // @ts-expect-error not a storage config
      STORAGES: { default: 42 },
    }))
  })
})
