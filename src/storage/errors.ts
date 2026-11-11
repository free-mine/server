export class StorageConflictError extends Error {
  constructor() {
    super('The transaction revision has changed')
    this.name = 'StorageConflictError'
  }
}

export class StorageUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'Transaction storage is unavailable; restart after fixing the storage error',
      options,
    )
    this.name = 'StorageUnavailableError'
  }
}
