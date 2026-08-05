import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { createApiHttpException } from '../../../shared/http/api-error.filter';
import { AuthApplicationError } from '../application/auth-errors';

const authErrorContracts = {
  EMAIL_ALREADY_REGISTERED: [409, 'Email is already registered'],
  EMAIL_NOT_VERIFIED: [403, 'Email verification is required'],
  INVALID_CREDENTIALS: [401, 'Invalid credentials'],
  RESET_TOKEN_INVALID: [400, 'Password reset token is invalid'],
  SESSION_INVALID: [401, 'Session is invalid'],
  VERIFICATION_TOKEN_INVALID: [400, 'Verification token is invalid'],
} as const;

@Injectable()
export class AuthApplicationErrorInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!(error instanceof AuthApplicationError)) {
          return throwError(() => error);
        }
        const [status, message] = authErrorContracts[error.code];
        return throwError(() =>
          createApiHttpException(status, error.code, message),
        );
      }),
    );
  }
}
