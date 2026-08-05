export interface AuthSessionResult {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface RegistrationResult {
  readonly email: string;
  readonly emailVerificationRequired: true;
  readonly userId: string;
}
