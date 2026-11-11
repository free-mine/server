import { join } from 'node:path'

import { atomicWrite, readOptional } from './files.js'
import { StorageConflictError, StorageUnavailableError } from './errors.js'
import type { JsonObject, TransactionFile, TransactionRecord } from './types.js'
import {
  validateInput,
  transactionIdSchema,
  transactionDataSchema,
  transactionFileSchema,
  transactionRevisionSchema,
} from './validation.js'

export class TransactionStore {
  private pending: Promise<void> = Promise.resolve()
  private failed = false

  private constructor(
    private readonly path: string,
    private state: TransactionFile,
  ) {}

  static async open(directory: string): Promise<TransactionStore> {
    const path = join(directory, 'transactions.json')
    const contents = await readOptional(path)
    const state: TransactionFile = contents
      ? transactionFileSchema.parse(JSON.parse(contents.toString('utf8')))
      : { format: 1, nextRevision: 1, records: [] }
    return new TransactionStore(path, state)
  }

  list(): TransactionRecord[] {
    this.assertAvailable()
    return structuredClone(this.state.records)
  }

  get(id: string): TransactionRecord | undefined {
    this.assertAvailable()
    validateInput(transactionIdSchema, id)
    const record = this.state.records.find(record => record.id === id)
    return record ? structuredClone(record) : undefined
  }

  async put(
    id: string,
    data: JsonObject,
    expectedRevision: number | null,
  ): Promise<TransactionRecord> {
    validateInput(transactionIdSchema, id)
    const parsed = validateInput(transactionDataSchema, data)
    if (expectedRevision !== null) {
      validateInput(transactionRevisionSchema, expectedRevision)
    }

    return this.serialize(async () => {
      this.assertAvailable()
      const existing = this.state.records.find(record => record.id === id)
      if ((existing?.revision ?? null) !== expectedRevision) {
        throw new StorageConflictError()
      }
      if (this.state.nextRevision >= Number.MAX_SAFE_INTEGER) {
        throw new StorageUnavailableError()
      }

      const record: TransactionRecord = {
        id,
        revision: this.state.nextRevision,
        updatedAt: new Date().toISOString(),
        data: parsed,
      }
      const next: TransactionFile = {
        format: 1,
        nextRevision: this.state.nextRevision + 1,
        records: [
          ...this.state.records.filter(value => value.id !== id),
          record,
        ],
      }
      await this.persist(next)
      return structuredClone(record)
    })
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    validateInput(transactionIdSchema, id)
    validateInput(transactionRevisionSchema, expectedRevision)

    return this.serialize(async () => {
      this.assertAvailable()
      const existing = this.state.records.find(record => record.id === id)
      if (existing?.revision !== expectedRevision) {
        throw new StorageConflictError()
      }
      await this.persist({
        ...this.state,
        records: this.state.records.filter(record => record.id !== id),
      })
    })
  }

  private assertAvailable(): void {
    if (this.failed) {
      throw new StorageUnavailableError()
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(action)
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async persist(next: TransactionFile): Promise<void> {
    try {
      await atomicWrite(this.path, JSON.stringify(next))
    } catch (cause) {
      // A directory fsync can fail after rename. Stop serving state whose
      // persistence is uncertain, and require a fresh read from disk on restart.
      this.failed = true
      throw new StorageUnavailableError({ cause })
    }
    this.state = next
  }
}
