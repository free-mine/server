export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject

export interface JsonObject {
  [key: string]: JsonValue
}

export interface TransactionRecord {
  id: string
  revision: number
  data: JsonObject
  updatedAt: string
}

export interface TransactionFile {
  format: 1
  nextRevision: number
  records: TransactionRecord[]
}
