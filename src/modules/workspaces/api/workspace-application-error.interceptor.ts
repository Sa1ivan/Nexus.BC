import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { createApiHttpException } from '../../../shared/http/api-error.filter';
import { WorkspaceApplicationError } from '../application/workspace-errors';

@Injectable()
export class WorkspaceApplicationErrorInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!(error instanceof WorkspaceApplicationError)) {
          return throwError(() => error);
        }
        if (error.code === 'NOT_FOUND') {
          return throwError(() =>
            createApiHttpException(404, 'NOT_FOUND', 'Resource not found'),
          );
        }
        if (error.code === 'FORBIDDEN') {
          return throwError(() =>
            createApiHttpException(403, 'FORBIDDEN', 'Access denied'),
          );
        }
        return throwError(() =>
          createApiHttpException(
            409,
            'LAST_WORKSPACE_OWNER',
            'Workspace must retain an owner',
          ),
        );
      }),
    );
  }
}
