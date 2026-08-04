export const DATABASE_READINESS = 'DATABASE_READINESS';
export const DATABASE_READINESS_TIMEOUT_MS = 1_000;

export interface DatabaseReadiness {
  isReady(): Promise<boolean>;
}

export async function checkDatabaseReadiness(
  probe: () => Promise<unknown>,
  timeoutMs = DATABASE_READINESS_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref();
  });
  const probed = Promise.resolve()
    .then(probe)
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
