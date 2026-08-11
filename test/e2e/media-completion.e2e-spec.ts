import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../../src/generated/prisma/client';
import type { AuditWriter } from '../../src/shared/audit/audit-writer';
import { AppConfigModule } from '../../src/shared/config/app-config.module';
import { PrismaModule } from '../../src/shared/database/prisma.module';
import { PrismaClientService } from '../../src/shared/database/prisma.service';
import { TransactionRunner } from '../../src/shared/database/transaction-runner';
import { CompleteMediaUpload } from '../../src/modules/media/application/complete-media-upload';
import {
  buildImportMediaObjectKey,
  buildProjectMediaObjectKey,
  type ObjectStorage,
  type ObjectStorageKey,
  type BoundedObjectReadResult,
} from '../../src/modules/media/application/ports/object-storage';
import { PrismaMediaRepository } from '../../src/modules/media/infrastructure/prisma-media.repository';
import { SharpMediaInspector } from '../../src/modules/media/infrastructure/sharp-media-inspector';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  reads = 0;
  private releaseReads!: () => void;
  private readonly readsReleased: Promise<void>;

  constructor(private readonly requiredConcurrentReads = 0) {
    this.readsReleased = new Promise((resolve) => {
      this.releaseReads = resolve;
    });
  }

  createPresignedPut(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  head(key: ObjectStorageKey) {
    const bytes = this.objects.get(key);
    return Promise.resolve(
      bytes === undefined
        ? ({ kind: 'not-found' } as const)
        : ({
            kind: 'found',
            metadata: {
              contentLength: bytes.byteLength,
              contentType: 'text/plain',
            },
          } as const),
    );
  }

  async readBounded(input: {
    readonly key: ObjectStorageKey;
    readonly maxBytes: number;
  }): Promise<BoundedObjectReadResult> {
    this.reads += 1;
    if (this.requiredConcurrentReads > 0) {
      if (this.reads >= this.requiredConcurrentReads) this.releaseReads();
      await this.readsReleased;
    }
    const bytes = this.objects.get(input.key);
    if (bytes === undefined) {
      return { kind: 'not-found' };
    }
    if (bytes.byteLength > input.maxBytes) {
      return {
        kind: 'too-large',
        contentLength: bytes.byteLength,
      };
    }
    return {
      kind: 'found',
      metadata: {
        contentLength: bytes.byteLength,
        contentType: 'text/plain',
      },
      body: Readable.from([bytes]),
    };
  }

  delete(key: ObjectStorageKey): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

describe('Prisma media completion', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let repository: PrismaMediaRepository;
  let transactions: TransactionRunner;
  let inspector: SharpMediaInspector;
  let audit: AuditWriter;
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule],
      providers: [PrismaMediaRepository, SharpMediaInspector],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get<PrismaClient>(PrismaClientService);
    repository = app.get(PrismaMediaRepository);
    transactions = app.get(TransactionRunner);
    inspector = app.get(SharpMediaInspector);
    audit = app.get<AuditWriter>('AUDIT_WRITER');
  });

  afterEach(async () => {
    if (workspaceIds.length === 0) return;
    await prisma.mediaAsset.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.mediaImportBatch.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.project.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { in: workspaceIds } },
    });
    workspaceIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedPending(): Promise<{
    readonly workspaceId: string;
    readonly projectId: string;
    readonly assetId: string;
    readonly key: ObjectStorageKey;
  }> {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const assetId = randomUUID();
    const key = buildProjectMediaObjectKey({
      workspaceId,
      projectId,
      assetId,
      safeName: 'hero.png',
    });
    workspaceIds.push(workspaceId);
    await prisma.workspace.create({
      data: { id: workspaceId, name: `Workspace ${workspaceId}` },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        workspaceId,
        createOperationId: randomUUID(),
        name: 'Media project',
        publicSlug: `site-${randomUUID()}`,
        draft: {},
        draftSchemaVersion: 4,
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        workspaceId,
        projectId,
        objectKey: key,
        declaredFileName: 'hero.png',
        declaredMimeType: 'image/png',
        declaredSizeBytes: png.byteLength,
        declaredChecksumSha256: createHash('sha256').update(png).digest('hex'),
      },
    });
    return { workspaceId, projectId, assetId, key };
  }

  async function seedImportPending(): Promise<{
    readonly workspaceId: string;
    readonly batchId: string;
    readonly assetId: string;
    readonly key: ObjectStorageKey;
  }> {
    const workspaceId = randomUUID();
    const batchId = randomUUID();
    const assetId = randomUUID();
    const key = buildImportMediaObjectKey({
      workspaceId,
      batchId,
      assetId,
      safeName: 'legacy.png',
    });
    workspaceIds.push(workspaceId);
    const createdAt = new Date();
    await prisma.workspace.create({
      data: { id: workspaceId, name: `Workspace ${workspaceId}` },
    });
    await prisma.mediaImportBatch.create({
      data: {
        id: batchId,
        workspaceId,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        workspaceId,
        importBatchId: batchId,
        objectKey: key,
        declaredFileName: 'legacy.png',
        declaredMimeType: 'image/png',
        declaredSizeBytes: png.byteLength,
        declaredChecksumSha256: createHash('sha256').update(png).digest('hex'),
      },
    });
    return { workspaceId, batchId, assetId, key };
  }

  it('atomically persists verified evidence and one allowlisted audit event', async () => {
    const fixture = await seedPending();
    const storage = new MemoryObjectStorage();
    storage.objects.set(fixture.key, png);
    const useCase = new CompleteMediaUpload(
      repository,
      storage,
      inspector,
      transactions,
      audit,
    );
    const actorUserId = randomUUID();
    const requestId = randomUUID();

    await expect(
      useCase.execute({
        workspaceId: fixture.workspaceId,
        assetId: fixture.assetId,
        owner: { kind: 'project', projectId: fixture.projectId },
        actorUserId,
        requestId,
      }),
    ).resolves.toMatchObject({ kind: 'ready', transition: 'completed' });
    await expect(
      useCase.execute({
        workspaceId: fixture.workspaceId,
        assetId: fixture.assetId,
        owner: { kind: 'project', projectId: fixture.projectId },
        actorUserId,
        requestId,
      }),
    ).resolves.toMatchObject({ kind: 'ready', transition: 'already-ready' });

    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: fixture.assetId },
    });
    expect(asset).toMatchObject({
      status: 'READY',
      verifiedMimeType: 'image/png',
      verifiedSizeBytes: png.byteLength,
      verifiedWidth: 1,
      verifiedHeight: 1,
      verifiedChecksumSha256: createHash('sha256').update(png).digest('hex'),
    });
    expect(asset.verifiedAt).toBeInstanceOf(Date);
    const auditEvents = await prisma.auditEvent.findMany({
      where: { resourceId: fixture.assetId },
      select: {
        workspaceId: true,
        actorUserId: true,
        action: true,
        resourceType: true,
        metadata: true,
        requestId: true,
      },
    });
    expect(auditEvents).toEqual([
      {
        workspaceId: fixture.workspaceId,
        actorUserId,
        action: 'MEDIA_VERIFIED',
        resourceType: 'MediaAsset',
        metadata: { outcome: 'ready' },
        requestId,
      },
    ]);
    expect(storage.reads).toBe(1);
  });

  it('rolls READY back when the audit append fails', async () => {
    const fixture = await seedPending();
    const storage = new MemoryObjectStorage();
    storage.objects.set(fixture.key, png);
    const failingAudit: AuditWriter = {
      append: () => Promise.reject(new Error('audit unavailable')),
    };
    const useCase = new CompleteMediaUpload(
      repository,
      storage,
      inspector,
      transactions,
      failingAudit,
    );

    await expect(
      useCase.execute({
        workspaceId: fixture.workspaceId,
        assetId: fixture.assetId,
        owner: { kind: 'project', projectId: fixture.projectId },
        actorUserId: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toThrow('audit unavailable');

    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: fixture.assetId } }),
    ).resolves.toMatchObject({
      status: 'PENDING',
      verifiedMimeType: null,
      verifiedAt: null,
    });
  });

  it('completes an unexpired unattached import asset through the batch relation guard', async () => {
    const fixture = await seedImportPending();
    const storage = new MemoryObjectStorage();
    storage.objects.set(fixture.key, png);
    const useCase = new CompleteMediaUpload(
      repository,
      storage,
      inspector,
      transactions,
      audit,
    );

    await expect(
      useCase.execute({
        workspaceId: fixture.workspaceId,
        assetId: fixture.assetId,
        owner: { kind: 'import', batchId: fixture.batchId },
        actorUserId: randomUUID(),
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ kind: 'ready', transition: 'completed' });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: fixture.assetId } }),
    ).resolves.toMatchObject({
      status: 'READY',
      projectId: null,
      importBatchId: fixture.batchId,
      verifiedMimeType: 'image/png',
    });
  });

  it('returns the persisted winner evidence to both concurrent completions', async () => {
    const fixture = await seedPending();
    const storage = new MemoryObjectStorage(2);
    storage.objects.set(fixture.key, png);
    let inspectionCall = 0;
    const sequencedInspector = {
      inspect: async () => {
        inspectionCall += 1;
        if (inspectionCall === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return { mimeType: 'image/png' as const, width: 1, height: 1 };
      },
    };
    const useCase = new CompleteMediaUpload(
      repository,
      storage,
      sequencedInspector,
      transactions,
      audit,
    );
    const request = {
      workspaceId: fixture.workspaceId,
      assetId: fixture.assetId,
      owner: { kind: 'project' as const, projectId: fixture.projectId },
      actorUserId: randomUUID(),
      requestId: randomUUID(),
    };

    const results = await Promise.all([
      useCase.execute(request),
      useCase.execute({ ...request, requestId: randomUUID() }),
    ]);
    expect(results.map((result) => result.kind)).toEqual(['ready', 'ready']);
    expect(
      results
        .map((result) =>
          result.kind === 'ready' ? result.transition : 'unexpected',
        )
        .sort(),
    ).toEqual(['already-ready', 'completed']);

    const persisted = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: fixture.assetId },
    });
    expect(persisted.verifiedAt).toBeInstanceOf(Date);
    for (const result of results) {
      if (result.kind !== 'ready') throw new Error('Expected READY result');
      expect(result.verification.verifiedAt).toEqual(persisted.verifiedAt);
    }
    await expect(
      prisma.auditEvent.count({
        where: { resourceId: fixture.assetId, action: 'MEDIA_VERIFIED' },
      }),
    ).resolves.toBe(1);
  });
});
