import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { TestContext } from 'node:test'
import { join, dirname, resolve } from 'node:path'
import { rm, mkdir, mkdtemp, writeFile } from 'node:fs/promises'

import type { Provider } from 'ethers'

import { createServer } from './server.js'
import { SyncService } from '../sync/index.js'
import { SnapshotStore } from '../snapshot/index.js'
import { TransactionStore } from '../storage/index.js'
import { makeConfig, makeSnapshot } from '../testing/index.js'

const ownerKey = 'test-owner-key'
const authorization = `Bearer ${ownerKey}`
const successor = `0x${'a'.repeat(40)}`
const privatePayload = {
  rawTransaction: 'PRIVATE_SIGNED_TRANSACTION',
  status: 'prepared',
}

async function setKey(path: string, key: string): Promise<void> {
  await writeFile(path, createHash('sha256').update(key).digest('hex'))
}

async function setup(context: TestContext, populated = true) {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'free-mine-http-'))
  const config = makeConfig(directory)
  await setKey(config.ownerKeyHashFile, ownerKey)
  const snapshots = await SnapshotStore.open(directory, config.chain)
  if (populated) {
    const snapshot = makeSnapshot()
    snapshot.fund.oreVein.successors[successor] = '2000000000'
    await snapshots.save(snapshot)
  }
  const transactions = await TransactionStore.open(directory)
  const calls = { refresh: 0 }
  const provider = {
    async getNetwork() {
      calls.refresh += 1
      throw new Error('PRIVATE_RPC_TOKEN must never appear in API responses')
    },
  } as unknown as Provider
  const sync = new SyncService({ config, snapshots, provider })
  const app = createServer({ config, snapshots, transactions, sync })
  context.after(async () => {
    await app.close()
    await sync.idle()
    assert.equal(dirname(resolve(directory)), parent)
    await rm(directory, { recursive: true, force: true })
  })
  return { app, config, snapshots, transactions, sync, calls, directory }
}

test('before initial synchronization status stays available and data report unavailable', async context => {
  const { app } = await setup(context, false)
  for (const url of ['/v1/state', '/v1/backup']) {
    assert.equal((await app.inject(url)).statusCode, 503, url)
  }
  const status = await app.inject('/v1/status')
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().block, null)
  assert.equal(status.json().updatedAt, null)
})

test('public state, successors and gzip backup need no key and exclude private records', async context => {
  const { app, snapshots, transactions } = await setup(context)
  await transactions.put('private-operation', privatePayload, null)
  const state = await app.inject({
    url: '/v1/state',
    headers: { origin: 'https://public-client.example' },
  })
  assert.equal(state.statusCode, 200)
  assert.equal(state.headers['access-control-allow-origin'], '*')
  assert.deepEqual(state.json(), snapshots.snapshot)
  assert.equal(state.json().fund.oreVein.successors[successor], '2000000000')

  const backup = await app.inject('/v1/backup')
  assert.equal(backup.statusCode, 200)
  assert.equal(backup.headers['content-type'], 'application/gzip')
  assert.match(String(backup.headers['content-disposition']), /attachment/)
  const json = gunzipSync(backup.rawPayload).toString('utf8')
  assert.deepEqual(JSON.parse(json), snapshots.snapshot)
  for (const secret of [
    'PRIVATE_SIGNED_TRANSACTION',
    'private-operation',
    ownerKey,
  ]) {
    assert.equal(json.includes(secret), false)
    assert.equal(state.body.includes(secret), false)
  }
})

test('all transaction and refresh routes authenticate before accessing data or starting work', async context => {
  const { app, transactions, calls } = await setup(context)
  await transactions.put('private-operation', privatePayload, null)
  for (const headers of [{}, { authorization: 'Bearer incorrect-key' }]) {
    for (const request of [
      { method: 'GET' as const, url: '/v1/transactions' },
      { method: 'GET' as const, url: '/v1/transactions/private-operation' },
      {
        method: 'PUT' as const,
        url: '/v1/transactions/new-operation',
        payload: {},
      },
      { method: 'DELETE' as const, url: '/v1/transactions/private-operation' },
      { method: 'POST' as const, url: '/v1/refresh' },
    ]) {
      const response = await app.inject({ ...request, headers })
      assert.equal(response.statusCode, 401, `${request.method} ${request.url}`)
      assert.equal(response.headers['www-authenticate'], 'Bearer')
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(response.body.includes('PRIVATE_SIGNED_TRANSACTION'), false)
    }
  }
  assert.equal(calls.refresh, 0)
  assert.equal(transactions.list().length, 1)
  const list = await app.inject({
    url: '/v1/transactions',
    headers: { authorization },
  })
  assert.equal(list.statusCode, 200)
  assert.deepEqual(list.json().records[0].data, privatePayload)
  assert.equal(list.headers['cache-control'], 'no-store')
})

test('rotating the key file immediately changes access without restarting HTTP', async context => {
  const { app, config } = await setup(context)
  assert.equal(
    (await app.inject({ url: '/v1/transactions', headers: { authorization } }))
      .statusCode,
    200,
  )
  await setKey(config.ownerKeyHashFile, 'replacement-key')
  assert.equal(
    (await app.inject({ url: '/v1/transactions', headers: { authorization } }))
      .statusCode,
    401,
  )
  assert.equal(
    (
      await app.inject({
        url: '/v1/transactions',
        headers: { authorization: 'Bearer replacement-key' },
      })
    ).statusCode,
    200,
  )
  await writeFile(config.ownerKeyHashFile, 'malformed')
  assert.equal(
    (
      await app.inject({
        url: '/v1/transactions',
        headers: { authorization: 'Bearer replacement-key' },
      })
    ).statusCode,
    401,
  )
  assert.equal((await app.inject('/v1/state')).statusCode, 200)
})

test('HTTP transaction writes enforce ETag preconditions and persist the winning revision', async context => {
  const { app, directory } = await setup(context)
  const url = '/v1/transactions/operation'
  const missingPrecondition = await app.inject({
    method: 'PUT',
    url,
    headers: { authorization },
    payload: privatePayload,
  })
  assert.equal(missingPrecondition.statusCode, 428)
  const created = await app.inject({
    method: 'PUT',
    url,
    headers: { authorization, 'if-none-match': '*' },
    payload: privatePayload,
  })
  assert.equal(created.statusCode, 201)
  const firstTag = String(created.headers.etag)
  assert.equal(firstTag, `"${created.json().revision}"`)
  const duplicate = await app.inject({
    method: 'PUT',
    url,
    headers: { authorization, 'if-none-match': '*' },
    payload: {},
  })
  assert.equal(duplicate.statusCode, 412)
  const read = await app.inject({ url, headers: { authorization } })
  assert.equal(read.headers.etag, firstTag)
  assert.deepEqual(read.json().data, privatePayload)

  const conflictingPreconditions = await app.inject({
    method: 'PUT',
    url,
    headers: { authorization, 'if-match': firstTag, 'if-none-match': '*' },
    payload: {},
  })
  assert.equal(conflictingPreconditions.statusCode, 428)
  const updated = await app.inject({
    method: 'PUT',
    url,
    headers: { authorization, 'if-match': firstTag },
    payload: { status: 'broadcast' },
  })
  assert.equal(updated.statusCode, 200)
  const secondTag = String(updated.headers.etag)
  assert.notEqual(secondTag, firstTag)
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers: { authorization, 'if-match': firstTag },
        payload: {},
      })
    ).statusCode,
    412,
  )

  const attempts = await Promise.all([
    app.inject({
      method: 'PUT',
      url,
      headers: { authorization, 'if-match': secondTag },
      payload: { status: 'confirmed' },
    }),
    app.inject({
      method: 'PUT',
      url,
      headers: { authorization, 'if-match': secondTag },
      payload: { status: 'failed' },
    }),
  ])
  assert.deepEqual(
    attempts.map(response => response.statusCode).sort(),
    [200, 412],
  )
  const winning = attempts.find(response => response.statusCode === 200)
  assert.ok(winning)
  const reopened = await TransactionStore.open(directory)
  assert.deepEqual(reopened.get('operation'), winning.json())
  assert.equal(
    (await app.inject({ method: 'DELETE', url, headers: { authorization } }))
      .statusCode,
    428,
  )
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers: { authorization, 'if-match': secondTag },
      })
    ).statusCode,
    412,
  )
  const deleted = await app.inject({
    method: 'DELETE',
    url,
    headers: { authorization, 'if-match': String(winning.headers.etag) },
  })
  assert.equal(deleted.statusCode, 204)
  assert.equal(deleted.body, '')
  assert.equal(
    (await app.inject({ url, headers: { authorization } })).statusCode,
    404,
  )

  const recreated = await app.inject({
    method: 'PUT',
    url,
    headers: { authorization, 'if-none-match': '*' },
    payload: {},
  })
  assert.equal(recreated.statusCode, 201)
  assert.ok(recreated.json().revision > winning.json().revision)
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers: { authorization, 'if-match': firstTag },
        payload: {},
      })
    ).statusCode,
    412,
  )
})

test('invalid transaction data and oversized request bodies are rejected without storing them', async context => {
  const { app, transactions } = await setup(context)
  const headers = { authorization, 'if-none-match': '*' }
  const invalidId = await app.inject({
    method: 'PUT',
    url: '/v1/transactions/invalid%2Fid',
    headers,
    payload: {},
  })
  assert.equal(invalidId.statusCode, 400)
  const invalidData = await app.inject({
    method: 'PUT',
    url: '/v1/transactions/array',
    headers,
    payload: [],
  })
  assert.equal(invalidData.statusCode, 400)
  const oversized = await app.inject({
    method: 'PUT',
    url: '/v1/transactions/oversized',
    headers,
    payload: { data: 'x'.repeat(1024 * 1024) },
  })
  assert.equal(oversized.statusCode, 413)
  assert.deepEqual(transactions.list(), [])
})

test('manual refresh returns immediately and public status hides RPC credentials after failure', async context => {
  const { app, sync, calls, snapshots } = await setup(context)
  const previous = snapshots.snapshot
  const response = await app.inject({
    method: 'POST',
    url: '/v1/refresh',
    headers: { authorization },
  })
  assert.equal(response.statusCode, 202)
  await sync.idle()
  assert.equal(calls.refresh, 1)
  const status = await app.inject('/v1/status')
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().running, false)
  assert.ok(status.json().lastError)
  assert.equal(status.body.includes('PRIVATE_RPC_TOKEN'), false)
  assert.deepEqual((await app.inject('/v1/state')).json(), previous)
})

test('failed transaction persistence returns 503 and never reports a successful write', async context => {
  const { app, directory } = await setup(context)
  await mkdir(join(directory, 'transactions.json'))
  const response = await app.inject({
    method: 'PUT',
    url: '/v1/transactions/operation',
    headers: { authorization, 'if-none-match': '*' },
    payload: privatePayload,
  })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.includes('PRIVATE_SIGNED_TRANSACTION'), false)
  assert.equal(
    (await app.inject({ url: '/v1/transactions', headers: { authorization } }))
      .statusCode,
    503,
  )
  assert.equal((await app.inject('/v1/state')).statusCode, 200)
})
