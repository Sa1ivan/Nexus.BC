import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { createApiHttpException } from '../../../shared/http/api-error.filter';
import { MediaApplicationError } from '../application/media-errors';

@Injectable()
export class MediaApplicationErrorInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!(error instanceof MediaApplicationError)) {
          return throwError(() => error);
        }
        if (error.code === 'NOT_FOUND') {
          return throwError(() =>
            createApiHttpException(404, 'NOT_FOUND', 'Resource not found'),
          );
        }
        if (error.code === 'MEDIA_ASSET_IN_USE') {
          return throwError(() =>
            createApiHttpException(
              409,
              'MEDIA_ASSET_IN_USE',
              'The media asset is referenced by retained site state',
            ),
          );
        }
        return throwError(() =>
          createApiHttpException(409, error.code, 'Media request failed'),
        );
      }),
    );
  }
}
