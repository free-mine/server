import { z } from 'zod'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { FastifyRequest } from 'fastify'

import type { HttpOptions } from './types.js'
import { verifyOwnerKey } from '../auth/index.js'
import {
  StorageConflictError,
  StorageValidationError,
  StorageUnavailableError,
} from '../storage/index.js'

const transactionParams = z.object({ id: z.string() })
const transactionData = z.record(z.string(), z.json())

function revision(
  request: FastifyRequest,
  allowCreate: boolean,
): number | null {
  const match = request.headers['if-match']
  const noneMatch = request.headers['if-none-match']
  if (allowCreate && noneMatch === '*' && match === undefined) {
    return null
  }
  if (
    noneMatch !== undefined ||
    typeof match !== 'string' ||
    !/^"[1-9][0-9]*"$/.test(match)
  ) {
    throw Object.assign(
      new Error(
        'Use If-None-Match: * to create, or If-Match: "revision" to update/delete',
      ),
      { statusCode: 428 },
    )
  }
  return z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(Number(match.slice(1, -1)))
}

export function createServer(options: HttpOptions) {
  const { config, snapshots, transactions, sync } = options
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
    logger: options.logger ? { redact: ['req.headers.authorization'] } : false,
  })
  app.register(cors, {
    origin: '*',
    exposedHeaders: ['ETag', 'Content-Disposition'],
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof StorageConflictError) {
      return reply.code(412).send({
        error:
          'Revision changed or record does not exist; read the current record and retry',
      })
    }
    if (
      error instanceof z.ZodError ||
      error instanceof StorageValidationError
    ) {
      return reply.code(400).send({ error: 'Invalid request data' })
    }
    if (error instanceof StorageUnavailableError) {
      return reply.code(503).send({
        error:
          'Transaction storage is unavailable; restart after checking the data volume',
      })
    }
    const status =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({
        error:
          status === 428 && error instanceof Error
            ? error.message
            : 'Invalid request',
      })
    }
    request.log.error('Request failed')
    return reply.code(500).send({ error: 'Internal server error' })
  })

  app.get('/health', () => ({ status: 'ok' }))
  app.get('/ready', (_request, reply) => {
    return reply
      .code(snapshots.snapshot ? 200 : 503)
      .send({ ready: Boolean(snapshots.snapshot) })
  })
  app.get('/v1/status', () => ({
    ...sync.status,
    block: snapshots.snapshot?.block ?? null,
    updatedAt: snapshots.snapshot?.updatedAt ?? null,
    intervalMs: config.syncIntervalMs,
  }))
  app.get('/v1/state', (_request, reply) => {
    const snapshot = snapshots.snapshot
    return snapshot
      ? reply.header('Cache-Control', 'no-cache').send(snapshot)
      : reply
          .code(503)
          .send({ error: 'Initial synchronization has not completed' })
  })
  app.get('/v1/fund', (_request, reply) => {
    const snapshot = snapshots.snapshot
    return snapshot
      ? reply
          .header('Cache-Control', 'no-cache')
          .send({ block: snapshot.block, data: snapshot.fund })
      : reply
          .code(503)
          .send({ error: 'Initial synchronization has not completed' })
  })
  app.get('/v1/portfolio', (_request, reply) => {
    const snapshot = snapshots.snapshot
    return snapshot
      ? reply
          .header('Cache-Control', 'no-cache')
          .send({ block: snapshot.block, data: snapshot.portfolio })
      : reply
          .code(503)
          .send({ error: 'Initial synchronization has not completed' })
  })
  app.get('/v1/backup', (_request, reply) => {
    const data = snapshots.backup
    return data
      ? reply
          .type('application/gzip')
          .header('Cache-Control', 'no-cache')
          .header(
            'Content-Disposition',
            'attachment; filename="free-mine-backup.json.gz"',
          )
          .send(data)
      : reply
          .code(503)
          .send({ error: 'Initial synchronization has not completed' })
  })

  app.register(async owner => {
    owner.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      if (
        !(await verifyOwnerKey(
          request.headers.authorization,
          config.ownerKeyHashFile,
        ))
      ) {
        return reply
          .header('WWW-Authenticate', 'Bearer')
          .code(401)
          .send({ error: 'Unauthorized' })
      }
    })
    owner.post('/v1/refresh', (_request, reply) => {
      void sync
        .refresh()
        .catch(() =>
          app.log.warn('Synchronization failed; previous snapshot retained'),
        )
      return reply.code(202).send({ status: 'accepted', ...sync.status })
    })
    owner.get('/v1/transactions', () => ({ records: transactions.list() }))
    owner.get('/v1/transactions/:id', (request, reply) => {
      const { id } = transactionParams.parse(request.params)
      const record = transactions.get(id)
      return record
        ? reply.header('ETag', `"${record.revision}"`).send(record)
        : reply.code(404).send({ error: 'Record not found' })
    })
    owner.put('/v1/transactions/:id', async (request, reply) => {
      const { id } = transactionParams.parse(request.params)
      const expected = revision(request, true)
      const record = await transactions.put(
        id,
        transactionData.parse(request.body),
        expected,
      )
      return reply
        .code(expected === null ? 201 : 200)
        .header('ETag', `"${record.revision}"`)
        .send(record)
    })
    owner.delete('/v1/transactions/:id', async (request, reply) => {
      const { id } = transactionParams.parse(request.params)
      const expected = revision(request, false)
      if (expected === null) {
        throw new StorageValidationError('A revision is required for deletion')
      }
      await transactions.delete(id, expected)
      return reply.code(204).send()
    })
  })
  return app
}
