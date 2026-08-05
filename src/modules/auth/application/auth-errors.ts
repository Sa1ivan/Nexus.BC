export type AuthErrorCode =
  | 'EMAIL_ALREADY_REGISTERED'
  | 'EMAIL_NOT_VERIFIED'
  | 'INVALID_CREDENTIALS'
  | 'RESET_TOKEN_INVALID'
  | 'SESSION_INVALID'
  | 'VERIFICATION_TOKEN_INVALID';

export class AuthApplicationError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
  }
}
