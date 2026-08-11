declare const objectStorageKeyBrand: unique symbol;

export const OBJECT_STORAGE = Symbol('ObjectStorage');
export const OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS = 300;
export const OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION =
  'object-must-not-exist';

export type ObjectStorageKey = string & {
  readonly [objectStorageKeyBrand]: true;
};

export type MediaObjectOwner =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'import'; readonly batchId: string };

export interface ProjectMediaObjectKeyInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly safeName: string;
}

export interface ImportMediaObjectKeyInput {
  readonly workspaceId: string;
  readonly batchId: string;
  readonly assetId: string;
  readonly safeName: string;
}

export interface PresignedPutInput {
  readonly key: ObjectStorageKey;
  readonly contentLength: number;
  readonly contentType: string;
  readonly expiresInSeconds: typeof OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS;
  readonly writeCondition: typeof OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION;
}

export interface PresignedPut {
  readonly url: string;
  readonly method: 'PUT';
  readonly requiredHeaders: Readonly<Record<string, string>> & {
    readonly 'if-none-match': '*';
  };
  readonly expiresAt: Date;
}

export interface StoredObjectMetadata {
  readonly contentLength: number;
  readonly contentType: string | null;
}

export type ObjectHeadResult =
  | {
      readonly kind: 'found';
      readonly metadata: StoredObjectMetadata;
    }
  | { readonly kind: 'not-found' };

export interface BoundedObjectReadInput {
  readonly key: ObjectStorageKey;
  readonly maxBytes: number;
}

export type BoundedObjectReadResult =
  | {
      readonly kind: 'found';
      readonly metadata: StoredObjectMetadata;
      readonly body: AsyncIterable<Uint8Array>;
    }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'too-large';
      readonly contentLength: number;
    };

export interface ObjectStorage {
  createPresignedPut(input: PresignedPutInput): Promise<PresignedPut>;
  head(key: ObjectStorageKey): Promise<ObjectHeadResult>;
  readBounded(input: BoundedObjectReadInput): Promise<BoundedObjectReadResult>;
  delete(key: ObjectStorageKey): Promise<void>;
}

export function buildProjectMediaObjectKey(
  input: ProjectMediaObjectKeyInput,
): ObjectStorageKey {
  return buildObjectStorageKey([
    'workspaces',
    input.workspaceId,
    'projects',
    input.projectId,
    input.assetId,
    input.safeName,
  ]);
}

export function buildImportMediaObjectKey(
  input: ImportMediaObjectKeyInput,
): ObjectStorageKey {
  return buildObjectStorageKey([
    'workspaces',
    input.workspaceId,
    'imports',
    input.batchId,
    input.assetId,
    input.safeName,
  ]);
}

export function restorePersistedMediaObjectKey(input: {
  readonly key: string;
  readonly workspaceId: string;
  readonly assetId: string;
  readonly owner: MediaObjectOwner;
}): ObjectStorageKey {
  const segments = input.key.split('/');
  const ownerSegments =
    input.owner.kind === 'project'
      ? ['projects', input.owner.projectId]
      : ['imports', input.owner.batchId];
  const expected = [
    'workspaces',
    input.workspaceId,
    ...ownerSegments,
    input.assetId,
  ];
  if (
    segments.length !== expected.length + 1 ||
    !expected.every((segment, index) => segments[index] === segment) ||
    segments.some((segment) => !isSafeObjectKeySegment(segment))
  ) {
    throw new Error('Stored media object key does not match ownership');
  }
  return input.key as ObjectStorageKey;
}

function buildObjectStorageKey(segments: readonly string[]): ObjectStorageKey {
  for (const segment of segments) {
    assertSafeObjectKeySegment(segment);
  }
  return segments.join('/') as ObjectStorageKey;
}

function assertSafeObjectKeySegment(segment: string): void {
  if (!isSafeObjectKeySegment(segment)) {
    throw new TypeError(
      'Object-storage key segments must be safe path segments',
    );
  }
}

function isSafeObjectKeySegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !hasUnsafeObjectKeyCharacter(segment)
  );
}

function hasUnsafeObjectKeyCharacter(segment: string): boolean {
  for (const character of segment) {
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
