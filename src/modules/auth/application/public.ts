export const AUTHENTICATED_PRINCIPAL = Symbol('AuthenticatedPrincipal');

export interface AuthenticatedPrincipal {
  readonly email: string;
  readonly userId: string;
}
