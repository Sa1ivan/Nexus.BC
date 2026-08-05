import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { createApiHttpException } from './api-error.filter';

interface RateWindow {
  count: number;
  readonly expiresAt: number;
}

const maximumTrackedWindows = 10_000;
const sweepIntervalMilliseconds = 60_000;

class HttpRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('HTTP_RATE_LIMITED');
  }
}

@Injectable()
export class HttpRateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  private nextSweepAt = 0;

  assert(
    endpoint: string,
    subject: string,
    limit: number,
    windowMilliseconds = 60_000,
  ): void {
    const now = Date.now();
    const key = `${endpoint}:${subject}`;
    this.sweepExpired(now);
    const current = this.windows.get(key);
    if (current === undefined || current.expiresAt <= now) {
      if (this.windows.size >= maximumTrackedWindows) {
        throw new HttpRateLimitError(
          Math.max(1, Math.ceil(windowMilliseconds / 1000)),
        );
      }
      this.windows.set(key, {
        count: 1,
        expiresAt: now + windowMilliseconds,
      });
      return;
    }
    if (current.count >= limit) {
      throw new HttpRateLimitError(
        Math.max(1, Math.ceil((current.expiresAt - now) / 1000)),
      );
    }
    current.count += 1;
  }

  private sweepExpired(now: number): void {
    if (now < this.nextSweepAt) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) {
        this.windows.delete(key);
      }
    }
    this.nextSweepAt = now + sweepIntervalMilliseconds;
  }
}

export function enforceHttpRateLimit(
  limiter: HttpRateLimiter,
  response: Response,
  endpoint: string,
  subject: string,
  limit: number,
): void {
  try {
    limiter.assert(endpoint, subject, limit);
  } catch (error) {
    if (!(error instanceof HttpRateLimitError)) {
      throw error;
    }
    response.setHeader('Retry-After', String(error.retryAfterSeconds));
    throw createApiHttpException(429, 'RATE_LIMITED', 'Too many requests', {
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
}
