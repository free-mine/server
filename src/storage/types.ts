import type { z } from 'zod'

import type {
  transactionDataSchema,
  transactionFileSchema,
} from './validation.js'

export type JsonObject = z.infer<typeof transactionDataSchema>
export type TransactionFile = z.infer<typeof transactionFileSchema>
export type TransactionRecord = TransactionFile['records'][number]
