import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  OBJECT_STORAGE,
  OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION,
  OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS,
  buildImportMediaObjectKey,
  buildProjectMediaObjectKey,
  restorePersistedMediaObjectKey,
  type BoundedObjectReadResult,
  type ObjectHeadResult,
  type ObjectStorage,
  type PresignedPutInput,
} from '../../src/modules/media/application/ports/object-storage';

describe('object storage application port contract', () => {
  it('generates server-owned project and unattached import object keys', () => {
    expect(
      buildProjectMediaObjectKey({
        workspaceId: 'workspace-id',
        projectId: 'project-id',
        assetId: 'asset-id',
        safeName: 'hero-image.webp',
      }),
    ).toBe(
      'workspaces/workspace-id/projects/project-id/asset-id/hero-image.webp',
    );
    expect(
      buildImportMediaObjectKey({
        workspaceId: 'workspace-id',
        batchId: 'batch-id',
        assetId: 'asset-id',
        safeName: 'legacy-image.png',
      }),
    ).toBe(
      'workspaces/workspace-id/imports/batch-id/asset-id/legacy-image.png',
    );
  });

  it.each(['', '.', '..', 'nested/name.png', 'nested\\name.png', 'bad\0name'])(
    'rejects unsafe object-key segment %p',
    (unsafeSegment) => {
      expect(() =>
        buildProjectMediaObjectKey({
          workspaceId: 'workspace-id',
          projectId: 'project-id',
          assetId: 'asset-id',
          safeName: unsafeSegment,
        }),
      ).toThrow(TypeError);
    },
  );

  it('restores only persisted keys that match the requested asset ownership', () => {
    const key = buildProjectMediaObjectKey({
      workspaceId: 'workspace-id',
      projectId: 'project-id',
      assetId: 'asset-id',
      safeName: 'hero.png',
    });

    expect(
      restorePersistedMediaObjectKey({
        key,
        workspaceId: 'workspace-id',
        assetId: 'asset-id',
        owner: { kind: 'project', projectId: 'project-id' },
      }),
    ).toBe(key);
    expect(() =>
      restorePersistedMediaObjectKey({
        key,
        workspaceId: 'foreign-workspace',
        assetId: 'asset-id',
        owner: { kind: 'project', projectId: 'project-id' },
      }),
    ).toThrow('does not match ownership');
  });

  it('defines the exact five-minute provider-neutral operation surface', async () => {
    const key = buildProjectMediaObjectKey({
      workspaceId: 'workspace-id',
      projectId: 'project-id',
      assetId: 'asset-id',
      safeName: 'hero-image.webp',
    });
    const body: AsyncIterable<Uint8Array> = Readable.from([
      Uint8Array.from([0x52, 0x49, 0x46, 0x46]),
    ]);
    const storage: ObjectStorage = {
      createPresignedPut: () =>
        Promise.resolve({
          url: 'https://storage.example.test/signed-upload',
          method: 'PUT' as const,
          requiredHeaders: Object.freeze({
            'content-type': 'image/webp',
            'if-none-match': '*' as const,
          }),
          expiresAt: new Date('2026-08-11T12:05:00.000Z'),
        }),
      head: () =>
        Promise.resolve({
          kind: 'found' as const,
          metadata: {
            contentLength: 4,
            contentType: 'image/webp',
          },
        }),
      readBounded: () =>
        Promise.resolve({
          kind: 'found' as const,
          metadata: {
            contentLength: 4,
            contentType: 'image/webp',
          },
          body,
        }),
      delete: () => Promise.resolve(),
    };

    const presigned = await storage.createPresignedPut({
      key,
      contentLength: 4,
      contentType: 'image/webp',
      expiresInSeconds: OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS,
      writeCondition: OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION,
    });
    const head = await storage.head(key);
    const read = await storage.readBounded({ key, maxBytes: 10 });
    await storage.delete(key);

    expect(OBJECT_STORAGE).toEqual(expect.any(Symbol));
    expect(OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION).toBe(
      'object-must-not-exist',
    );
    expect(OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS).toBe(300);
    expect(Object.keys(storage)).toEqual([
      'createPresignedPut',
      'head',
      'readBounded',
      'delete',
    ]);
    expect(presigned).toEqual({
      url: 'https://storage.example.test/signed-upload',
      method: 'PUT',
      requiredHeaders: {
        'content-type': 'image/webp',
        'if-none-match': '*',
      },
      expiresAt: new Date('2026-08-11T12:05:00.000Z'),
    });
    expect(head).toEqual({
      kind: 'found',
      metadata: { contentLength: 4, contentType: 'image/webp' },
    });
    expect(read).toMatchObject({
      kind: 'found',
      metadata: { contentLength: 4, contentType: 'image/webp' },
    });
  });

  it('requires generated keys and the exact upload TTL at the type boundary', () => {
    const invalidRawKey = (): PresignedPutInput => ({
      // @ts-expect-error Object keys are generated by server-owned builders.
      key: 'caller-supplied-key',
      contentLength: 4,
      contentType: 'image/webp',
      expiresInSeconds: OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS,
      writeCondition: OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION,
    });
    const invalidTtl = (): PresignedPutInput => ({
      key: buildProjectMediaObjectKey({
        workspaceId: 'workspace-id',
        projectId: 'project-id',
        assetId: 'asset-id',
        safeName: 'hero-image.webp',
      }),
      contentLength: 4,
      contentType: 'image/webp',
      // @ts-expect-error Presigned PUT URLs expire in exactly five minutes.
      expiresInSeconds: 299,
      writeCondition: OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION,
    });
    const invalidWriteCondition = (): PresignedPutInput => ({
      key: buildProjectMediaObjectKey({
        workspaceId: 'workspace-id',
        projectId: 'project-id',
        assetId: 'asset-id',
        safeName: 'hero-image.webp',
      }),
      contentLength: 4,
      contentType: 'image/webp',
      expiresInSeconds: OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS,
      // @ts-expect-error Upload grants must never permit overwriting READY bytes.
      writeCondition: 'overwrite-allowed',
    });

    expect(invalidRawKey).toEqual(expect.any(Function));
    expect(invalidTtl).toEqual(expect.any(Function));
    expect(invalidWriteCondition).toEqual(expect.any(Function));
  });

  it('models missing and oversized objects without provider error values', () => {
    const missingHead = { kind: 'not-found' } satisfies ObjectHeadResult;
    const missingRead = {
      kind: 'not-found',
    } satisfies BoundedObjectReadResult;
    const oversizedRead = {
      kind: 'too-large',
      contentLength: 10_485_761,
    } satisfies BoundedObjectReadResult;

    expect(missingHead).toEqual({ kind: 'not-found' });
    expect(missingRead).toEqual({ kind: 'not-found' });
    expect(oversizedRead).toEqual({
      kind: 'too-large',
      contentLength: 10_485_761,
    });
  });

  it('contains no provider SDK or provider-specific storage values', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'src/modules/media/application/ports/object-storage.ts',
      ),
      'utf8',
    );

    expect(source).not.toMatch(
      /@aws-sdk|\b(?:R2|S3Client|PutObjectCommand|HeadObjectCommand|DeleteObjectCommand|Bucket|ETag)\b/u,
    );
  });
});
