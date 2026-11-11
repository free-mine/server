import { z } from 'zod'

export const transactionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  .refine(value => value.trim() === value)

export const transactionRevisionSchema = z.number().int().positive().safe()
export const transactionDataSchema = z.record(z.string(), z.json())

const transactionRecordSchema = z.strictObject({
  id: transactionIdSchema,
  revision: transactionRevisionSchema,
  updatedAt: z.iso.datetime(),
  data: transactionDataSchema,
})

export const transactionFileSchema = z
  .strictObject({
    format: z.literal(1),
    nextRevision: transactionRevisionSchema,
    records: z.array(transactionRecordSchema),
  })
  .superRefine((file, context) => {
    const ids = new Set<string>()
    const revisions = new Set<number>()
    for (const record of file.records) {
      if (
        ids.has(record.id) ||
        revisions.has(record.revision) ||
        record.revision >= file.nextRevision
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Transaction IDs and revisions must be unique and revisions must precede nextRevision',
        })
        return
      }
      ids.add(record.id)
      revisions.add(record.revision)
    }
  })
