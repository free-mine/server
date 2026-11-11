import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { join, dirname, resolve } from 'node:path'
import {
  rm,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'

import { ZodError } from 'zod'

import type { JsonObject } from './types.js'
import { TransactionStore } from './transactions.js'
import { atomicWrite, readOptional } from './files.js'
import { StorageConflictError, StorageUnavailableError } from './errors.js'

async function temporaryDirectory(context: TestContext): Promise<string> {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'free-mine-storage-'))
  context.after(async () => {
    assert.equal(dirname(resolve(directory)), parent)
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

test('atomic writes replace complete contents and clean temporary files', async context => {
  const directory = await temporaryDirectory(context)
  const path = join(directory, 'snapshot.json')
  assert.equal(await readOptional(path), undefined)
  await atomicWrite(path, 'old state')
  await atomicWrite(path, new TextEncoder().encode('new state'))
  assert.equal((await readOptional(path))?.toString(), 'new state')
  assert.deepEqual(await readdir(directory), ['snapshot.json'])
  await assert.rejects(readOptional(directory))
})

test('failed atomic writes clean temporary files without replacing destination', async context => {
  const directory = await temporaryDirectory(context)
  const path = join(directory, 'occupied')
  await mkdir(path)
  await assert.rejects(atomicWrite(path, 'state'))
  assert.deepEqual(await readdir(directory), ['occupied'])
  assert.deepEqual(await readdir(path), [])
})

test('transactions persist across restart and isolate mutable caller data', async context => {
  const directory = await temporaryDirectory(context)
  const store = await TransactionStore.open(directory)
  assert.deepEqual(store.list(), [])
  const data: JsonObject = {
    status: 'prepared',
    amount: '123456789012345678901234567890',
    steps: [{ transaction: '0xsigned', successful: false, receipt: null }],
  }
  const pending = store.put('operation:1', data, null)
  data.status = 'mutated by caller'
  const created = await pending
  assert.equal(created.revision, 1)
  assert.equal(created.data.status, 'prepared')
  created.data.status = 'mutated response'
  assert.equal(store.get('operation:1')?.data.status, 'prepared')

  const record = store.get('operation:1')
  assert.ok(record)
  record.data.steps = []
  const list = store.list()
  list.length = 0
  const reopened = await TransactionStore.open(directory)
  assert.deepEqual(reopened.list(), store.list())
  assert.equal(reopened.get('operation:1')?.data.status, 'prepared')
  assert.equal(reopened.get('missing'), undefined)
})

test('concurrent writers use compare-and-swap and conflicts do not block later writes', async context => {
  const directory = await temporaryDirectory(context)
  const store = await TransactionStore.open(directory)
  const created = await store.put('operation', { status: 'prepared' }, null)
  const results = await Promise.allSettled([
    store.put('operation', { status: 'broadcast' }, created.revision),
    store.put('operation', { status: 'cancelled' }, created.revision),
  ])
  assert.equal(
    results.filter(result => result.status === 'fulfilled').length,
    1,
  )
  const rejected = results.find(result => result.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.ok(rejected.reason instanceof StorageConflictError)
  const current = store.get('operation')
  assert.ok(current)
  assert.equal(current.data.status, 'broadcast')
  const next = await store.put(
    'operation',
    { status: 'confirmed' },
    current.revision,
  )
  assert.equal(next.data.status, 'confirmed')

  await Promise.all([
    store.put('independent-1', {}, null),
    store.put('independent-2', {}, null),
  ])
  const reopened = await TransactionStore.open(directory)
  assert.equal(reopened.list().length, 3)
  assert.equal(new Set(reopened.list().map(value => value.revision)).size, 3)
})

test('delete and recreate never reuses a revision, including across restarts', async context => {
  const directory = await temporaryDirectory(context)
  const store = await TransactionStore.open(directory)
  const original = await store.put('operation', { status: 'old' }, null)
  await assert.rejects(store.put('operation', {}, null), StorageConflictError)
  await store.delete('operation', original.revision)
  assert.equal(store.get('operation'), undefined)
  const reopened = await TransactionStore.open(directory)
  const replacement = await reopened.put('operation', { status: 'new' }, null)
  assert.ok(replacement.revision > original.revision)
  await assert.rejects(
    reopened.put('operation', {}, original.revision),
    StorageConflictError,
  )
  await assert.rejects(
    reopened.delete('operation', original.revision),
    StorageConflictError,
  )
  assert.equal(reopened.get('operation')?.data.status, 'new')
})

test('invalid input cannot create records or alter persisted data', async context => {
  const directory = await temporaryDirectory(context)
  const store = await TransactionStore.open(directory)
  for (const id of ['', '../escape', 'a/b', 'a\n', 'a'.repeat(129)]) {
    await assert.rejects(store.put(id, {}, null), ZodError)
  }
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.put('record', {}, revision), ZodError)
  }
  for (const data of [
    [],
    null,
    { amount: NaN },
    { nested: { amount: undefined } },
  ]) {
    await assert.rejects(store.put('record', data, null), ZodError)
  }
  assert.deepEqual(store.list(), [])
  assert.equal(
    await readOptional(join(directory, 'transactions.json')),
    undefined,
  )
})

test('corrupt transaction files fail startup instead of silently resetting data', async context => {
  const directory = await temporaryDirectory(context)
  const path = join(directory, 'transactions.json')
  await writeFile(path, '{broken')
  await assert.rejects(TransactionStore.open(directory))

  const record = {
    id: 'operation',
    revision: 1,
    updatedAt: new Date().toISOString(),
    data: {},
  }
  for (const state of [
    { format: 2, nextRevision: 2, records: [record] },
    { format: 1, nextRevision: 1, records: [record] },
    {
      format: 1,
      nextRevision: 3,
      records: [record, { ...record, revision: 2 }],
    },
    {
      format: 1,
      nextRevision: 2,
      records: [record, { ...record, id: 'another' }],
    },
  ]) {
    await writeFile(path, JSON.stringify(state))
    await assert.rejects(TransactionStore.open(directory))
  }
})

test('failed persistence rejects success and stops use of uncertain in-memory state', async context => {
  const directory = await temporaryDirectory(context)
  const store = await TransactionStore.open(directory)
  await mkdir(join(directory, 'transactions.json'))
  await assert.rejects(store.put('record', {}, null), StorageUnavailableError)
  assert.throws(() => store.list(), StorageUnavailableError)
  assert.throws(() => store.get('record'), StorageUnavailableError)
  await assert.rejects(store.put('other', {}, null), StorageUnavailableError)
  assert.deepEqual(await readdir(directory), ['transactions.json'])
})

test('persisted file contains the complete record before a write returns', async context => {
  const directory = await temporaryDirectory(context)
  const store = await TransactionStore.open(directory)
  const record = await store.put('record', { status: 'submitted' }, null)
  const state = JSON.parse(
    await readFile(join(directory, 'transactions.json'), 'utf8'),
  )
  assert.deepEqual(state, { format: 1, nextRevision: 2, records: [record] })
})
