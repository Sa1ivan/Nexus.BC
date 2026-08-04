import { checkDatabaseReadiness } from './database-readiness';

describe('database readiness timeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns true when the probe succeeds', async () => {
    await expect(
      checkDatabaseReadiness(() => Promise.resolve(), 100),
    ).resolves.toBe(true);
  });

  it('returns false when the probe rejects', async () => {
    await expect(
      checkDatabaseReadiness(() => Promise.reject(new Error('offline')), 100),
    ).resolves.toBe(false);
  });

  it('returns false when the probe never settles', async () => {
    jest.useFakeTimers();
    const readiness = checkDatabaseReadiness(
      () => new Promise<void>(() => undefined),
      100,
    );

    await jest.advanceTimersByTimeAsync(100);
    await expect(readiness).resolves.toBe(false);
  });
});
