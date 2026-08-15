import type { MediaMimeType } from '../../domain/media-asset';

export const MEDIA_INSPECTOR = Symbol('MediaInspector');

export interface InspectedImage {
  readonly mimeType: MediaMimeType;
  readonly width: number;
  readonly height: number;
}

export interface MediaInspector {
  inspect(bytes: Uint8Array): Promise<InspectedImage | null>;
}
