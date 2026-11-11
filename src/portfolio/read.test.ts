import test from 'node:test'
import assert from 'node:assert/strict'

import { Interface, ZeroAddress } from 'ethers'
import type { Provider, TransactionRequest } from 'ethers'

import { Q96, Q128 } from './math.js'
import { readPortfolio } from './read.js'
import { sqrtRatioAtTick } from './tick-math.js'
import { portfolioStateSchema } from './schema.js'
import type { FixtureOptions } from './test.types.js'
import type { ChainConfig } from '../config/index.js'
import {
  aaveAbi,
  poolAbi,
  erc20Abi,
  factoryAbi,
  positionManagerAbi,
} from './abi.js'

const address = (id: number) => `0x${id.toString(16).padStart(40, '0')}`
const metadata = {
  base: { symbol: 'WAVAX', address: address(1), decimals: 18 },
  quote: { symbol: 'USDC', address: address(2), decimals: 6 },
}

function fixture(options: FixtureOptions = {}) {
  const config: ChainConfig = {
    chainId: 43114,
    deploymentTx: `0x${'0'.repeat(64)}`,
    addresses: {
      magicOre: address(3),
      freeMine: address(4),
      oreVein: address(5),
      aavePool: address(6),
      uniswapFactory: address(7),
      uniswapPositionManager: address(8),
    },
    tokens: [
      { ...metadata.base, aave: 'supply' },
      { ...metadata.quote, aave: 'borrow' },
    ],
    pairs: [{ baseSymbol: 'WAVAX', quoteSymbol: 'USDC', fee: 500 }],
  }
  const abi = new Interface([
    ...aaveAbi,
    ...poolAbi,
    ...erc20Abi,
    ...factoryAbi,
    ...positionManagerAbi,
  ])
  const calls: string[] = []
  const token0 = options.reverse
    ? metadata.quote.address
    : metadata.base.address
  const token1 = options.reverse
    ? metadata.base.address
    : metadata.quote.address
  const tick = options.currentTick ?? 0
  const lowerTick = options.fullRange ? -887270 : -10
  const upperTick = options.fullRange ? 887270 : 10
  const provider = {
    async getBalance(owner: string, block: number) {
      assert.equal(owner, config.addresses.oreVein)
      assert.equal(block, 77)
      calls.push('nativeBalance')
      return 3n * 10n ** 18n
    },
    async call(request: TransactionRequest) {
      assert.equal(request.blockTag, 77)
      assert.equal(typeof request.to, 'string')
      const target = String(request.to).toLowerCase()
      const parsed = abi.parseTransaction({ data: String(request.data) })
      assert.ok(parsed)
      const { name, args } = parsed
      calls.push(`${target}:${name}`)
      if (options.rpcFailure && target === config.addresses.aavePool) {
        throw new Error('FIXTURE_RPC_UNAVAILABLE')
      }
      let values: unknown[]
      switch (name) {
        case 'balanceOf':
          assert.equal(String(args[0]).toLowerCase(), config.addresses.oreVein)
          values = [
            target === config.addresses.uniswapPositionManager
              ? 2n
              : target === address(11)
                ? 125n * 10n ** 18n
                : target === address(12)
                  ? 205n * 10n ** 6n
                  : 10n ** 18n + 1n,
          ]
          break
        case 'getUserAccountData':
          values = [1n, options.noDebt ? 0n : 1n, 1n, 1n, 1n, 15n * 10n ** 17n]
          break
        case 'getReserveData':
          values = [
            [0n],
            10n ** 27n,
            0n,
            10n ** 27n,
            0n,
            0n,
            1n,
            1n,
            address(11),
            ZeroAddress,
            address(12),
            ZeroAddress,
            0n,
            0n,
            0n,
          ]
          break
        case 'factory':
          values = [config.addresses.uniswapFactory]
          break
        case 'getPool':
          values = [options.missingPool ? ZeroAddress : address(10)]
          break
        case 'token0':
          values = [token0]
          break
        case 'token1':
          values = [token1]
          break
        case 'slot0':
          values = [
            options.uninitializedPool ? 0n : sqrtRatioAtTick(tick),
            tick,
            0,
            1,
            1,
            0,
            true,
          ]
          break
        case 'tickSpacing':
          values = [10]
          break
        case 'feeGrowthGlobal0X128':
          values = [5n * Q128]
          break
        case 'feeGrowthGlobal1X128':
          values = [9n * Q128]
          break
        case 'tokenOfOwnerByIndex':
          values = [BigInt(args[1]) + 42n]
          break
        case 'ownerOf':
          values = [config.addresses.oreVein]
          break
        case 'positions':
          values = [
            0,
            ZeroAddress,
            token0,
            token1,
            BigInt(args[0]) === 42n ? 500 : 3000,
            lowerTick,
            upperTick,
            1000000n,
            1n * Q128,
            2n * Q128,
            101n,
            202n,
          ]
          break
        case 'ticks': {
          const isLower = Number(args[0]) === lowerTick
          const outside0 = tick < lowerTick ? (isLower ? 5n * Q128 : 0n) : 0n
          const outside1 = tick < lowerTick ? (isLower ? 9n * Q128 : 0n) : 0n
          const above0 = tick >= upperTick && !isLower ? 5n * Q128 : outside0
          const above1 = tick >= upperTick && !isLower ? 9n * Q128 : outside1
          values = [1000000n, 0n, above0, above1, 0, 0, 0, true]
          break
        }
        default:
          throw new Error(`Unexpected fixture call: ${name}`)
      }
      return abi.encodeFunctionResult(name, values)
    },
  } as unknown as Provider
  return { provider, config, calls }
}

test('snapshot fixes every call to its block and includes interest-bearing balances', async () => {
  const { provider, config, calls } = fixture()
  const state = await readPortfolio(provider, config, 77)
  assert.equal(state.blockNumber, 77)
  assert.equal(state.nativeBalance.amount, '3000000000000000000')
  assert.equal(state.balances[0]?.amount, '1000000000000000001')
  assert.equal(state.aave.supplies[0]?.amount, '125000000000000000000')
  assert.equal(state.aave.debts[0]?.amount, '205000000')
  assert.equal(state.aave.debts[0]?.stableDebt, '0')
  assert.equal(state.aave.healthFactor, '1.5')
  assert.equal(state.uniswap.positions.length, 1)
  const position = state.uniswap.positions[0]
  assert.ok(position)
  assert.equal(position.tokenId, '42')
  assert.equal(position.price, '1000000000000')
  assert.equal(position.inRange, true)
  assert.deepEqual(position.newlyAccruedFees, {
    base: '4000000',
    quote: '7000000',
  })
  assert.deepEqual(position.storedOwed, { base: '101', quote: '202' })
  assert.deepEqual(position.totalCollectable, {
    base: '4000101',
    quote: '7000202',
  })
  assert.equal(position.range.fullRange, false)
  assert.equal(portfolioStateSchema.safeParse(state).success, true)
  assert.ok(calls.some(call => call.endsWith(':ownerOf')))
})

test('inverted pool order also inverts amounts, fee tokens and price range', async () => {
  const directFixture = fixture()
  const inverseFixture = fixture({ reverse: true })
  const direct = await readPortfolio(
    directFixture.provider,
    directFixture.config,
    77,
  )
  const inverse = await readPortfolio(
    inverseFixture.provider,
    inverseFixture.config,
    77,
  )
  const position = inverse.uniswap.positions[0]
  const original = direct.uniswap.positions[0]
  assert.ok(position)
  assert.ok(original)
  assert.deepEqual(position.amounts, {
    base: original.amounts.quote,
    quote: original.amounts.base,
  })
  assert.deepEqual(position.newlyAccruedFees, {
    base: '7000000',
    quote: '4000000',
  })
  assert.deepEqual(position.storedOwed, { base: '202', quote: '101' })
  assert.ok(
    BigInt(position.range.lowerPrice.split('.')[0] ?? '') < 1000000000000n,
  )
  assert.ok(
    BigInt(position.range.upperPrice.split('.')[0] ?? '') > 1000000000000n,
  )
})

test('position range includes its lower tick and excludes its upper tick', async () => {
  for (const [currentTick, inRange] of [
    [-10, true],
    [10, false],
  ] as const) {
    const { provider, config } = fixture({ currentTick })
    const state = await readPortfolio(provider, config, 77)
    const position = state.uniswap.positions[0]
    assert.ok(position)
    assert.equal(position.inRange, inRange)
    assert.equal(
      currentTick === -10 ? position.amounts.quote : position.amounts.base,
      '0',
    )
  }
})

test('full range is identified using tick spacing, with usable decimal endpoints', async () => {
  const { provider, config } = fixture({ fullRange: true, noDebt: true })
  const state = await readPortfolio(provider, config, 77)
  const position = state.uniswap.positions[0]
  assert.ok(position)
  assert.equal(position.range.fullRange, true)
  assert.match(position.range.lowerPrice, /^0\.0+[1-9]\d*$/)
  assert.notEqual(position.range.upperPrice, '0')
  assert.equal(state.aave.healthFactor, null)
})

test('absent or uninitialized pools have no fabricated spot price', async () => {
  for (const options of [{ missingPool: true }, { uninitializedPool: true }]) {
    const { provider, config } = fixture(options)
    const state = await readPortfolio(provider, config, 77)
    assert.equal(state.uniswap.pools[0]?.price, null)
    assert.deepEqual(state.uniswap.positions, [])
  }
})

test('an RPC failure rejects the whole snapshot instead of replacing data with zeros', async () => {
  const { provider, config } = fixture({ rpcFailure: true })
  await assert.rejects(
    readPortfolio(provider, config, 77),
    /FIXTURE_RPC_UNAVAILABLE/,
  )
})

test('schema rejects unsafe amount numbers and prices in exponent notation', () => {
  const empty = {
    blockNumber: 77,
    nativeBalance: { symbol: 'AVAX', decimals: 18, amount: '0' },
    balances: [],
    aave: { supplies: [], debts: [], healthFactor: null },
    uniswap: { pools: [], positions: [] },
  }
  assert.equal(portfolioStateSchema.safeParse(empty).success, true)
  assert.equal(
    portfolioStateSchema.safeParse({
      ...empty,
      balances: [{ ...metadata.base, amount: Number(Q96) }],
    }).success,
    false,
  )
  assert.equal(
    portfolioStateSchema.safeParse({
      ...empty,
      aave: { ...empty.aave, healthFactor: '1e18' },
    }).success,
    false,
  )
})
