export const DATABASE_READINESS = 'DATABASE_READINESS';
export const DATABASE_READINESS_TIMEOUT_MS = 1_000;

export interface DatabaseReadiness {
  isReady(): Promise<boolean>;
}

export type DatabaseReadinessProbe = (signal: AbortSignal) => Promise<unknown>;

export class DatabaseReadinessCoordinator implements DatabaseReadiness {
  private inFlight: Promise<boolean> | undefined;

  constructor(
    private readonly probe: DatabaseReadinessProbe,
    private readonly timeoutMs = DATABASE_READINESS_TIMEOUT_MS,
  ) {}

  isReady(): Promise<boolean> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    const readiness = checkDatabaseReadiness(
      this.probe,
      this.timeoutMs,
    ).finally(() => {
      if (this.inFlight === readiness) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = readiness;
    return readiness;
  }
}

export async function checkDatabaseReadiness(
  probe: DatabaseReadinessProbe,
  timeoutMs = DATABASE_READINESS_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
    timeout.unref();
  });
  const probed = Promise.resolve()
    .then(() => probe(controller.signal))
    .then(
      () => true as const,
      () => false as const,
    );

  try {
    return await Promise.race([probed, timedOut]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
