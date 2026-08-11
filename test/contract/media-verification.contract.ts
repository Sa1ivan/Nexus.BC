import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  MEDIA_MAX_BYTES,
  MEDIA_MAX_DIMENSION,
  MEDIA_MAX_PIXELS,
  type MediaAsset,
  type MediaDeclaration,
  validateMediaInspection,
} from '../../src/modules/media/domain/media-asset';
import type { MediaImportBatch } from '../../src/modules/media/domain/media-import-batch';
import { verifyMediaContent } from '../../src/modules/media/application/verify-media-content';
import { SharpMediaInspector } from '../../src/modules/media/infrastructure/sharp-media-inspector';

const fixtures = {
  jpeg: Buffer.from(
    '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z',
    'base64',
  ),
  png: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
  webp: Buffer.from(
    'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
    'base64',
  ),
} as const;

function declaration(
  bytes: Uint8Array,
  input: {
    readonly fileName: string;
    readonly mimeType: MediaDeclaration['mimeType'];
  },
): MediaDeclaration {
  return {
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: bytes.byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function body(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const split = Math.max(1, Math.floor(bytes.byteLength / 2));
  return Readable.from([bytes.slice(0, split), bytes.slice(split)]);
}

describe('managed media verification contract', () => {
  const inspector = new SharpMediaInspector();

  it.each([
    ['jpeg', 'photo.jpeg', 'image/jpeg'],
    ['png', 'photo.png', 'image/png'],
    ['webp', 'photo.webp', 'image/webp'],
  ] as const)(
    'verifies streamed %s bytes from server evidence',
    async (fixtureName, fileName, mimeType) => {
      const bytes = fixtures[fixtureName];
      const result = await verifyMediaContent(
        {
          declaration: declaration(bytes, { fileName, mimeType }),
          body: body(bytes),
        },
        inspector,
      );

      expect(result).toEqual({
        ok: true,
        value: {
          mimeType,
          sizeBytes: bytes.byteLength,
          width: 1,
          height: 1,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        },
      });
    },
  );

  it.each([
    ['wrong declared MIME', { mimeType: 'image/jpeg' }, 'content-mismatch'],
    ['wrong extension', { fileName: 'photo.jpg' }, 'extension-mismatch'],
    [
      'wrong size',
      { sizeBytes: fixtures.png.byteLength + 1 },
      'content-mismatch',
    ],
    ['wrong checksum', { checksumSha256: 'b'.repeat(64) }, 'content-mismatch'],
  ] as const)('rejects %s', async (_name, override, code) => {
    const bytes = fixtures.png;
    const result = await verifyMediaContent(
      {
        declaration: {
          ...declaration(bytes, {
            fileName: 'photo.png',
            mimeType: 'image/png',
          }),
          ...override,
        },
        body: body(bytes),
      },
      inspector,
    );

    expect(result).toEqual({ ok: false, code });
  });

  it('rejects corrupt and unsupported bytes', async () => {
    const bytes = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const result = await verifyMediaContent(
      {
        declaration: declaration(bytes, {
          fileName: 'photo.png',
          mimeType: 'image/png',
        }),
        body: body(bytes),
      },
      inspector,
    );

    expect(result).toEqual({ ok: false, code: 'invalid-image' });
  });

  it('stops after the first byte above the ten MiB bound', async () => {
    const bytes = new Uint8Array(MEDIA_MAX_BYTES + 1);
    const result = await verifyMediaContent(
      {
        declaration: {
          fileName: 'large.png',
          mimeType: 'image/png',
          sizeBytes: MEDIA_MAX_BYTES,
          checksumSha256: 'a'.repeat(64),
        },
        body: body(bytes),
      },
      inspector,
    );

    expect(result).toEqual({ ok: false, code: 'media-too-large' });
  });

  it('enforces exact dimension and decoded-pixel limits', () => {
    const declared: MediaDeclaration = {
      fileName: 'photo.webp',
      mimeType: 'image/webp',
      sizeBytes: 4,
      checksumSha256: 'a'.repeat(64),
    };

    expect(
      validateMediaInspection(declared, {
        mimeType: 'image/webp',
        sizeBytes: 4,
        checksumSha256: 'a'.repeat(64),
        width: MEDIA_MAX_DIMENSION + 1,
        height: 1,
      }),
    ).toEqual({ ok: false, code: 'image-dimensions-exceeded' });
    expect(
      validateMediaInspection(declared, {
        mimeType: 'image/webp',
        sizeBytes: 4,
        checksumSha256: 'a'.repeat(64),
        width: 8_000,
        height: Math.floor(MEDIA_MAX_PIXELS / 8_000) + 1,
      }),
    ).toEqual({ ok: false, code: 'image-dimensions-exceeded' });
  });

  it('owns readonly MediaAsset and MediaImportBatch metadata', () => {
    const now = new Date('2026-08-11T12:00:00.000Z');
    const asset: MediaAsset = Object.freeze({
      id: 'asset-id',
      workspaceId: 'workspace-id',
      projectId: 'project-id',
      importBatchId: null,
      status: 'READY',
      objectKey: 'workspaces/workspace-id/projects/project-id/asset.webp',
      declaration: declaration(fixtures.webp, {
        fileName: 'asset.webp',
        mimeType: 'image/webp',
      }),
      verification: {
        mimeType: 'image/webp',
        sizeBytes: fixtures.webp.byteLength,
        width: 1,
        height: 1,
        checksumSha256: createHash('sha256')
          .update(fixtures.webp)
          .digest('hex'),
        verifiedAt: now,
      },
      deletionMarkedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const batch: MediaImportBatch = Object.freeze({
      id: 'batch-id',
      workspaceId: 'workspace-id',
      attachedProjectId: null,
      expiresAt: new Date('2026-08-12T12:00:00.000Z'),
      attachedAt: null,
      createdAt: now,
    });
    const mutateAsset = (value: MediaAsset): void => {
      // @ts-expect-error Media asset identity is immutable.
      value.id = 'other-id';
    };
    const mutateBatch = (value: MediaImportBatch): void => {
      // @ts-expect-error Import batch identity is immutable.
      value.id = 'other-id';
    };

    expect(asset.status).toBe('READY');
    expect(batch.attachedAt).toBeNull();
    expect(mutateAsset).toEqual(expect.any(Function));
    expect(mutateBatch).toEqual(expect.any(Function));
  });
});
