import { throwRequestValidationError } from './request-contract';

const mediaMaxBytes = 10 * 1024 * 1024;

function hasUnsafeFileNameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      character === '/' ||
      character === '\\' ||
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

export interface MediaUploadRequest {
  readonly fileName: string;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

export function requireMediaUploadRequest(input: {
  readonly fileName: unknown;
  readonly mimeType: unknown;
  readonly sizeBytes: unknown;
  readonly checksumSha256: unknown;
}): MediaUploadRequest {
  if (
    typeof input.fileName !== 'string' ||
    input.fileName.length < 1 ||
    input.fileName.length > 256 ||
    input.fileName !== input.fileName.trim() ||
    input.fileName !== input.fileName.normalize('NFC') ||
    hasUnsafeFileNameCharacter(input.fileName) ||
    typeof input.mimeType !== 'string' ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(input.mimeType) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    Number(input.sizeBytes) < 1 ||
    Number(input.sizeBytes) > mediaMaxBytes ||
    typeof input.checksumSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.checksumSha256)
  ) {
    throwRequestValidationError();
  }
  const lowerName = input.fileName.toLowerCase();
  const extensionMatches =
    input.mimeType === 'image/jpeg'
      ? lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')
      : lowerName.endsWith(input.mimeType === 'image/png' ? '.png' : '.webp');
  if (!extensionMatches) throwRequestValidationError();
  return {
    fileName: input.fileName,
    mimeType: input.mimeType as MediaUploadRequest['mimeType'],
    sizeBytes: Number(input.sizeBytes),
    checksumSha256: input.checksumSha256,
  };
}
