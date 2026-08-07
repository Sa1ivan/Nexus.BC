import { createHash } from 'node:crypto';
import type { IdempotencyRecordKey } from './idempotency-store';

const lockFramePrefix = Buffer.from('nexus-idempotency-lock-v1\0', 'utf8');

function framedValue(value: string): readonly [Buffer, Buffer] {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return [length, bytes];
}

export function idempotencyAdvisoryLockId(key: IdempotencyRecordKey): bigint {
  const frame = Buffer.concat([
    lockFramePrefix,
    ...framedValue(key.scope),
    ...framedValue(key.operation),
    ...framedValue(key.key),
  ]);
  return createHash('sha256').update(frame).digest().readBigInt64BE(0);
}
