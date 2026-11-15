import type { z } from 'zod'

import type { snapshotSchema } from './schema.js'

export type PublicSnapshot = z.infer<typeof snapshotSchema>

export interface StoredSnapshot {
  backup: Buffer
  snapshot: PublicSnapshot
}
