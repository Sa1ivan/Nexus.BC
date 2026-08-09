import type { ActiveRelease } from '../../src/modules/sites/domain/active-release';
import type { Release } from '../../src/modules/sites/domain/release';

describe('release domain model contract', () => {
  it('owns the exact immutable release snapshot fields', () => {
    const release: Release = Object.freeze({
      id: 'release-id',
      projectId: 'project-id',
      operationId: 'operation-id',
      version: 3,
      siteConfig: Object.freeze({ schemaVersion: 4 }),
      schemaVersion: 4,
      publishedAt: new Date('2026-08-09T12:00:00.000Z'),
    });
    const assertReadonly = (value: Release): void => {
      // @ts-expect-error Release snapshots are immutable.
      value.version = 4;
    };

    expect(Object.keys(release)).toEqual([
      'id',
      'projectId',
      'operationId',
      'version',
      'siteConfig',
      'schemaVersion',
      'publishedAt',
    ]);
    expect(assertReadonly).toEqual(expect.any(Function));
  });

  it('owns only the immutable composite activation pointer fields', () => {
    const activeRelease: ActiveRelease = Object.freeze({
      projectId: 'project-id',
      releaseId: 'release-id',
      activatedAt: new Date('2026-08-09T12:00:00.000Z'),
    });
    const assertReadonly = (value: ActiveRelease): void => {
      // @ts-expect-error Activation identity is immutable in the domain view.
      value.releaseId = 'other-release-id';
    };

    expect(Object.keys(activeRelease)).toEqual([
      'projectId',
      'releaseId',
      'activatedAt',
    ]);
    expect(assertReadonly).toEqual(expect.any(Function));
  });
});
