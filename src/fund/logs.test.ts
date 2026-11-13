import test from 'node:test'
import assert from 'node:assert/strict'

import type { Provider } from 'ethers'

import type { LogBatch } from './types.js'
import { fetchLogBatches } from './logs.js'
import type { LogRange } from './fund.test.types.js'

async function collect(batches: AsyncIterable<LogBatch>) {
  const result: LogBatch[] = []
  for await (const batch of batches) {
    result.push(batch)
  }
  return result
}

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
    collect(
      fetchLogBatches(provider, [], 100, 200, 101, async milliseconds => {
        delays.push(milliseconds)
      }),
    ),
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
    await collect(
      fetchLogBatches(provider, [], 100, 200, 101, async milliseconds => {
        delays.push(milliseconds)
      }),
    ),
    [{ fromBlock: 100, toBlock: 200, logs: [] }],
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
      collect(
        fetchLogBatches(provider, [], 100, 200, 101, async () => {
          assert.fail('A permanent error must not be retried')
        }),
      ),
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
  await assert.rejects(collect(fetchLogBatches(provider, [], 100, 103, 4)))
  assert.equal(calls, 3)
})

test('learns a provider block limit once and covers subsequent batches without gaps', async () => {
  const calls: LogRange[] = []
  const provider = {
    async getLogs(range: LogRange) {
      calls.push(range)
      if (range.toBlock - range.fromBlock + 1 > 10) {
        throw Object.assign(new Error('could not coalesce error'), {
          code: 'UNKNOWN_ERROR',
          error: {
            code: -32600,
            message:
              'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x64, 0x6d]. Upgrade to PAYG for expanded block range.',
          },
        })
      }
      return []
    },
  } as unknown as Provider
  const batches = await collect(
    fetchLogBatches(provider, [], 100, 144, 20, async () => {
      assert.fail('A block limit must be adapted without a retry delay')
    }),
  )
  assert.deepEqual(
    calls.map(range => [range.fromBlock, range.toBlock]),
    [
      [100, 119],
      [100, 109],
      [110, 119],
      [120, 129],
      [130, 139],
      [140, 144],
    ],
  )
  assert.deepEqual(
    batches.map(batch => [batch.fromBlock, batch.toBlock]),
    [
      [100, 109],
      [110, 119],
      [120, 129],
      [130, 139],
      [140, 144],
    ],
  )
})

test('learns the Avalanche maximum block range after one failed request', async () => {
  const calls: LogRange[] = []
  const provider = {
    async getLogs(range: LogRange) {
      calls.push(range)
      if (range.toBlock - range.fromBlock + 1 > 100) {
        throw new Error(
          'block range too large: total block range in this request exceeds the maximum of 100 blocks',
        )
      }
      return []
    },
  } as unknown as Provider
  const batches = await collect(
    fetchLogBatches(provider, [], 100, 449, 200, async () => {
      assert.fail('A block limit must be adapted without a retry delay')
    }),
  )
  assert.deepEqual(
    calls.map(range => [range.fromBlock, range.toBlock]),
    [
      [100, 299],
      [100, 199],
      [200, 299],
      [300, 399],
      [400, 449],
    ],
  )
  assert.deepEqual(
    batches.map(batch => [batch.fromBlock, batch.toBlock]),
    [
      [100, 199],
      [200, 299],
      [300, 399],
      [400, 449],
    ],
  )
})

test('invalid advertised limits fall back to a smaller range and stop at one block', async () => {
  for (const limit of ['0', '99999999999999999999999', '20']) {
    const calls: LogRange[] = []
    const provider = {
      async getLogs(range: LogRange) {
        calls.push(range)
        throw new Error(
          `eth_getLogs requests support up to a ${limit} block range`,
        )
      },
    } as unknown as Provider
    await assert.rejects(collect(fetchLogBatches(provider, [], 100, 103, 4)))
    assert.deepEqual(
      calls.map(range => [range.fromBlock, range.toBlock]),
      [
        [100, 103],
        [100, 101],
        [100, 100],
      ],
    )
  }
})
