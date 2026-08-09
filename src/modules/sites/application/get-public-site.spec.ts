import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type SiteConfigDocument,
  validateAndCanonicalizeSiteConfigV4Json,
} from '../domain/site-config-v4';
import {
  GetPublicSite,
  type PublicSiteConfiguration,
  type PublicSiteRepository,
} from './get-public-site';
import { SitesApplicationError } from './sites-errors';
import type { PublicReleaseSnapshot } from './sites.ports';

function siteConfigFixture(name: string): SiteConfigDocument {
  const serialized = readFileSync(
    resolve('contracts/site-config/fixtures', name),
    'utf8',
  );
  const validated = validateAndCanonicalizeSiteConfigV4Json(serialized);
  if (!validated.ok) {
    throw new Error(`Fixture ${name} is not a valid SiteConfig v4 document`);
  }
  return validated.value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const validSiteConfig = siteConfigFixture('v4-minimal-valid.json');

const release: PublicReleaseSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 3,
  schemaVersion: 4,
  siteConfig: validSiteConfig,
};

function configuration(
  privacyNoticeUrl: string,
  privacyNoticeVersion: string,
): PublicSiteConfiguration {
  return { privacyNoticeUrl, privacyNoticeVersion };
}

function repositoryFor(snapshot: PublicReleaseSnapshot): PublicSiteRepository {
  return {
    findActiveReleaseByPublicSlug: () => Promise.resolve(snapshot),
  };
}

describe('GetPublicSite', () => {
  it('rejects a corrupt stored snapshot as an internal error before projection', async () => {
    const pages = validSiteConfig['pages'];
    if (!Array.isArray(pages)) throw new Error('Expected fixture pages');
    const pageValues = pages as readonly unknown[];
    const firstPage = pageValues[0];
    if (!isRecord(firstPage)) throw new Error('Expected fixture page');
    const corruptRelease: PublicReleaseSnapshot = {
      ...release,
      siteConfig: {
        ...validSiteConfig,
        pages: [
          { ...firstPage, workspaceId: 'internal-workspace-id' },
          ...pageValues.slice(1),
        ],
      },
    };
    const repository = repositoryFor(corruptRelease);
    const execution = new GetPublicSite(
      repository,
      configuration('https://example.test/privacy', '2026-08-01'),
    ).execute({ publicSlug: 'public-site' });

    await expect(execution).rejects.toThrow(
      'Stored release SiteConfig v4 snapshot is invalid',
    );
    await expect(execution).rejects.not.toBeInstanceOf(SitesApplicationError);
  });

  it('changes the ETag when configured privacy notice data changes', async () => {
    const repository = repositoryFor(release);
    const first = await new GetPublicSite(
      repository,
      configuration('https://example.test/privacy', '2026-08-01'),
    ).execute({ publicSlug: 'public-site' });
    const changed = await new GetPublicSite(
      repository,
      configuration('https://example.test/legal/privacy', '2026-08-10'),
    ).execute({ publicSlug: 'public-site' });

    expect(changed.representation.privacyNotice).not.toEqual(
      first.representation.privacyNotice,
    );
    expect(changed.etag).not.toBe(first.etag);
  });

  it('changes the ETag when valid release content changes in place', async () => {
    const configurationValue = configuration(
      'https://example.test/privacy',
      '2026-08-01',
    );
    const firstRepository = repositoryFor(release);
    const changedRepository = repositoryFor({
      ...release,
      siteConfig: siteConfigFixture('v4-bundled-images-valid.json'),
    });
    const first = await new GetPublicSite(
      firstRepository,
      configurationValue,
    ).execute({ publicSlug: 'public-site' });
    const changed = await new GetPublicSite(
      changedRepository,
      configurationValue,
    ).execute({ publicSlug: 'public-site' });

    expect(changed.representation).not.toEqual(first.representation);
    expect(changed.etag).not.toBe(first.etag);
  });

  it('accepts If-None-Match wildcard only when it is the whole value', async () => {
    const repository = repositoryFor(release);
    const query = new GetPublicSite(
      repository,
      configuration('https://example.test/privacy', '2026-08-01'),
    );

    await expect(
      query.execute({ publicSlug: 'public-site', ifNoneMatch: ' \t* \t' }),
    ).resolves.toMatchObject({ notModified: true });
  });

  it('ignores an If-None-Match wildcard combined with a tag list', async () => {
    const repository = repositoryFor(release);
    const query = new GetPublicSite(
      repository,
      configuration('https://example.test/privacy', '2026-08-01'),
    );
    const current = await query.execute({ publicSlug: 'public-site' });

    await expect(
      query.execute({
        publicSlug: 'public-site',
        ifNoneMatch: `*, ${current.etag}`,
      }),
    ).resolves.toMatchObject({ notModified: false });
  });

  it('weakly matches valid strong, weak, and quoted-comma tag lists', async () => {
    const repository = repositoryFor(release);
    const query = new GetPublicSite(
      repository,
      configuration('https://example.test/privacy', '2026-08-01'),
    );
    const current = await query.execute({ publicSlug: 'public-site' });

    for (const ifNoneMatch of [
      current.etag,
      `W/${current.etag}`,
      `"other", ${current.etag}`,
      `"other,opaque", W/${current.etag}`,
    ]) {
      await expect(
        query.execute({ publicSlug: 'public-site', ifNoneMatch }),
      ).resolves.toMatchObject({ notModified: true });
    }
  });

  it('ignores malformed If-None-Match values instead of partially matching', async () => {
    const repository = repositoryFor(release);
    const query = new GetPublicSite(
      repository,
      configuration('https://example.test/privacy', '2026-08-01'),
    );
    const current = await query.execute({ publicSlug: 'public-site' });

    for (const ifNoneMatch of [
      `"unterminated, ${current.etag}`,
      `W/invalid, ${current.etag}`,
      `${current.etag},`,
      `"bad space", ${current.etag}`,
    ]) {
      await expect(
        query.execute({ publicSlug: 'public-site', ifNoneMatch }),
      ).resolves.toMatchObject({ notModified: false });
    }
  });
});
