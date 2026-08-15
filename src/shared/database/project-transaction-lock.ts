import { createHash } from 'node:crypto';

export function projectAdvisoryLockId(projectId: string): bigint {
  const digest = createHash('sha256')
    .update(`nexus:project:${projectId}`, 'utf8')
    .digest();
  return digest.readBigInt64BE(0);
}
