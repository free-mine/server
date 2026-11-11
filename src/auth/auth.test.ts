import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { TestContext } from 'node:test'
import { join, dirname, resolve } from 'node:path'
import { rm, mkdtemp, writeFile } from 'node:fs/promises'

import { verifyOwnerKey } from './verify.js'

async function temporaryHashFile(context: TestContext): Promise<string> {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'free-mine-auth-'))
  context.after(async () => {
    assert.equal(dirname(resolve(directory)), parent)
    await rm(directory, { recursive: true, force: true })
  })
  return join(directory, 'owner-key.sha256')
}

function hash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

test('owner key is hashed and rotation applies to the next request', async context => {
  const file = await temporaryHashFile(context)
  await writeFile(file, `${hash('first-key')}\n`)
  assert.equal(await verifyOwnerKey('Bearer first-key', file), true)
  assert.equal(await verifyOwnerKey('bearer first-key', file), true)
  assert.equal(await verifyOwnerKey('Bearer second-key', file), false)
  await writeFile(file, hash('second-key'))
  assert.equal(await verifyOwnerKey('Bearer first-key', file), false)
  assert.equal(await verifyOwnerKey('Bearer second-key', file), true)
})

test('missing or malformed hashes and malformed authorization fail closed', async context => {
  const file = await temporaryHashFile(context)
  assert.equal(await verifyOwnerKey('Bearer key', file), false)
  for (const value of ['', 'not-a-hash', '0'.repeat(63), 'g'.repeat(64)]) {
    await writeFile(file, value)
    assert.equal(await verifyOwnerKey('Bearer key', file), false)
  }
  await writeFile(file, hash('key'))
  for (const header of [
    undefined,
    '',
    'key',
    'Basic key',
    'Bearer ',
    'Bearer key key',
    'Bearer key\n',
  ]) {
    assert.equal(await verifyOwnerKey(header, file), false)
  }
})
