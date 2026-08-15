export type MediaApplicationErrorCode =
  | 'NOT_FOUND'
  | 'MEDIA_ASSET_IN_USE'
  | 'MEDIA_ASSET_NOT_READY'
  | 'MEDIA_UPLOAD_EXPIRED'
  | 'MEDIA_STATE_CONFLICT'
  | 'MEDIA_CONTENT_REJECTED';

export class MediaApplicationError extends Error {
  constructor(readonly code: MediaApplicationErrorCode) {
    super(code);
  }
}
