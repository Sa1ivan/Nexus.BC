import { createHash } from 'node:crypto';
import {
  MEDIA_MAX_BYTES,
  type MediaDeclaration,
  type MediaVerificationResult,
  validateMediaInspection,
} from '../domain/media-asset';
import type { MediaInspector } from './ports/media-inspector';

export async function verifyMediaContent(
  input: {
    readonly declaration: MediaDeclaration;
    readonly body: AsyncIterable<Uint8Array>;
  },
  inspector: MediaInspector,
): Promise<MediaVerificationResult> {
  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let sizeBytes = 0;

  for await (const chunk of input.body) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > MEDIA_MAX_BYTES) {
      return { ok: false, code: 'media-too-large' };
    }
    chunks.push(chunk);
    hash.update(chunk);
  }

  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const inspected = await inspector.inspect(bytes);
  if (inspected === null) {
    return { ok: false, code: 'invalid-image' };
  }

  return validateMediaInspection(input.declaration, {
    ...inspected,
    sizeBytes,
    checksumSha256: hash.digest('hex'),
  });
}
