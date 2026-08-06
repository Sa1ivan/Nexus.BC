export interface ReadinessDatabaseClient {
  query(statement: string): Promise<unknown>;
  release(destroy?: boolean): void;
}

export interface ReadinessDatabasePool {
  connect(): Promise<ReadinessDatabaseClient>;
}

export async function probeDatabaseConnection(
  pool: ReadinessDatabasePool,
  signal: AbortSignal,
): Promise<void> {
  const client = await pool.connect();
  let released = false;
  const release = (destroy: boolean): void => {
    if (released) return;
    released = true;
    client.release(destroy);
  };
  const abort = (): void => release(true);

  if (signal.aborted) {
    release(true);
    throw new Error('Database readiness probe was cancelled');
  }

  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.query('SELECT 1');
  } finally {
    signal.removeEventListener('abort', abort);
    release(false);
  }
}
