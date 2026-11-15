import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { gzipSync, gunzipSync } from 'node:zlib'
import { rm, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'

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

test('restores a backup saved under the legacy download name', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-snapshot-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const value = makeSnapshot()
  await writeFile(
    join(directory, 'free-mine-backup.json.gz'),
    gzipSync(JSON.stringify(value)),
  )
  const restored = await SnapshotStore.open(directory, defaultChain)
  assert.deepEqual(restored.snapshot, value)
  assert.ok(restored.backup)
  assert.deepEqual(await decodeSnapshot(restored.backup, defaultChain), value)

  await restored.save(value)
  const persisted = await readFile(join(directory, 'public-snapshot.json.gz'))
  assert.deepEqual(await decodeSnapshot(persisted, defaultChain), value)
})

test('the canonical snapshot takes precedence over a legacy download', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-snapshot-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const legacy = makeSnapshot()
  await writeFile(
    join(directory, 'free-mine-backup.json.gz'),
    gzipSync(JSON.stringify(legacy)),
  )
  const canonical = makeSnapshot()
  canonical.block.number++
  canonical.portfolio.blockNumber++
  await writeFile(
    join(directory, 'public-snapshot.json.gz'),
    gzipSync(JSON.stringify(canonical)),
  )
  assert.deepEqual(
    (await SnapshotStore.open(directory, defaultChain)).snapshot,
    canonical,
  )

  await writeFile(join(directory, 'public-snapshot.json.gz'), 'broken')
  await assert.rejects(SnapshotStore.open(directory, defaultChain))
})

test('invalid legacy backups fail startup instead of starting a new replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-snapshot-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const foreign = makeSnapshot()
  foreign.chain.oreVein = `0x${'3'.repeat(40)}`
  for (const data of [
    Buffer.from('broken'),
    gzipSync(JSON.stringify(foreign)),
  ]) {
    await writeFile(join(directory, 'free-mine-backup.json.gz'), data)
    await assert.rejects(SnapshotStore.open(directory, defaultChain))
  }
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

test('invalid snapshots cannot replace published state or its backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-snapshot-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await SnapshotStore.open(directory, defaultChain)
  const previous = await store.save(makeSnapshot())
  const backup = store.backup

  const foreign = makeSnapshot()
  foreign.chain.deploymentTx = `0x${'3'.repeat(64)}`
  const mixed = makeSnapshot()
  mixed.portfolio.blockNumber++
  const invalidFund = makeSnapshot()
  invalidFund.fund.magicOre.totalSupply = '1'
  const privateFields = { ...makeSnapshot(), transactions: [] }

  for (const invalid of [foreign, mixed, invalidFund, privateFields]) {
    await assert.rejects(store.save(invalid))
    assert.deepEqual(store.snapshot, previous)
    assert.deepEqual(store.backup, backup)
    assert.deepEqual(
      (await SnapshotStore.open(directory, defaultChain)).snapshot,
      previous,
    )
  }
})
