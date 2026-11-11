import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { gzipSync, gunzipSync } from 'node:zlib'
import { rm, mkdir, mkdtemp, readFile } from 'node:fs/promises'

import { defaultChain } from '../config/index.js'
import { makeSnapshot } from '../testing/index.js'
import { SnapshotStore, decodeSnapshot } from './store.js'

test('public backup restores the exact cursor and current state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-snapshot-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await SnapshotStore.open(directory, defaultChain)
  const value = makeSnapshot()
  await store.save(value)
  value.block.number = 999
  const restored = await SnapshotStore.open(directory, defaultChain)
  assert.equal(restored.snapshot?.block.number, 100)
  const data = await readFile(join(directory, 'public-snapshot.json.gz'))
  assert.deepEqual(await decodeSnapshot(data, defaultChain), makeSnapshot())
  assert.deepEqual(JSON.parse(gunzipSync(data).toString()), restored.snapshot)
})

test('backup rejects corrupt data, foreign deployments, private fields, and mixed blocks', async () => {
  await assert.rejects(decodeSnapshot(Buffer.from('broken'), defaultChain))
  const foreign = makeSnapshot()
  foreign.chain.oreVein = `0x${'3'.repeat(40)}`
  await assert.rejects(
    decodeSnapshot(gzipSync(JSON.stringify(foreign)), defaultChain),
    /different chain or deployment/,
  )
  const secret = {
    ...makeSnapshot(),
    transactions: [{ rawTransaction: 'private' }],
  }
  await assert.rejects(
    decodeSnapshot(gzipSync(JSON.stringify(secret)), defaultChain),
  )
  const mixed = makeSnapshot()
  mixed.portfolio.blockNumber++
  await assert.rejects(
    decodeSnapshot(gzipSync(JSON.stringify(mixed)), defaultChain),
    /same block/,
  )
  const invalid = makeSnapshot()
  invalid.fund.magicOre.totalSupply = '1'
  await assert.rejects(
    decodeSnapshot(gzipSync(JSON.stringify(invalid)), defaultChain),
    /totalSupply/,
  )
  const wrongReference = makeSnapshot()
  wrongReference.fund.freeMine.magicOre = `0x${'4'.repeat(40)}`
  await assert.rejects(
    decodeSnapshot(gzipSync(JSON.stringify(wrongReference)), defaultChain),
    /references/,
  )
})

test('failed persistence cannot publish a snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-snapshot-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await SnapshotStore.open(directory, defaultChain)
  await mkdir(join(directory, 'public-snapshot.json.gz'))
  await assert.rejects(store.save(makeSnapshot()))
  assert.equal(store.snapshot, undefined)
  assert.equal(store.backup, undefined)
})
