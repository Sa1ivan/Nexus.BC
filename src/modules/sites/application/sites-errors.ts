export type SitesApplicationErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PROJECT_VERSION_CONFLICT';

export class SitesApplicationError extends Error {
  constructor(
    readonly code: SitesApplicationErrorCode,
    readonly currentDraftVersion?: number,
  ) {
    super(code);
  }
}

export class InvalidSiteCursorError extends Error {
  constructor() {
    super('invalid cursor');
  }
}
