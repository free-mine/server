import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { rm, mkdtemp } from 'node:fs/promises'

import type { Block, BlockTag, JsonRpcPayload } from 'ethers'

import { SyncService } from '../sync/index.js'
import { createRpcProvider } from './provider.js'
import { SnapshotStore } from '../snapshot/index.js'
import { makeConfig, makeSnapshot } from '../testing/index.js'

test('sequential log and state reads do not issue implicit chain ID requests', async t => {
  const config = makeConfig('unused')
  const provider = createRpcProvider(config)
  t.after(() => provider.destroy())
  const methods: string[] = []
  t.mock.method(
    provider,
    '_send',
    async (payload: JsonRpcPayload | JsonRpcPayload[]) => {
      const requests = Array.isArray(payload) ? payload : [payload]
      return requests.map(request => {
        methods.push(request.method)
        return {
          id: request.id,
          jsonrpc: '2.0',
          result: request.method === 'eth_getLogs' ? [] : '0xa86a',
        }
      })
    },
  )

  assert.equal(await provider.send('eth_chainId', []), '0xa86a')
  for (let start = 100; start < 150; start += 10) {
    await provider.getLogs({ fromBlock: start, toBlock: start + 9 })
  }
  await provider.call({ to: config.chain.addresses.oreVein, blockTag: 149 })
  await provider.getBalance(config.chain.addresses.oreVein, 149)

  assert.deepEqual(methods, [
    'eth_chainId',
    ...Array<string>(5).fill('eth_getLogs'),
    'eth_call',
    'eth_getBalance',
  ])
})

test('each refresh verifies the actual RPC chain, including after an endpoint changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-mine-rpc-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = makeConfig(directory)
  const snapshots = await SnapshotStore.open(directory, config.chain)
  const initial = makeSnapshot()
  await snapshots.save(initial)
  const provider = createRpcProvider(config)
  t.after(() => provider.destroy())
  let chainId: unknown = '0xa86a'
  const methods: string[] = []
  t.mock.method(
    provider,
    '_send',
    async (payload: JsonRpcPayload | JsonRpcPayload[]) => {
      const requests = Array.isArray(payload) ? payload : [payload]
      return requests.map(request => {
        methods.push(request.method)
        assert.equal(request.method, 'eth_chainId')
        return { id: request.id, jsonrpc: '2.0', result: chainId }
      })
    },
  )
  const target = { ...initial.block, number: 105, hash: `0x${'b'.repeat(64)}` }
  t.mock.method(
    provider,
    'getBlock',
    async (tag: BlockTag) =>
      (tag === initial.block.number ? initial.block : target) as Block,
  )
  let reads = 0
  const sync = new SyncService({
    config,
    provider,
    snapshots,
    readFund: async () => {
      reads++
      return initial.fund
    },
    readPortfolio: async (_provider, _config, blockNumber) => ({
      ...initial.portfolio,
      blockNumber,
    }),
  })

  // getNetwork is only ethers' cached formatting network; it cannot validate RPC.
  assert.equal((await provider.getNetwork()).chainId, 43114n)
  chainId = '0x1'
  await assert.rejects(sync.refresh(), /RPC chain does not match/)
  assert.equal(reads, 0)
  assert.deepEqual(snapshots.snapshot, initial)

  chainId = '0xa86a'
  await sync.refresh()
  assert.equal(reads, 1)
  assert.equal(snapshots.snapshot?.block.number, 105)
  const saved = snapshots.snapshot

  chainId = '0x1'
  await assert.rejects(sync.refresh(), /RPC chain does not match/)
  assert.equal(reads, 1)
  assert.deepEqual(snapshots.snapshot, saved)

  for (chainId of [null, true, 43114, '', '43114', 'not-a-chain']) {
    await assert.rejects(sync.refresh(), /RPC network lookup failed/)
    assert.equal(reads, 1)
    assert.deepEqual(snapshots.snapshot, saved)
  }
  assert.deepEqual(methods, Array<string>(9).fill('eth_chainId'))
})

test(
  'destroying the provider stops active replay without advancing the snapshot',
  { timeout: 5000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'free-mine-rpc-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const config = makeConfig(directory)
    const snapshots = await SnapshotStore.open(directory, config.chain)
    const initial = await snapshots.save(makeSnapshot())
    const provider = createRpcProvider(config)
    t.after(() => provider.destroy())
    let started = () => {}
    let release = () => {}
    const reading = new Promise<void>(resolve => {
      started = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    t.after(release)
    let batches = 0
    t.mock.method(
      provider,
      '_send',
      async (payload: JsonRpcPayload | JsonRpcPayload[]) => {
        const requests = Array.isArray(payload) ? payload : [payload]
        if (requests.some(request => request.method === 'eth_getLogs')) {
          batches++
          started()
          await gate
        }
        return requests.map(request => ({
          id: request.id,
          jsonrpc: '2.0',
          result: request.method === 'eth_getLogs' ? [] : '0xa86a',
        }))
      },
    )
    t.mock.method(
      provider,
      'getBlock',
      async (tag: BlockTag) =>
        ({
          ...initial.block,
          number: tag === 'latest' ? 1_000_000 : initial.block.number,
        }) as Block,
    )
    const sync = new SyncService({
      config,
      provider,
      snapshots,
      readPortfolio: async (_provider, _chain, blockNumber) => ({
        ...initial.portfolio,
        blockNumber,
      }),
    })
    const rejected = assert.rejects(sync.refresh(), /Fund event indexing/)
    await reading
    provider.destroy()
    release()
    await sync.idle()
    await rejected

    assert.equal(batches, 1)
    assert.equal(sync.status.running, false)
    assert.deepEqual(snapshots.snapshot, initial)
    assert.deepEqual(
      (await SnapshotStore.open(directory, config.chain)).snapshot,
      initial,
    )
  },
)

test('a failed initial chain lookup cannot start background network detection retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const provider = createRpcProvider(makeConfig('unused'))
  t.after(() => provider.destroy())
  let requests = 0
  t.mock.method(provider, '_send', async () => {
    requests++
    throw new Error('RPC unavailable')
  })

  const rejected = assert.rejects(
    provider.send('eth_chainId', []),
    /RPC unavailable/,
  )
  await Promise.resolve()
  t.mock.timers.tick(10)
  await rejected
  assert.equal(requests, 1)
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.equal(requests, 1)
})
