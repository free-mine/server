import test from 'node:test'
import assert from 'node:assert/strict'

import { ZeroAddress } from 'ethers'
import type { Log, Provider, Interface } from 'ethers'

import { readFund } from './read.js'
import { fundStateSchema } from './schema.js'
import type { ChainConfig } from '../config/index.js'
import { dollarAbi, oreVeinAbi, freeMineAbi, magicOreAbi } from './abi.js'
import type { LogRange, GetterCall, FixtureOptions } from './fund.test.types.js'

const address = (number: number) => `0x${number.toString(16).padStart(40, '0')}`
const alice = address(1)
const bob = address(2)
const owner = address(3)
const dollar = address(4)
const config: ChainConfig = {
  chainId: 43114,
  deploymentTx: `0x${'a'.repeat(64)}`,
  addresses: {
    magicOre: address(10),
    freeMine: address(11),
    oreVein: address(12),
    aavePool: address(13),
    uniswapFactory: address(14),
    uniswapPositionManager: address(15),
  },
  tokens: [],
  pairs: [],
}
const ore = 10n ** 18n

function event(
  abi: Interface,
  contract: string,
  name: string,
  args: readonly unknown[],
  blockNumber = 100,
  index = 0,
) {
  const fragment = abi.getEvent(name)
  assert.ok(fragment)
  const encoded = abi.encodeEventLog(fragment, args)
  return {
    ...encoded,
    address: contract,
    blockNumber,
    index,
    transactionIndex: 0,
    removed: false,
  } as unknown as Log
}

function emptyShift() {
  return {
    funded: false,
    price: '0',
    dollar: ZeroAddress,
    fundedAt: '0',
    oreAmount: '0',
    dollarScale: '0',
    currentClaimId: '0',
  }
}

function fixture(options: FixtureOptions = {}) {
  const calls: GetterCall[] = []
  const ranges: LogRange[] = []
  const provider = {
    async getLogs(filter: LogRange) {
      ranges.push(filter)
      if (options.permanentLogError) {
        throw new Error('RPC log request failed')
      }
      if (
        filter.toBlock - filter.fromBlock + 1 >
        (options.rangeLimit ?? Infinity)
      ) {
        throw new Error('Requested block range is too large')
      }
      // Return reverse order to exercise deterministic replay.
      return (options.logs ?? [])
        .filter(
          log =>
            log.blockNumber >= filter.fromBlock &&
            log.blockNumber <= filter.toBlock,
        )
        .toReversed()
    },
    async call(transaction: Parameters<Provider['call']>[0]) {
      const contract = String(transaction.to).toLowerCase()
      const abi =
        contract === config.addresses.magicOre
          ? magicOreAbi
          : contract === config.addresses.freeMine
            ? freeMineAbi
            : contract === config.addresses.oreVein
              ? oreVeinAbi
              : dollarAbi
      const parsed = abi.parseTransaction({ data: String(transaction.data) })
      assert.ok(parsed)
      calls.push({ method: parsed.name, blockTag: transaction.blockTag })
      if (options.failCalls) {
        throw new Error('RPC getter failed')
      }
      if (parsed.name === 'shifts') {
        const shift = options.shifts?.[String(parsed.args[0])] ?? emptyShift()
        return abi.encodeFunctionResult('shifts', [
          shift.funded,
          shift.price,
          shift.dollar,
          shift.fundedAt,
          shift.oreAmount,
          shift.dollarScale,
          shift.currentClaimId,
        ])
      }
      const values: Record<string, unknown> = {
        name: 'Magic Ore',
        symbol: 'ORE',
        decimals: contract === dollar ? 6 : 18,
        totalSupply: options.totalSupply ?? 0n,
        owner:
          contract === config.addresses.magicOre
            ? config.addresses.freeMine
            : contract === config.addresses.freeMine
              ? config.addresses.oreVein
              : owner,
        pendingOwner: ZeroAddress,
        freeMine: config.addresses.freeMine,
        magicOre: config.addresses.magicOre,
        contractURI: 'https://example.test/fund.json',
        dollar,
        entryPrice: (12n * ore) / 10n,
        priceUpdatedAt: 1_700_000_000n,
        currentShiftId: options.currentShiftId ?? 1n,
      }
      return abi.encodeFunctionResult(parsed.name, [values[parsed.name]])
    },
  } as unknown as Provider
  return { provider, calls, ranges }
}

test('replays ordered events and reads absent event fields at the snapshot block', async () => {
  const { magicOre, freeMine, oreVein } = config.addresses
  const mocked = fixture({
    totalSupply: 10n * ore,
    currentShiftId: 2n,
    logs: [
      event(magicOreAbi, magicOre, 'Transfer', [ZeroAddress, alice, 10n * ore]),
      event(
        magicOreAbi,
        magicOre,
        'Transfer',
        [alice, freeMine, 4n * ore],
        100,
        1,
      ),
      event(
        freeMineAbi,
        freeMine,
        'ClaimOpened',
        [4n * ore, alice, 1, 1],
        100,
        2,
      ),
      event(
        oreVeinAbi,
        oreVein,
        'SuccessorScheduled',
        [bob, 0, 500, owner],
        100,
        3,
      ),
      event(
        oreVeinAbi,
        oreVein,
        'SuccessorScheduled',
        [bob, 500, 600, owner],
        100,
        4,
      ),
      event(oreVeinAbi, oreVein, 'AdminActivated', [bob, 600], 100, 5),
    ],
    shifts: {
      '1': {
        funded: true,
        price: ore.toString(),
        dollar,
        fundedAt: '1700000001',
        oreAmount: (4n * ore).toString(),
        dollarScale: (10n ** 12n).toString(),
        currentClaimId: '1',
      },
    },
  })
  const state = await readFund(mocked.provider, config, undefined, 100, 105, 10)
  assert.deepEqual(state.magicOre.holders, {
    [alice]: (6n * ore).toString(),
    [freeMine]: (4n * ore).toString(),
  })
  assert.equal(state.freeMine.claims['1:1']?.miner, alice)
  assert.equal(state.freeMine.shifts['1']?.price, ore.toString())
  assert.equal(state.freeMine.shifts['1']?.fundedAt, '1700000001')
  assert.equal(state.freeMine.entryPrice, ((12n * ore) / 10n).toString())
  assert.deepEqual(state.freeMine.dollar, { address: dollar, decimals: 6 })
  assert.deepEqual(state.oreVein.successors, {})
  assert.deepEqual(state.oreVein.admins, [bob])
  assert.ok(mocked.calls.length > 15)
  assert.ok(mocked.calls.every(call => call.blockTag === 105))
})

test('resumes balances, claims and crew without retaining closed claims or old empty shifts', async () => {
  const { magicOre, freeMine, oreVein } = config.addresses
  const initial = fixture({
    totalSupply: 10n * ore,
    currentShiftId: 3n,
    logs: [
      event(magicOreAbi, magicOre, 'Transfer', [ZeroAddress, alice, 10n * ore]),
      event(
        magicOreAbi,
        magicOre,
        'Transfer',
        [alice, freeMine, 4n * ore],
        100,
        1,
      ),
      event(
        freeMineAbi,
        freeMine,
        'ClaimOpened',
        [4n * ore, alice, 1, 1],
        100,
        2,
      ),
      event(
        oreVeinAbi,
        oreVein,
        'SuccessorScheduled',
        [bob, 0, 500, owner],
        100,
        3,
      ),
      event(oreVeinAbi, oreVein, 'AdminActivated', [bob, 500], 100, 4),
    ],
    shifts: {
      '1': {
        ...emptyShift(),
        oreAmount: (4n * ore).toString(),
        currentClaimId: '1',
      },
    },
  })
  const previous = await readFund(
    initial.provider,
    config,
    undefined,
    100,
    100,
    10,
  )
  const original = structuredClone(previous)
  const resumed = fixture({
    totalSupply: 9n * ore,
    currentShiftId: 3n,
    logs: [
      event(
        magicOreAbi,
        magicOre,
        'Transfer',
        [freeMine, ZeroAddress, ore],
        101,
        0,
      ),
      event(
        magicOreAbi,
        magicOre,
        'Transfer',
        [freeMine, alice, 3n * ore],
        101,
        1,
      ),
      event(freeMineAbi, freeMine, 'ClaimClosed', [true, alice, 1, 1], 101, 2),
      event(oreVeinAbi, oreVein, 'AdminRemoved', [bob], 101, 3),
      event(
        oreVeinAbi,
        oreVein,
        'SuccessorScheduled',
        [bob, 0, 700, owner],
        101,
        4,
      ),
      event(oreVeinAbi, oreVein, 'SuccessorRemoved', [bob, 700, owner], 101, 5),
    ],
  })
  const state = await readFund(resumed.provider, config, previous, 101, 105, 2)
  assert.deepEqual(state.magicOre.holders, { [alice]: (9n * ore).toString() })
  assert.deepEqual(state.freeMine.claims, {})
  assert.deepEqual(Object.keys(state.freeMine.shifts).sort(), ['2', '3'])
  assert.deepEqual(state.oreVein.admins, [])
  assert.deepEqual(state.oreVein.successors, {})
  assert.deepEqual(previous, original)
  assert.ok(resumed.ranges.every(range => range.fromBlock >= 101))
})

test('a failed enrichment does not mutate the previous snapshot', async () => {
  const initial = fixture({
    totalSupply: 10n * ore,
    logs: [
      event(magicOreAbi, config.addresses.magicOre, 'Transfer', [
        ZeroAddress,
        alice,
        10n * ore,
      ]),
    ],
  })
  const previous = await readFund(
    initial.provider,
    config,
    undefined,
    100,
    100,
    10,
  )
  const original = structuredClone(previous)
  const failing = fixture({
    failCalls: true,
    logs: [
      event(
        magicOreAbi,
        config.addresses.magicOre,
        'Transfer',
        [alice, bob, ore],
        101,
      ),
    ],
  })
  await assert.rejects(
    readFund(failing.provider, config, previous, 101, 101, 10),
    /RPC getter failed/,
  )
  assert.deepEqual(previous, original)
})

test('refreshes getters without replaying events when the indexed head is unchanged', async () => {
  const initial = fixture({
    totalSupply: 10n * ore,
    logs: [
      event(magicOreAbi, config.addresses.magicOre, 'Transfer', [
        ZeroAddress,
        alice,
        10n * ore,
      ]),
    ],
  })
  const previous = await readFund(
    initial.provider,
    config,
    undefined,
    100,
    100,
    10,
  )
  const refreshed = fixture({ totalSupply: 10n * ore })
  const state = await readFund(
    refreshed.provider,
    config,
    previous,
    101,
    100,
    10,
  )
  assert.deepEqual(state, previous)
  assert.deepEqual(refreshed.ranges, [])
  assert.ok(refreshed.calls.every(call => call.blockTag === 100))
})

test('splits oversized RPC log ranges and propagates permanent errors', async () => {
  const limited = fixture({ rangeLimit: 2 })
  await readFund(limited.provider, config, undefined, 100, 107, 8)
  assert.deepEqual(
    limited.ranges.map(range => [range.fromBlock, range.toBlock]),
    [
      [100, 107],
      [100, 103],
      [100, 101],
      [102, 103],
      [104, 107],
      [104, 105],
      [106, 107],
    ],
  )
  const failing = fixture({ permanentLogError: true })
  await assert.rejects(
    readFund(failing.provider, config, undefined, 100, 107, 8),
  )
  assert.equal(failing.ranges.length, 1)
})

test('rejects inconsistent replay and malformed restored snapshot values', async () => {
  const invalid = fixture({
    logs: [
      event(magicOreAbi, config.addresses.magicOre, 'Transfer', [
        alice,
        bob,
        ore,
      ]),
    ],
  })
  await assert.rejects(
    readFund(invalid.provider, config, undefined, 100, 100, 10),
    /exceeds indexed balance/,
  )
  const empty = fixture()
  const state = await readFund(empty.provider, config, undefined, 100, 100, 10)
  const broken = structuredClone(state)
  broken.magicOre.holders[alice] = '-1'
  assert.equal(fundStateSchema.safeParse(broken).success, false)
  broken.magicOre.holders[alice] = '1'
  assert.equal(fundStateSchema.safeParse(broken).success, false)
  broken.magicOre.holders[alice] = 'not-a-number'
  assert.equal(fundStateSchema.safeParse(broken).success, false)
})
