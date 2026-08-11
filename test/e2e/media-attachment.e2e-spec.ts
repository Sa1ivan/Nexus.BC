import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../../src/generated/prisma/client';
import type { MediaImportAttachment } from '../../src/modules/media/application/public';
import { PrismaMediaRepository } from '../../src/modules/media/infrastructure/prisma-media.repository';
import { AppConfigModule } from '../../src/shared/config/app-config.module';
import { PrismaModule } from '../../src/shared/database/prisma.module';
import { PrismaClientService } from '../../src/shared/database/prisma.service';
import {
  TransactionRunner,
  type TransactionContext,
} from '../../src/shared/database/transaction-runner';

interface SeededMedia {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly assetIds: readonly string[];
}

describe('Prisma media import attachment', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let transactions: TransactionRunner;
  let attachment: MediaImportAttachment;
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule],
      providers: [PrismaMediaRepository],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get<PrismaClient>(PrismaClientService);
    transactions = app.get(TransactionRunner);
    attachment = app.get(PrismaMediaRepository);
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

  async function seed(
    input: {
      readonly statuses?: readonly ('PENDING' | 'READY')[];
      readonly expiresAt?: Date;
      readonly attached?: boolean;
    } = {},
  ): Promise<SeededMedia> {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const batchId = randomUUID();
    const statuses = input.statuses ?? ['READY', 'READY'];
    const expiresAt = input.expiresAt ?? new Date('2099-08-12T08:00:00.000Z');
    const createdAt = new Date(expiresAt.getTime() - 24 * 60 * 60 * 1000);
    workspaceIds.push(workspaceId);

    await prisma.workspace.create({
      data: { id: workspaceId, name: `Workspace ${workspaceId}` },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        workspaceId,
        createOperationId: randomUUID(),
        name: 'Imported project',
        publicSlug: `site-${randomUUID()}`,
        draft: {},
        draftSchemaVersion: 4,
      },
    });
    await prisma.mediaImportBatch.create({
      data: {
        id: batchId,
        workspaceId,
        createdAt,
        expiresAt,
        ...(input.attached === true
          ? {
              attachedProjectId: projectId,
              attachedAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
            }
          : {}),
      },
    });

    const assetIds: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const id = randomUUID();
      const checksum = String(index + 1).repeat(64);
      assetIds.push(id);
      await prisma.mediaAsset.create({
        data: {
          id,
          workspaceId,
          projectId: input.attached === true ? projectId : null,
          importBatchId: batchId,
          status,
          objectKey: `workspaces/${workspaceId}/imports/${batchId}/${id}/asset-${index}.png`,
          declaredFileName: `asset-${index}.png`,
          declaredMimeType: 'image/png',
          declaredSizeBytes: 68,
          declaredChecksumSha256: checksum,
          ...(status === 'READY'
            ? {
                verifiedMimeType: 'image/png',
                verifiedSizeBytes: 68,
                verifiedWidth: 1,
                verifiedHeight: 1,
                verifiedChecksumSha256: checksum,
                verifiedAt: new Date(),
              }
            : {}),
        },
      });
    }

    return { workspaceId, projectId, batchId, assetIds };
  }

  it('attaches the exact READY set inside the caller transaction', async () => {
    const fixture = await seed();

    await expect(
      transactions.run((context) =>
        attachment.attach(context, {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          batchId: fixture.batchId,
          referencedAssetIds: fixture.assetIds,
        }),
      ),
    ).resolves.toEqual({ kind: 'attached' });

    const batch = await prisma.mediaImportBatch.findUniqueOrThrow({
      where: { id: fixture.batchId },
    });
    expect(batch.attachedProjectId).toBe(fixture.projectId);
    expect(batch.attachedAt).toBeInstanceOf(Date);
    const assets = await prisma.mediaAsset.findMany({
      where: { importBatchId: fixture.batchId },
      orderBy: { id: 'asc' },
    });
    expect(assets).toHaveLength(2);
    expect(
      assets.every(({ projectId }) => projectId === fixture.projectId),
    ).toBe(true);
  });

  it('rolls back both the batch and every asset with the surrounding project transaction', async () => {
    const fixture = await seed();

    await expect(
      transactions.run(async (context) => {
        const result = await attachment.attach(context, {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          batchId: fixture.batchId,
          referencedAssetIds: fixture.assetIds,
        });
        expect(result).toEqual({ kind: 'attached' });
        throw new Error('project create rollback');
      }),
    ).rejects.toThrow('project create rollback');

    await expect(
      prisma.mediaImportBatch.findUniqueOrThrow({
        where: { id: fixture.batchId },
      }),
    ).resolves.toMatchObject({
      attachedProjectId: null,
      attachedAt: null,
    });
    const assets = await prisma.mediaAsset.findMany({
      where: { importBatchId: fixture.batchId },
    });
    expect(assets.every(({ projectId }) => projectId === null)).toBe(true);
  });

  it('rejects expired, attached, mismatched, unready, and foreign state', async () => {
    const expired = await seed({
      expiresAt: new Date('2026-08-11T09:00:00.000Z'),
    });
    await expect(
      transactions.run((context) =>
        attachment.attach(context, {
          workspaceId: expired.workspaceId,
          projectId: expired.projectId,
          batchId: expired.batchId,
          referencedAssetIds: expired.assetIds,
        }),
      ),
    ).resolves.toEqual({ kind: 'expired' });

    const attached = await seed({ attached: true });
    await expect(
      transactions.run((context) =>
        attachment.attach(context, {
          workspaceId: attached.workspaceId,
          projectId: attached.projectId,
          batchId: attached.batchId,
          referencedAssetIds: attached.assetIds,
        }),
      ),
    ).resolves.toEqual({ kind: 'already-attached' });

    const mismatched = await seed();
    await expect(
      transactions.run((context) =>
        attachment.attach(context, {
          workspaceId: mismatched.workspaceId,
          projectId: mismatched.projectId,
          batchId: mismatched.batchId,
          referencedAssetIds: [mismatched.assetIds[0] as string],
        }),
      ),
    ).resolves.toEqual({ kind: 'asset-set-mismatch' });

    const unready = await seed({ statuses: ['READY', 'PENDING'] });
    await expect(
      transactions.run((context) =>
        attachment.attach(context, {
          workspaceId: unready.workspaceId,
          projectId: unready.projectId,
          batchId: unready.batchId,
          referencedAssetIds: unready.assetIds,
        }),
      ),
    ).resolves.toEqual({ kind: 'asset-not-ready' });

    const foreign = await seed();
    await expect(
      transactions.run((context) =>
        attachment.attach(context, {
          workspaceId: randomUUID(),
          projectId: foreign.projectId,
          batchId: foreign.batchId,
          referencedAssetIds: foreign.assetIds,
        }),
      ),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('requires a live opaque transaction context', async () => {
    const fixture = await seed();

    await expect(
      attachment.attach({} as TransactionContext, {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        batchId: fixture.batchId,
        referencedAssetIds: fixture.assetIds,
      }),
    ).rejects.toThrow('active TransactionContext');
  });
});
