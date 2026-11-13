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

test('restart catches up the entire offline gap and a failed attempt cannot advance the persisted cursor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-sync-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const initial = makeSnapshot()
  const config = { ...makeConfig(directory), logBatchSize: 10 }
  await (await SnapshotStore.open(directory, defaultChain)).save(initial)
  let target = 10_105
  const block = (number: number) => ({
    number,
    hash:
      number === initial.block.number
        ? initial.block.hash
        : `0x${number.toString(16).padStart(64, '0')}`,
    timestamp: initial.block.timestamp + number - initial.block.number,
  })
  const provider = {
    getNetwork: async () => ({ chainId: 43114n }),
    getBlock: async (tag: string | number) =>
      block(tag === 'latest' ? target : Number(tag)),
    getTransactionReceipt: async () => {
      assert.fail('A restart must resume its snapshot, not replay deployment')
    },
  } as unknown as Provider

  for (const fail of [true, false, false]) {
    // Every iteration creates fresh instances, as an actual process restart does.
    const snapshots = await SnapshotStore.open(directory, defaultChain)
    const persisted = snapshots.snapshot
    assert.ok(persisted)
    let release = () => {}
    let started = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const reading = new Promise<void>(resolve => {
      started = resolve
    })
    const service = new SyncService({
      config,
      provider,
      snapshots,
      readFund: async (_provider, _chain, previous, from, to, batchSize) => {
        assert.deepEqual(previous, persisted.fund)
        assert.equal(from, persisted.block.number + 1)
        assert.equal(to, target)
        assert.equal(batchSize, 10)
        started()
        await gate
        if (fail) {
          throw new Error('RPC disconnected during catch-up')
        }
        return {
          ...persisted.fund,
          oreVein: { ...persisted.fund.oreVein, contractURI: `block:${to}` },
        }
      },
      readPortfolio: async (_provider, _chain, blockNumber) => ({
        ...persisted.portfolio,
        blockNumber,
      }),
    })
    const refresh = service.refresh()
    const completed = fail
      ? assert.rejects(refresh, /Fund event indexing/)
      : refresh
    await reading
    assert.equal(service.status.running, true)
    assert.deepEqual(snapshots.snapshot, persisted)
    assert.deepEqual(
      (await SnapshotStore.open(directory, defaultChain)).snapshot,
      persisted,
    )
    release()
    await completed
    const restored = (await SnapshotStore.open(directory, defaultChain))
      .snapshot
    if (fail) {
      assert.deepEqual(restored, initial)
    } else {
      assert.equal(restored?.block.number, target)
      assert.equal(restored?.portfolio.blockNumber, target)
      assert.equal(restored?.fund.oreVein.contractURI, `block:${target}`)
      target += 500
    }
  }
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
  await assert.rejects(service.refresh(), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Portfolio contract state read failed/)
    assert.ok(error.cause instanceof Error)
    assert.match(error.cause.message, /secret-token/)
    return true
  })
  assert.deepEqual(snapshots.snapshot, makeSnapshot())
  assert.match(
    service.status.lastError ?? '',
    /Portfolio contract state read failed/,
  )
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
    assert.match(
      service.status.lastError ?? '',
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

test('initial fund indexing failures identify the failing stage without exposing RPC errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-sync-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const snapshots = await SnapshotStore.open(directory, defaultChain)
  const cause = new Error(
    'PRIVATE_RPC_TOKEN: eth_getLogs allows only 10 blocks',
  )
  const service = new SyncService({
    config: makeConfig(directory),
    snapshots,
    provider: providerAt(105) as unknown as Provider,
    readFund: async () => {
      throw cause
    },
    readPortfolio: async (_provider, _config, blockNumber) => ({
      ...makeSnapshot().portfolio,
      blockNumber,
    }),
  })
  await assert.rejects(service.refresh(), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.cause, cause)
    return true
  })
  assert.match(service.status.lastError ?? '', /Fund event indexing/)
  assert.match(service.status.lastError ?? '', /RPC event range limits/)
  assert.equal(
    JSON.stringify(service.status).includes('PRIVATE_RPC_TOKEN'),
    false,
  )
  assert.equal(service.status.running, false)
  assert.equal(snapshots.snapshot, undefined)
})

test('snapshot save failures are distinguished from RPC failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-sync-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const snapshots = await SnapshotStore.open(directory, defaultChain)
  await snapshots.save(makeSnapshot())
  t.mock.method(snapshots, 'save', async () => {
    throw new Error('PRIVATE_STORAGE_PATH: disk full')
  })
  const service = new SyncService({
    config: makeConfig(directory),
    snapshots,
    provider: providerAt(105) as unknown as Provider,
    readFund: async () => makeSnapshot().fund,
    readPortfolio: async (_provider, _config, blockNumber) => ({
      ...makeSnapshot().portfolio,
      blockNumber,
    }),
  })
  await assert.rejects(
    service.refresh(),
    /Snapshot validation or persistence failed/,
  )
  assert.match(
    service.status.lastError ?? '',
    /Snapshot validation or persistence failed/,
  )
  assert.equal(
    JSON.stringify(service.status).includes('PRIVATE_STORAGE_PATH'),
    false,
  )
  assert.deepEqual(snapshots.snapshot, makeSnapshot())
})
