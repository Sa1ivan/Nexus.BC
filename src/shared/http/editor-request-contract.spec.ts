import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { requireValidClientCapabilities } from './editor-request-contract';

function requestWithCapabilities(
  value: string | readonly string[] | undefined,
): Request {
  return {
    headers: {
      ...(value === undefined ? {} : { 'nexus-client-capabilities': value }),
    },
  } as unknown as Request;
}

function expectInvalid(value: string | readonly string[]): void {
  let rejection: unknown;
  try {
    requireValidClientCapabilities(requestWithCapabilities(value));
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(HttpException);
  if (!(rejection instanceof HttpException)) {
    throw new Error('Expected invalid capabilities rejection');
  }
  expect(rejection.getStatus()).toBe(400);
  expect(rejection.getResponse()).toMatchObject({
    code: 'INVALID_CLIENT_CAPABILITIES',
    message: 'Client capabilities are invalid',
  });
}

describe('Nexus-Client-Capabilities request contract', () => {
  it('keeps a missing header compatible during rollout', () => {
    expect(() =>
      requireValidClientCapabilities(requestWithCapabilities(undefined)),
    ).not.toThrow();
  });

  it.each([
    'site-config-read=4;site-config-write=4',
    'site-config-read=5;site-config-write=5',
    'site-config-read=4,5;site-config-write=4,5',
    'site-config-write=4,5;site-config-read=4,5',
  ])('accepts an exact ascending subset: %s', (value) => {
    expect(() =>
      requireValidClientCapabilities(requestWithCapabilities(value)),
    ).not.toThrow();
  });

  it.each([
    '',
    'site-config-read=4, 5;site-config-write=4,5',
    'site-config-read=5,4;site-config-write=4,5',
    'site-config-read=4,4;site-config-write=4,5',
    'site-config-read=4,5;site-config-write=6',
    'site-config-read=4,5',
    'site-config-read=4,5;site-config-read=4,5',
    'site-config-read=4,5;unknown=4,5',
    'site-config-read=4,5;site-config-write=',
    'site-config-read=4,5;site-config-write=4,5;unknown=4',
    'site-config-read=4,5;site-config-write=4,5\u00a0',
    'x'.repeat(129),
  ])(
    'rejects a malformed or over-limit value before business work',
    (value) => {
      expectInvalid(value);
    },
  );

  it('rejects a repeated HTTP header representation', () => {
    expectInvalid([
      'site-config-read=4,5;site-config-write=4,5',
      'site-config-read=4,5;site-config-write=4,5',
    ]);
  });
});
