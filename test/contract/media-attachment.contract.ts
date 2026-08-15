import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MEDIA_IMPORT_ATTACHMENT,
  type AttachMediaImportBatchResult,
  type MediaImportAttachment,
} from '../../src/modules/media/application/public';
import type { TransactionContext } from '../../src/shared/database/transaction-runner';

describe('media import attachment application contract', () => {
  it('requires the caller transaction and exact referenced asset set', async () => {
    const attachment: MediaImportAttachment = {
      attach: (_context, input) =>
        Promise.resolve(
          input.referencedAssetIds.length === 2
            ? ({ kind: 'attached' } as const)
            : ({ kind: 'asset-set-mismatch' } as const),
        ),
    };
    const context = Object.freeze({}) as TransactionContext;

    await expect(
      attachment.attach(context, {
        workspaceId: 'workspace-id',
        projectId: 'project-id',
        batchId: 'batch-id',
        referencedAssetIds: ['asset-a', 'asset-b'],
      }),
    ).resolves.toEqual({ kind: 'attached' });
  });

  it('models every required fail-closed attachment outcome', () => {
    const outcomes = [
      { kind: 'not-found' },
      { kind: 'expired' },
      { kind: 'already-attached' },
      { kind: 'asset-set-mismatch' },
      { kind: 'asset-not-ready' },
    ] satisfies readonly AttachMediaImportBatchResult[];

    expect(outcomes.map(({ kind }) => kind)).toEqual([
      'not-found',
      'expired',
      'already-attached',
      'asset-set-mismatch',
      'asset-not-ready',
    ]);
  });

  it('exports only provider-neutral application contracts', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/modules/media/application/public.ts'),
      'utf8',
    );

    expect(MEDIA_IMPORT_ATTACHMENT).toEqual(expect.any(Symbol));
    expect(source).not.toMatch(
      /@prisma|@aws-sdk|\/domain\/|\/infrastructure\/|\b(?:Prisma|R2|S3Client)\b/u,
    );
  });
});
