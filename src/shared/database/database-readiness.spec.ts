import {
  checkDatabaseReadiness,
  DatabaseReadinessCoordinator,
} from './database-readiness';

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
    let aborted = false;
    const readiness = checkDatabaseReadiness(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
      100,
    );

    await jest.advanceTimersByTimeAsync(100);
    await expect(readiness).resolves.toBe(false);
    expect(aborted).toBe(true);
  });

  it('coalesces concurrent checks into one cancellable probe', async () => {
    let resolveProbe: (() => void) | undefined;
    const probe = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const coordinator = new DatabaseReadinessCoordinator(probe, 100);

    const first = coordinator.isReady();
    const second = coordinator.isReady();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});
