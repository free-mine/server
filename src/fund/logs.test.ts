import test from 'node:test'
import assert from 'node:assert/strict'

import type { Provider } from 'ethers'

import { fetchRange } from './logs.js'
import type { LogRange } from './fund.test.types.js'

test('backs off rate limits on the same range without splitting it', async () => {
  const calls: LogRange[] = []
  const delays: number[] = []
  const provider = {
    async getLogs(range: LogRange) {
      calls.push(range)
      throw Object.assign(new Error('exceeded maximum retry limit'), {
        code: 'SERVER_ERROR',
        info: {
          responseBody: 'error code: 1015',
          responseStatus:
            '599 CLIENT ESCALATED SERVER ERROR (429 Too Many Requests)',
        },
      })
    },
  } as unknown as Provider
  await assert.rejects(
    fetchRange(provider, [], 100, 200, async milliseconds => {
      delays.push(milliseconds)
    }),
    /maximum retry limit/,
  )
  assert.deepEqual(delays, [1000, 2000, 4000])
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => call.fromBlock === 100 && call.toBlock === 200))
})

test('recovers from transient transport errors with bounded backoff', async () => {
  let calls = 0
  const delays: number[] = []
  const provider = {
    async getLogs() {
      if (++calls < 3) {
        throw Object.assign(new Error('connection failed'), {
          code: 'ECONNRESET',
        })
      }
      return []
    },
  } as unknown as Provider
  assert.deepEqual(
    await fetchRange(provider, [], 100, 200, async milliseconds => {
      delays.push(milliseconds)
    }),
    [],
  )
  assert.equal(calls, 3)
  assert.deepEqual(delays, [1000, 2000])
})

test('does not retry or split invalid API keys and unsupported requests', async () => {
  for (const message of [
    'Invalid API key',
    '401 Unauthorized',
    'unsupported request',
    'historical block range unavailable: archive access required',
  ]) {
    let calls = 0
    const provider = {
      async getLogs() {
        calls++
        throw new Error(message)
      },
    } as unknown as Provider
    await assert.rejects(
      fetchRange(provider, [], 100, 200, async () => {
        assert.fail('A permanent error must not be retried')
      }),
    )
    assert.equal(calls, 1)
  }
})

test('stops splitting an oversized response at one block', async () => {
  let calls = 0
  const provider = {
    async getLogs() {
      calls++
      throw new Error('Query returned more than 10000 results')
    },
  } as unknown as Provider
  await assert.rejects(fetchRange(provider, [], 100, 103))
  assert.equal(calls, 3)
})
