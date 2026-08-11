import sharp from 'sharp';
import type {
  InspectedImage,
  MediaInspector,
} from '../application/ports/media-inspector';
import { MEDIA_MAX_PIXELS } from '../domain/media-asset';

export class SharpMediaInspector implements MediaInspector {
  async inspect(bytes: Uint8Array): Promise<InspectedImage | null> {
    try {
      const options = {
        failOn: 'warning' as const,
        limitInputPixels: MEDIA_MAX_PIXELS,
      };
      const metadata = await sharp(bytes, options).metadata();
      const mimeType = mediaMimeType(metadata.format);
      if (
        mimeType === null ||
        metadata.width === undefined ||
        metadata.height === undefined
      ) {
        return null;
      }

      await sharp(bytes, options).stats();
      return {
        mimeType,
        width: metadata.width,
        height: metadata.height,
      };
    } catch {
      return null;
    }
  }
}

function mediaMimeType(
  format: string | undefined,
): InspectedImage['mimeType'] | null {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return null;
}
