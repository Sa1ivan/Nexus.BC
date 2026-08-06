import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import { createApiHttpException } from '../../../shared/http/api-error.filter';
import { Public } from '../../../shared/http/public.decorator';
import {
  exactRequestBody,
  readCookie,
  requestClientIp,
  requireAllowedOrigin,
  requireBoundedString,
  requireString,
  serializeSecureHttpOnlyCookie,
  throwRequestValidationError,
} from '../../../shared/http/request-contract';
import {
  enforceHttpRateLimit,
  HttpRateLimiter,
} from '../../../shared/http/rate-limiter';
import { ConfirmPasswordReset } from '../application/confirm-password-reset';
import { LoginUser } from '../application/login-user';
import { LogoutUser } from '../application/logout-user';
import { RefreshAuthSession } from '../application/refresh-auth-session';
import { RegisterUser } from '../application/register-user';
import { RequestPasswordReset } from '../application/request-password-reset';
import { VerifyEmail } from '../application/verify-email';
import { AuthApplicationErrorInterceptor } from './auth-application-error.interceptor';

const refreshCookieName = 'nexus_refresh';
const refreshCookieMaxAgeSeconds = 30 * 24 * 60 * 60;
const passwordResetMinimumResponseMilliseconds = 350;
const passwordResetJitterMilliseconds = 100;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

@UseInterceptors(AuthApplicationErrorInterceptor)
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUser,
    private readonly verifyEmail: VerifyEmail,
    private readonly loginUser: LoginUser,
    private readonly refreshSession: RefreshAuthSession,
    private readonly logoutUser: LogoutUser,
    private readonly requestReset: RequestPasswordReset,
    private readonly confirmReset: ConfirmPasswordReset,
    private readonly rateLimiter: HttpRateLimiter,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = exactRequestBody(body, ['email', 'password']);
    const email = requireString(input['email'])
      .trim()
      .normalize('NFC')
      .toLowerCase();
    if (email.length === 0 || email.length > 320 || !emailPattern.test(email)) {
      throwRequestValidationError();
    }
    const password = requireBoundedString(input['password'], 12, 128);
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'register',
      requestClientIp(request, this.configuration.nodeEnv),
      5,
    );
    return this.registerUser.execute(email, password);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  async confirmEmail(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'verify-email',
      requestClientIp(request, this.configuration.nodeEnv),
      10,
    );
    const input = exactRequestBody(body, ['token']);
    await this.verifyEmail.execute(
      requireBoundedString(input['token'], 32, 512),
    );
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireAllowedOrigin(request, this.configuration.webOrigins);
    const input = exactRequestBody(body, ['email', 'password']);
    const email = requireString(input['email'])
      .trim()
      .normalize('NFC')
      .toLowerCase();
    if (email.length === 0 || email.length > 320 || !emailPattern.test(email)) {
      throwRequestValidationError();
    }
    const password = requireBoundedString(input['password'], 12, 128);
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'login-ip',
      requestClientIp(request, this.configuration.nodeEnv),
      20,
    );
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'login-account',
      email,
      10,
    );
    const result = await this.loginUser.execute(email, password);
    response.setHeader(
      'Set-Cookie',
      serializeSecureHttpOnlyCookie({
        name: refreshCookieName,
        value: result.refreshToken,
        maxAgeSeconds: refreshCookieMaxAgeSeconds,
        path: '/v1/auth',
      }),
    );
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer' as const,
      expiresInSeconds: 600,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireAllowedOrigin(request, this.configuration.webOrigins);
    exactRequestBody(body, []);
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'refresh',
      requestClientIp(request, this.configuration.nodeEnv),
      30,
    );
    const current = readCookie(request, refreshCookieName);
    if (current === undefined) {
      throw createApiHttpException(
        401,
        'SESSION_INVALID',
        'Session is invalid',
      );
    }
    const result = await this.refreshSession.execute(current);
    response.setHeader(
      'Set-Cookie',
      serializeSecureHttpOnlyCookie({
        name: refreshCookieName,
        value: result.refreshToken,
        maxAgeSeconds: refreshCookieMaxAgeSeconds,
        path: '/v1/auth',
      }),
    );
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer' as const,
      expiresInSeconds: 600,
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    requireAllowedOrigin(request, this.configuration.webOrigins);
    exactRequestBody(body, []);
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'logout',
      requestClientIp(request, this.configuration.nodeEnv),
      30,
    );
    await this.logoutUser.execute(readCookie(request, refreshCookieName));
    response.setHeader(
      'Set-Cookie',
      serializeSecureHttpOnlyCookie({
        name: refreshCookieName,
        value: '',
        maxAgeSeconds: 0,
        path: '/v1/auth',
      }),
    );
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(202)
  async requestPasswordReset(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly accepted: true }> {
    const input = exactRequestBody(body, ['email']);
    const email = requireString(input['email'])
      .trim()
      .normalize('NFC')
      .toLowerCase();
    if (email.length === 0 || email.length > 320 || !emailPattern.test(email)) {
      throwRequestValidationError();
    }
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'password-reset-request-ip',
      requestClientIp(request, this.configuration.nodeEnv),
      10,
    );
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'password-reset-request-account',
      email,
      5,
    );
    const responseFloor =
      passwordResetMinimumResponseMilliseconds +
      randomInt(passwordResetJitterMilliseconds + 1);
    const startedAt = performance.now();
    try {
      await this.requestReset.execute(email);
    } finally {
      const remaining = responseFloor - (performance.now() - startedAt);
      if (remaining > 0) {
        await delay(remaining);
      }
    }
    return { accepted: true };
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmPasswordReset(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    enforceHttpRateLimit(
      this.rateLimiter,
      response,
      'password-reset-confirm',
      requestClientIp(request, this.configuration.nodeEnv),
      10,
    );
    const input = exactRequestBody(body, ['password', 'token']);
    await this.confirmReset.execute(
      requireBoundedString(input['token'], 32, 512),
      requireBoundedString(input['password'], 12, 128),
    );
  }
}
