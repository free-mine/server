import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { setImmediate } from 'node:timers/promises'

import { startSyncLoop } from './scheduler.js'

function deferred() {
  let resolve = () => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

test('starts immediately and waits ten minutes after each successful refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const stop = startSyncLoop({
    refresh: async () => {
      calls++
    },
    onError: () => assert.fail('Refresh should succeed'),
    intervalMs: 600_000,
    retryIntervalMs: 60_000,
  })
  t.after(stop)
  assert.equal(calls, 1)
  await setImmediate()
  t.mock.timers.tick(599_999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(calls, 2)
  await setImmediate()
  t.mock.timers.tick(599_999)
  assert.equal(calls, 2)
  t.mock.timers.tick(1)
  assert.equal(calls, 3)
})

test('retries failed refreshes after one minute and restores the normal interval on success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let errors = 0
  const stop = startSyncLoop({
    refresh: async () => {
      if (++calls === 1) {
        throw new Error('RPC unavailable')
      }
    },
    onError: () => {
      errors++
    },
    intervalMs: 600_000,
    retryIntervalMs: 60_000,
  })
  t.after(stop)
  await setImmediate()
  assert.equal(errors, 1)
  t.mock.timers.tick(59_999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(calls, 2)
  await setImmediate()
  t.mock.timers.tick(599_999)
  assert.equal(calls, 2)
  t.mock.timers.tick(1)
  assert.equal(calls, 3)
  assert.equal(errors, 1)
})

test('long refreshes never overlap and stopping cancels the pending timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred()
  let calls = 0
  const stop = startSyncLoop({
    refresh: async () => {
      calls++
      await gate.promise
    },
    onError: () => assert.fail('Refresh should succeed'),
    intervalMs: 600_000,
    retryIntervalMs: 60_000,
  })
  t.after(stop)
  t.mock.timers.tick(1_800_000)
  assert.equal(calls, 1)
  gate.resolve()
  await setImmediate()
  t.mock.timers.tick(599_999)
  assert.equal(calls, 1)
  stop()
  t.mock.timers.tick(1_800_000)
  assert.equal(calls, 1)
})

test('stopping during an active refresh prevents both success and failure from scheduling more work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const fail of [false, true]) {
    const gate = deferred()
    let calls = 0
    const stop = startSyncLoop({
      refresh: () => {
        calls++
        return gate.promise
      },
      onError: () => {},
      intervalMs: 600_000,
      retryIntervalMs: 60_000,
    })
    stop()
    if (fail) {
      gate.reject(new Error('RPC unavailable'))
    } else {
      gate.resolve()
    }
    await setImmediate()
    t.mock.timers.tick(1_800_000)
    assert.equal(calls, 1)
  }
})
