export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_MAX_DIMENSION = 12_000;
export const MEDIA_MAX_PIXELS = 40_000_000;

export type MediaAssetStatus = 'PENDING' | 'READY' | 'DELETING';
export type MediaMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface MediaDeclaration {
  readonly fileName: string;
  readonly mimeType: MediaMimeType;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

export interface MediaVerification {
  readonly mimeType: MediaMimeType;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
  readonly verifiedAt: Date;
}

export interface MediaInspection {
  readonly mimeType: MediaMimeType;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
}

export interface MediaAsset {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly importBatchId: string | null;
  readonly status: MediaAssetStatus;
  readonly objectKey: string;
  readonly declaration: MediaDeclaration;
  readonly verification: MediaVerification | null;
  readonly deletionMarkedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type MediaVerificationResult =
  | { readonly ok: true; readonly value: MediaInspection }
  | {
      readonly ok: false;
      readonly code:
        | 'content-mismatch'
        | 'extension-mismatch'
        | 'image-dimensions-exceeded'
        | 'invalid-image'
        | 'media-too-large';
    };

export function validateMediaInspection(
  declaration: MediaDeclaration,
  inspection: MediaInspection,
): MediaVerificationResult {
  if (
    inspection.mimeType !== declaration.mimeType ||
    inspection.sizeBytes !== declaration.sizeBytes ||
    inspection.checksumSha256 !== declaration.checksumSha256
  ) {
    return { ok: false, code: 'content-mismatch' };
  }
  if (!extensionMatches(declaration.fileName, inspection.mimeType)) {
    return { ok: false, code: 'extension-mismatch' };
  }
  if (
    !Number.isInteger(inspection.width) ||
    !Number.isInteger(inspection.height) ||
    inspection.width < 1 ||
    inspection.height < 1
  ) {
    return { ok: false, code: 'invalid-image' };
  }
  if (
    inspection.width > MEDIA_MAX_DIMENSION ||
    inspection.height > MEDIA_MAX_DIMENSION ||
    inspection.width * inspection.height > MEDIA_MAX_PIXELS
  ) {
    return { ok: false, code: 'image-dimensions-exceeded' };
  }
  return { ok: true, value: inspection };
}

function extensionMatches(fileName: string, mimeType: MediaMimeType): boolean {
  const normalized = fileName.toLowerCase();
  if (mimeType === 'image/jpeg') {
    return normalized.endsWith('.jpg') || normalized.endsWith('.jpeg');
  }
  return normalized.endsWith(mimeType === 'image/png' ? '.png' : '.webp');
}
