import type { AppConfig } from '../../../shared/config/app-config.schema';
import {
  OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION,
  OBJECT_STORAGE_PRESIGNED_GET_TTL_SECONDS,
  OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS,
  buildProjectMediaObjectKey,
} from '../application/ports/object-storage';
import { R2ObjectStorage } from './r2-object-storage';

function storage(): R2ObjectStorage {
  return new R2ObjectStorage({
    r2: {
      accountId: 'account-id',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      bucketName: 'nexus-media',
    },
  } as AppConfig);
}

describe('R2ObjectStorage', () => {
  it('presigns an exact-size, create-only five-minute PUT with SigV4', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    try {
      const grant = await storage().createPresignedPut({
        key: buildProjectMediaObjectKey({
          workspaceId: 'workspace-id',
          projectId: 'project-id',
          assetId: 'asset-id',
          safeName: 'hero image.png',
        }),
        contentLength: 68,
        contentType: 'image/png',
        expiresInSeconds: OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS,
        writeCondition: OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION,
      });
      const url = new URL(grant.url);

      expect(url.origin).toBe('https://account-id.r2.cloudflarestorage.com');
      expect(url.pathname).toBe(
        '/nexus-media/workspaces/workspace-id/projects/project-id/asset-id/hero%20image.png',
      );
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host;if-none-match',
      );
      // Known-answer vector generated independently with
      // @aws-sdk/s3-request-presigner 3.1111.0 and explicit content-type signing.
      expect(grant.url).toBe(
        'https://account-id.r2.cloudflarestorage.com/nexus-media/workspaces/workspace-id/projects/project-id/asset-id/hero%20image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=access-key%2F20260815%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260815T120000Z&X-Amz-Expires=300&X-Amz-Signature=6e42e2353f00e796477526bb56e2858d66c79b20ca3122f1f93b649318ed8ce3&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match',
      );
      expect(grant.requiredHeaders).toEqual({
        'content-length': '68',
        'content-type': 'image/png',
        'if-none-match': '*',
      });
      expect(grant.expiresAt).toEqual(new Date('2026-08-15T12:05:00.000Z'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds provider requests with an abort signal', async () => {
    const originalFetch = globalThis.fetch;
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = jest.fn((_input, init) => {
      signal = init?.signal;
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    try {
      await storage().head(
        buildProjectMediaObjectKey({
          workspaceId: 'workspace-id',
          projectId: 'project-id',
          assetId: 'asset-id',
          safeName: 'hero.png',
        }),
      );

      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reuses a bounded read signature within each five-minute window', async () => {
    jest.useFakeTimers();
    const key = buildProjectMediaObjectKey({
      workspaceId: 'workspace-id',
      projectId: 'project-id',
      assetId: 'asset-id',
      safeName: 'hero.png',
    });
    try {
      jest.setSystemTime(new Date('2026-08-15T12:03:00.000Z'));
      const first = await storage().createPresignedGet({
        key,
        expiresInSeconds: OBJECT_STORAGE_PRESIGNED_GET_TTL_SECONDS,
      });
      jest.setSystemTime(new Date('2026-08-15T12:04:59.999Z'));
      const replay = await storage().createPresignedGet({
        key,
        expiresInSeconds: OBJECT_STORAGE_PRESIGNED_GET_TTL_SECONDS,
      });

      expect(replay).toEqual(first);
      expect(new URL(first.url).searchParams.get('X-Amz-Expires')).toBe('600');
      expect(first.url).toBe(
        'https://account-id.r2.cloudflarestorage.com/nexus-media/workspaces/workspace-id/projects/project-id/asset-id/hero.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=access-key%2F20260815%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260815T120000Z&X-Amz-Expires=600&X-Amz-Signature=dc01ae19415865d70ca790967812ed64a4f12e10a673ee20e91f0582e95b0dcb&X-Amz-SignedHeaders=host',
      );
      expect(first.expiresAt).toEqual(new Date('2026-08-15T12:10:00.000Z'));
    } finally {
      jest.useRealTimers();
    }
  });
});
