import test from 'node:test'
import assert from 'node:assert/strict'

import { MIN_TICK, MAX_TICK, sqrtRatioAtTick } from './tick-math.js'
import {
  Q96,
  Q128,
  quotePrice,
  accruedFees,
  formatRatio,
  liquidityAmounts,
} from './math.js'

test('TickMath preserves protocol rounding at zero and the extreme ticks', () => {
  assert.equal(sqrtRatioAtTick(0), Q96)
  assert.equal(sqrtRatioAtTick(MIN_TICK), 4295128739n)
  assert.equal(
    sqrtRatioAtTick(MAX_TICK),
    1461446703485210103287273052203988822378723970342n,
  )
  assert.equal(sqrtRatioAtTick(1), 79232123823359799118286999568n)
  assert.equal(sqrtRatioAtTick(-1), 79224201403219477170569942574n)
  assert.throws(() => sqrtRatioAtTick(MAX_TICK + 1), /INVALID_UNISWAP_TICK/)
})

test('price converts token decimals and both token address orders', () => {
  assert.equal(quotePrice(Q96, true, 18, 6), '1000000000000')
  assert.equal(quotePrice(2n * Q96, true, 8, 6), '400')
  assert.equal(quotePrice(2n * Q96, false, 8, 6), '25')
  assert.equal(quotePrice(2n * Q96, true, 6, 18), '0.000000000004')
  assert.equal(quotePrice(2n * Q96, false, 6, 18), '0.00000000000025')
})

test('full-range prices remain positive decimal values without exponent notation', () => {
  const lower = quotePrice(sqrtRatioAtTick(-887270), true, 6, 18)
  const upper = quotePrice(sqrtRatioAtTick(887270), false, 6, 18)
  assert.match(lower, /^0\.0+[1-9]\d*$/)
  assert.match(upper, /^0\.0+[1-9]\d*$/)
  assert.notEqual(lower, '0')
  assert.notEqual(upper, '0')
  assert.equal(formatRatio(10n ** 90n + 1n, 1n), `${10n ** 90n + 1n}`)
})

test('liquidity holdings use exact floor rounding below, within and above range', () => {
  const lower = Q96
  const upper = 4n * Q96
  assert.deepEqual(liquidityAmounts(120n, Q96 / 2n, lower, upper), [90n, 0n])
  assert.deepEqual(liquidityAmounts(120n, lower, lower, upper), [90n, 0n])
  assert.deepEqual(liquidityAmounts(120n, 2n * Q96, lower, upper), [30n, 120n])
  assert.deepEqual(liquidityAmounts(120n, upper, lower, upper), [0n, 360n])
  assert.deepEqual(liquidityAmounts(120n, upper * 2n, lower, upper), [0n, 360n])
  assert.deepEqual(liquidityAmounts(1n, 2n * Q96, lower, upper), [0n, 1n])
})

test('fee growth uses inclusive lower and exclusive upper tick boundaries', () => {
  const state = {
    liquidity: 10n,
    lowerTick: -10,
    upperTick: 10,
    global: 20n * Q128,
    lowerOutside: 7n * Q128,
    upperOutside: 3n * Q128,
    lastInside: 0n,
  }
  assert.equal(accruedFees({ ...state, currentTick: -11 }), 40n)
  assert.equal(accruedFees({ ...state, currentTick: -10 }), 100n)
  assert.equal(accruedFees({ ...state, currentTick: 9 }), 100n)
  const above = { ...state, lowerOutside: 3n * Q128, upperOutside: 7n * Q128 }
  assert.equal(accruedFees({ ...above, currentTick: 10 }), 40n)
  assert.equal(accruedFees({ ...above, currentTick: 11 }), 40n)
})

test('fee growth subtraction wraps at uint256 without losing precision', () => {
  const modulus = 1n << 256n
  const state = {
    liquidity: 5n,
    currentTick: 0,
    lowerTick: -10,
    upperTick: 10,
    global: 3n * Q128,
    lowerOutside: 0n,
    upperOutside: 0n,
    lastInside: modulus - 2n * Q128,
  }
  assert.equal(accruedFees(state), 25n)
  assert.equal(
    accruedFees({
      ...state,
      global: 2n * Q128,
      lowerOutside: modulus - 4n * Q128,
      upperOutside: 1n * Q128,
      lastInside: 2n * Q128,
    }),
    15n,
  )
  assert.equal(accruedFees({ ...state, liquidity: 0n }), 0n)
})
