import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { HttpRateLimiter } from '../../shared/http/rate-limiter';
import { AuthApplicationErrorInterceptor } from './api/auth-application-error.interceptor';
import { AuthController } from './api/auth.controller';
import { AuthenticationGuard } from './api/authentication.guard';
import {
  ACCESS_TOKEN_SERVICE,
  AUTH_REPOSITORY,
  AUTH_SECRET_SERVICE,
  PASSWORD_HASHER,
} from './application/auth.ports';
import { ConfirmPasswordReset } from './application/confirm-password-reset';
import { LoginUser } from './application/login-user';
import { LogoutUser } from './application/logout-user';
import { RefreshAuthSession } from './application/refresh-auth-session';
import { RegisterUser } from './application/register-user';
import { RequestPasswordReset } from './application/request-password-reset';
import { VerifyEmail } from './application/verify-email';
import {
  AesGcmAuthSecretService,
  Argon2idPasswordHasher,
  HmacAccessTokenService,
} from './infrastructure/auth-security';
import { PrismaAuthRepository } from './infrastructure/prisma-auth.repository';

@Module({
  controllers: [AuthController],
  providers: [
    PrismaAuthRepository,
    Argon2idPasswordHasher,
    AesGcmAuthSecretService,
    HmacAccessTokenService,
    { provide: AUTH_REPOSITORY, useExisting: PrismaAuthRepository },
    { provide: PASSWORD_HASHER, useExisting: Argon2idPasswordHasher },
    { provide: AUTH_SECRET_SERVICE, useExisting: AesGcmAuthSecretService },
    { provide: ACCESS_TOKEN_SERVICE, useExisting: HmacAccessTokenService },
    RegisterUser,
    VerifyEmail,
    LoginUser,
    RefreshAuthSession,
    LogoutUser,
    RequestPasswordReset,
    ConfirmPasswordReset,
    AuthApplicationErrorInterceptor,
    HttpRateLimiter,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
  ],
  exports: [ACCESS_TOKEN_SERVICE],
})
export class AuthModule {}
