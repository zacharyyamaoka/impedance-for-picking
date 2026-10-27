// The vendored data-ui (site/public/data-ui/, written by scripts/vendor_data_ui.py) is byte-for-byte the kit's build: every file its
// manifest lists (minus what VENDOR.json says was skipped) is there with the manifest's sha256. WHY: a copy patched in place drifts
// from the kit (data-ui docs/peps/0001 §8); this fails the deploy instead.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const DIR = join(__dirname, '..', '..', 'site', 'public', 'data-ui')

test('every vendored data-ui file matches its manifest sha256', () => {
  const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as { files: Record<string, { sha256: string }> }
  const vendor = JSON.parse(readFileSync(join(DIR, 'VENDOR.json'), 'utf8'))
  const kept = Object.keys(manifest.files).filter((name) => !name.endsWith('.map') && !name.startsWith('python/'))
  expect(kept.length).toBe(vendor.files)
  for (const name of kept) {
    const path = join(DIR, name)
    expect(existsSync(path), name).toBe(true)
    expect(createHash('sha256').update(readFileSync(path)).digest('hex'), name).toBe(manifest.files[name].sha256)
  }
})
