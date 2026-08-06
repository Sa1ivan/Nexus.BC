import { probeDatabaseConnection } from './cancellable-database-probe';

describe('cancellable database probe', () => {
  it('destroys the checked-out connection when the readiness signal aborts', async () => {
    let rejectQuery: ((error: Error) => void) | undefined;
    const release = jest.fn((destroy?: boolean) => {
      if (destroy === true) rejectQuery?.(new Error('connection destroyed'));
    });
    const client = {
      query: jest.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectQuery = reject;
          }),
      ),
      release,
    };
    const pool = { connect: jest.fn(() => Promise.resolve(client)) };
    const controller = new AbortController();

    const probe = probeDatabaseConnection(pool, controller.signal);
    await Promise.resolve();
    controller.abort();

    await expect(probe).rejects.toThrow('connection destroyed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });
});
