import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { createApiHttpException } from '../../../shared/http/api-error.filter';
import { SitesApplicationError } from '../application/sites-errors';

@Injectable()
export class SitesApplicationErrorInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!(error instanceof SitesApplicationError)) {
          return throwError(() => error);
        }
        if (error.code === 'VALIDATION_ERROR') {
          return throwError(() =>
            createApiHttpException(
              400,
              'VALIDATION_ERROR',
              'Request validation failed',
            ),
          );
        }
        if (error.code === 'NOT_FOUND') {
          return throwError(() =>
            createApiHttpException(404, 'NOT_FOUND', 'Resource not found'),
          );
        }
        if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
          return throwError(() =>
            createApiHttpException(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency key was reused with a different request',
            ),
          );
        }
        return throwError(() =>
          createApiHttpException(
            409,
            'PROJECT_VERSION_CONFLICT',
            'Project draft version is stale',
            { currentDraftVersion: error.currentDraftVersion ?? null },
          ),
        );
      }),
    );
  }
}
