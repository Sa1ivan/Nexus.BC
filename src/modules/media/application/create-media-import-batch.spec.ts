import { randomUUID } from 'node:crypto';
import type { WorkspaceAccess } from '../../workspaces/application/public';
import { CreateMediaImportBatch } from './create-media-import-batch';
import { MediaAccessPolicy } from './media-access-policy';
import type {
  CreateMediaImportBatchInput,
  MediaCatalogRepository,
} from './ports/media-repository';

describe('CreateMediaImportBatch', () => {
  it('persists createdAt and the exact 24-hour expiry from one clock reading', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-08-15T12:34:56.789Z');
    jest.setSystemTime(now);
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    let captured: CreateMediaImportBatchInput | undefined;
    const repository = {
      createImportBatch: (input: CreateMediaImportBatchInput) => {
        captured = input;
        return Promise.resolve({
          ...input,
          attachedProjectId: null,
          attachedAt: null,
          cleanupStartedAt: null,
          cleanupLastAttemptAt: null,
          createdAt: now,
        });
      },
    } as MediaCatalogRepository;
    const workspaces: WorkspaceAccess = {
      findForUser: () => Promise.resolve({ id: workspaceId, role: 'OWNER' }),
    };
    const useCase = new CreateMediaImportBatch(
      repository,
      new MediaAccessPolicy(workspaces),
    );

    try {
      await useCase.execute({ workspaceId, actorUserId });

      if (captured === undefined) {
        throw new Error('Import batch input was not captured');
      }
      expect(typeof captured.id).toBe('string');
      expect(captured).toMatchObject({
        workspaceId,
        createdAt: now,
        expiresAt: new Date('2026-08-16T12:34:56.789Z'),
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
