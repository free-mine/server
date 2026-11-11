import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { rm, mkdtemp } from 'node:fs/promises'

import type { Provider } from 'ethers'

import { SyncService } from './service.js'
import { defaultChain } from '../config/index.js'
import { SnapshotStore } from '../snapshot/index.js'
import { makeConfig, makeSnapshot } from '../testing/index.js'

function providerAt(number: number) {
  const saved = makeSnapshot().block
  const target = {
    number,
    hash: `0x${'b'.repeat(64)}`,
    timestamp: saved.timestamp + 5,
  }
  return {
    getNetwork: async () => ({ chainId: 43114n }),
    getBlock: async (tag: string | number) =>
      tag === saved.number ? saved : target,
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 50 }),
  }
}

test('resume starts after saved block and overlapping refreshes share one atomic commit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-sync-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const snapshots = await SnapshotStore.open(directory, defaultChain)
  await snapshots.save(makeSnapshot())
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let reads = 0
  const service = new SyncService({
    config: makeConfig(directory),
    snapshots,
    provider: providerAt(105) as unknown as Provider,
    readFund: async (_provider, _config, previous, from, to) => {
      reads++
      assert.equal(from, 101)
      assert.equal(to, 105)
      assert.deepEqual(previous, makeSnapshot().fund)
      await gate
      return makeSnapshot().fund
    },
    readPortfolio: async (_provider, _config, blockNumber) => ({
      ...makeSnapshot().portfolio,
      blockNumber,
    }),
  })
  const first = service.refresh()
  const second = service.refresh()
  assert.equal(first, second)
  assert.equal(service.status.running, true)
  assert.equal(snapshots.snapshot?.block.number, 100)
  release()
  await first
  assert.equal(reads, 1)
  assert.equal(service.status.running, false)
  assert.equal(snapshots.snapshot?.block.number, 105)
  assert.equal(
    (await SnapshotStore.open(directory, defaultChain)).snapshot?.block.number,
    105,
  )
})

test('RPC failure retains last complete snapshot and does not leak provider credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-sync-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const snapshots = await SnapshotStore.open(directory, defaultChain)
  await snapshots.save(makeSnapshot())
  let fail = true
  const service = new SyncService({
    config: makeConfig(directory),
    snapshots,
    provider: providerAt(105) as unknown as Provider,
    readFund: async () => makeSnapshot().fund,
    readPortfolio: async (_provider, _config, blockNumber) => {
      if (fail) {
        throw new Error('RPC_URL=https://secret-token@provider')
      }
      return { ...makeSnapshot().portfolio, blockNumber }
    },
  })
  await assert.rejects(service.refresh(), /secret-token/)
  assert.deepEqual(snapshots.snapshot, makeSnapshot())
  assert.equal(JSON.stringify(service.status).includes('secret-token'), false)
  assert.equal(service.status.running, false)
  fail = false
  await service.refresh()
  assert.equal(snapshots.snapshot?.block.number, 105)
  assert.equal(service.status.lastError, null)
})

test('foreign chain, lagging RPC and changed block hashes cannot advance the cursor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-sync-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const snapshots = await SnapshotStore.open(directory, defaultChain)
  await snapshots.save(makeSnapshot())
  const wrongChain = {
    ...providerAt(105),
    getNetwork: async () => ({ chainId: 1n }),
  }
  const wrongHistory = {
    ...providerAt(105),
    getBlock: async () => ({
      number: 105,
      hash: `0x${'f'.repeat(64)}`,
      timestamp: 1700000005,
    }),
  }
  for (const provider of [wrongChain, providerAt(99), wrongHistory]) {
    const service = new SyncService({
      config: makeConfig(directory),
      snapshots,
      provider: provider as unknown as Provider,
      readFund: async () => {
        throw new Error('Readers must not run')
      },
    })
    await assert.rejects(
      service.refresh(),
      /chain does not match|behind|history/,
    )
    assert.equal(snapshots.snapshot?.block.number, 100)
  }
})

test('initial indexing starts at deployment and includes its events', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-sync-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const snapshots = await SnapshotStore.open(directory, defaultChain)
  const service = new SyncService({
    config: makeConfig(directory),
    snapshots,
    provider: providerAt(105) as unknown as Provider,
    readFund: async (_provider, _config, previous, from, to) => {
      assert.equal(previous, undefined)
      assert.equal(from, 50)
      assert.equal(to, 105)
      return makeSnapshot().fund
    },
    readPortfolio: async (_provider, _config, blockNumber) => ({
      ...makeSnapshot().portfolio,
      blockNumber,
    }),
  })
  await service.refresh()
  assert.equal(snapshots.snapshot?.block.number, 105)
})
