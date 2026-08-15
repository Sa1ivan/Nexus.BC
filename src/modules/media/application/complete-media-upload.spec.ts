import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AuditWriter } from '../../../shared/audit/audit-writer';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import type { MediaAsset } from '../domain/media-asset';
import { CompleteMediaUpload } from './complete-media-upload';
import type { MediaInspector } from './ports/media-inspector';
import type {
  MarkMediaReadyResult,
  MediaCompletionTarget,
  MediaRepository,
} from './ports/media-repository';
import {
  buildImportMediaObjectKey,
  buildProjectMediaObjectKey,
  type BoundedObjectReadInput,
  type BoundedObjectReadResult,
  type ObjectStorage,
} from './ports/object-storage';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const workspaceId = randomUUID();
const projectId = randomUUID();
const batchId = randomUUID();
const assetId = randomUUID();
const actorUserId = randomUUID();

function pendingAsset(owner: 'project' | 'import' = 'project'): MediaAsset {
  const fileName = 'hero.png';
  return {
    id: assetId,
    workspaceId,
    projectId: owner === 'project' ? projectId : null,
    importBatchId: owner === 'import' ? batchId : null,
    status: 'PENDING',
    objectKey:
      owner === 'project'
        ? buildProjectMediaObjectKey({
            workspaceId,
            projectId,
            assetId,
            safeName: fileName,
          })
        : buildImportMediaObjectKey({
            workspaceId,
            batchId,
            assetId,
            safeName: fileName,
          }),
    declaration: {
      fileName,
      mimeType: 'image/png',
      sizeBytes: png.byteLength,
      checksumSha256: createHash('sha256').update(png).digest('hex'),
    },
    verification: null,
    deletionMarkedAt: null,
    createdAt: new Date('2026-08-11T12:00:00.000Z'),
    updatedAt: new Date('2026-08-11T12:00:00.000Z'),
  };
}

function target(asset: MediaAsset): MediaCompletionTarget {
  return {
    asset,
    importBatch:
      asset.importBatchId === null
        ? null
        : {
            expiresAt: new Date('2026-08-12T12:00:00.000Z'),
            attachedAt: null,
            cleanupStartedAt: null,
          },
  };
}

class FakeMediaRepository implements MediaRepository {
  completionTarget: MediaCompletionTarget | null = target(pendingAsset());
  markResult: MarkMediaReadyResult = { kind: 'updated' };
  markedContext: TransactionContext | null = null;

  findCompletionTarget(): Promise<MediaCompletionTarget | null> {
    return Promise.resolve(this.completionTarget);
  }

  markReady(context: TransactionContext): Promise<MarkMediaReadyResult> {
    this.markedContext = context;
    return Promise.resolve(this.markResult);
  }
}

class FakeObjectStorage implements ObjectStorage {
  readonly readInputs: BoundedObjectReadInput[] = [];
  readResult: BoundedObjectReadResult = {
    kind: 'found',
    metadata: {
      contentLength: png.byteLength,
      contentType: 'application/octet-stream',
    },
    body: Readable.from([png]),
  };

  createPresignedPut(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  createPresignedGet(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  head() {
    return Promise.resolve({ kind: 'not-found' } as const);
  }

  readBounded(input: BoundedObjectReadInput): Promise<BoundedObjectReadResult> {
    this.readInputs.push(input);
    return Promise.resolve(this.readResult);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}

function storage(): FakeObjectStorage {
  return new FakeObjectStorage();
}

function dependencies(repository = new FakeMediaRepository()): {
  readonly useCase: CompleteMediaUpload;
  readonly repository: FakeMediaRepository;
  readonly objectStorage: FakeObjectStorage;
  readonly auditEvents: unknown[];
  readonly context: TransactionContext;
} {
  const context = Object.freeze({}) as TransactionContext;
  const transactions = {
    run: <T>(work: (value: TransactionContext) => Promise<T>): Promise<T> =>
      work(context),
  } as unknown as TransactionRunner;
  const objectStorage = storage();
  const inspector: MediaInspector = {
    inspect: () =>
      Promise.resolve({ mimeType: 'image/png', width: 1, height: 1 }),
  };
  const auditEvents: unknown[] = [];
  const audit: AuditWriter = {
    append: (_auditContext, event) => {
      auditEvents.push(event);
      return Promise.resolve({ eventId: event.eventId, sequence: 1n });
    },
  };
  return {
    useCase: new CompleteMediaUpload(
      repository,
      objectStorage,
      inspector,
      transactions,
      audit,
    ),
    repository,
    objectStorage,
    auditEvents,
    context,
  };
}

describe('CompleteMediaUpload', () => {
  it('streams server-owned content, commits READY, and appends a safe audit event', async () => {
    const fixture = dependencies();

    await expect(
      fixture.useCase.execute({
        workspaceId,
        assetId,
        owner: { kind: 'project', projectId },
        actorUserId,
        requestId: 'request-id',
      }),
    ).resolves.toMatchObject({
      kind: 'ready',
      transition: 'completed',
      verification: {
        mimeType: 'image/png',
        sizeBytes: png.byteLength,
        width: 1,
        height: 1,
      },
    });

    expect(fixture.objectStorage.readInputs).toEqual([
      {
        key: pendingAsset().objectKey,
        maxBytes: 10 * 1024 * 1024,
      },
    ]);
    expect(fixture.repository.markedContext).toBe(fixture.context);
    expect(fixture.auditEvents).toHaveLength(1);
    expect(fixture.auditEvents[0]).toMatchObject({
      workspaceId,
      actorUserId,
      action: 'MEDIA_VERIFIED',
      resourceType: 'MediaAsset',
      resourceId: assetId,
      metadata: { outcome: 'ready' },
      requestId: 'request-id',
    });
    expect(
      (fixture.auditEvents[0] as { readonly eventId: unknown }).eventId,
    ).toEqual(expect.any(String));
  });

  it('returns an already READY asset without reading storage or appending audit', async () => {
    const repository = new FakeMediaRepository();
    const ready = pendingAsset();
    repository.completionTarget = target({
      ...ready,
      status: 'READY',
      verification: {
        mimeType: 'image/png',
        sizeBytes: png.byteLength,
        width: 1,
        height: 1,
        checksumSha256: ready.declaration.checksumSha256,
        verifiedAt: new Date('2026-08-11T12:01:00.000Z'),
      },
    });
    const fixture = dependencies(repository);

    await expect(
      fixture.useCase.execute({
        workspaceId,
        assetId,
        owner: { kind: 'project', projectId },
        actorUserId,
        requestId: 'request-id',
      }),
    ).resolves.toMatchObject({ kind: 'ready', transition: 'already-ready' });
    expect(fixture.objectStorage.readInputs).toEqual([]);
    expect(fixture.auditEvents).toEqual([]);
  });

  it('fails closed for missing, oversized, expired, or foreign storage state', async () => {
    const missing = dependencies();
    missing.repository.completionTarget = null;
    await expect(
      missing.useCase.execute({
        workspaceId,
        assetId,
        owner: { kind: 'project', projectId },
        actorUserId,
        requestId: 'request-id',
      }),
    ).resolves.toEqual({ kind: 'not-found' });

    const oversized = dependencies();
    oversized.objectStorage.readResult = {
      kind: 'too-large',
      contentLength: 10 * 1024 * 1024 + 1,
    };
    await expect(
      oversized.useCase.execute({
        workspaceId,
        assetId,
        owner: { kind: 'project', projectId },
        actorUserId,
        requestId: 'request-id',
      }),
    ).resolves.toEqual({ kind: 'rejected', code: 'media-too-large' });

    const expired = dependencies();
    expired.repository.completionTarget = {
      asset: pendingAsset('import'),
      importBatch: {
        expiresAt: new Date('2000-01-01T00:00:00.000Z'),
        attachedAt: null,
        cleanupStartedAt: null,
      },
    };
    await expect(
      expired.useCase.execute({
        workspaceId,
        assetId,
        owner: { kind: 'import', batchId },
        actorUserId,
        requestId: 'request-id',
      }),
    ).resolves.toEqual({ kind: 'expired' });

    const foreignKey = dependencies();
    foreignKey.repository.completionTarget = target({
      ...pendingAsset(),
      objectKey: buildProjectMediaObjectKey({
        workspaceId: randomUUID(),
        projectId,
        assetId,
        safeName: 'hero.png',
      }),
    });
    await expect(
      foreignKey.useCase.execute({
        workspaceId,
        assetId,
        owner: { kind: 'project', projectId },
        actorUserId,
        requestId: 'request-id',
      }),
    ).rejects.toThrow('Stored media object key does not match ownership');
  });
});
