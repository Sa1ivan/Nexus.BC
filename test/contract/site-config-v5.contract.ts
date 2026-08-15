import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  upconvertSiteConfigV4ToV5,
  validateAndCanonicalizeSiteConfigV5Json,
} from '../../src/modules/sites/domain/site-config-v5';
import { validateAndCanonicalizeSiteConfigV4Json } from '../../src/modules/sites/domain/site-config-v4';
import { siteConfigWriteHandlers } from '../../src/modules/sites/domain/site-config-write-handlers';
import { siteConfigRolloutHandlers } from '../../src/shared/config/site-config-rollout';

function fixture(name: string): string {
  return readFileSync(resolve('contracts/site-config/fixtures', name), 'utf8');
}

function fixtureObject(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fixture(name));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected ${name} to contain an object`);
  }
  return parsed as Record<string, unknown>;
}

function firstHeroMedia(
  document: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const pages = document['pages'];
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('Expected a page fixture');
  }
  const pageValues = pages as readonly unknown[];
  const page = pageValues[0];
  if (typeof page !== 'object' || page === null || Array.isArray(page)) {
    throw new Error('Expected a page object');
  }
  const blocks = (page as Readonly<Record<string, unknown>>)['blocks'];
  if (!Array.isArray(blocks)) throw new Error('Expected page blocks');
  const blockValues = blocks as readonly unknown[];
  const hero = blockValues.find(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      !Array.isArray(block) &&
      (block as Readonly<Record<string, unknown>>)['type'] === 'hero',
  );
  if (typeof hero !== 'object' || hero === null || Array.isArray(hero)) {
    throw new Error('Expected a hero block');
  }
  const media = (hero as Readonly<Record<string, unknown>>)['media'];
  if (typeof media !== 'object' || media === null || Array.isArray(media)) {
    throw new Error('Expected hero media');
  }
  return media as Readonly<Record<string, unknown>>;
}

describe('SiteConfig v5 rollout contract', () => {
  it('derives the exact capability tuple from each rollout mode', () => {
    expect(siteConfigRolloutHandlers.V4_COMPAT.capabilities).toEqual({
      rolloutMode: 'V4_COMPAT',
      readVersions: [4, 5],
      acceptedInputVersions: [4],
      writeVersion: 4,
    });
    expect(siteConfigRolloutHandlers.V5_ACTIVE.capabilities).toEqual({
      rolloutMode: 'V5_ACTIVE',
      readVersions: [4, 5],
      acceptedInputVersions: [4, 5],
      writeVersion: 5,
    });
  });

  it('up-converts safe v4 media into the discriminated v5 union', () => {
    const externalInput = fixtureObject('v4-full-valid.json');
    Object.assign(firstHeroMedia(externalInput), {
      src: 'https://cdn.example.com/external.webp',
    });
    const bundledV4 = validateAndCanonicalizeSiteConfigV4Json(
      fixture('v4-bundled-dot-images-valid.json'),
    );
    const externalV4 = validateAndCanonicalizeSiteConfigV4Json(
      JSON.stringify(externalInput),
    );
    expect(bundledV4.ok).toBe(true);
    expect(externalV4.ok).toBe(true);
    if (!bundledV4.ok || !externalV4.ok) return;

    const bundledV5 = upconvertSiteConfigV4ToV5(bundledV4.value);
    const externalV5 = upconvertSiteConfigV4ToV5(externalV4.value);

    expect(firstHeroMedia(bundledV5)).toMatchObject({
      kind: 'bundled',
      path: 'images/landing/office-studio.webp',
      alt: 'Рабочая зона',
    });
    expect(firstHeroMedia(bundledV5)).not.toHaveProperty('src');
    expect(firstHeroMedia(externalV5)['kind']).toBe('external');
    expect(firstHeroMedia(externalV5)['src']).toMatch(/^https:\/\//u);
    expect(bundledV5['schemaVersion']).toBe(5);
    expect(
      validateAndCanonicalizeSiteConfigV5Json(JSON.stringify(bundledV5)),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ['v5-managed-valid.json', true],
    ['v5-managed-missing-asset-id.json', false],
    ['v5-external-unsafe.json', false],
    ['v5-bundled-traversal.json', false],
  ] as const)('validates the frozen v5 media fixture %s', (name, accepted) => {
    expect(validateAndCanonicalizeSiteConfigV5Json(fixture(name)).ok).toBe(
      accepted,
    );
  });

  it('keeps accepted input and stored output coupled to the rollout mode', () => {
    const v4 = fixtureObject('v4-full-valid.json');
    const v5 = fixtureObject('v5-managed-valid.json');

    const compatV4 = siteConfigWriteHandlers.V4_COMPAT.canonicalizeInput(v4);
    expect(compatV4.schemaVersion).toBe(4);
    expect(
      siteConfigWriteHandlers.V4_COMPAT.prepareWrite(compatV4).schemaVersion,
    ).toBe(4);
    expect(() =>
      siteConfigWriteHandlers.V4_COMPAT.canonicalizeInput(v5),
    ).toThrow('SiteConfig input is invalid for V4_COMPAT');

    const activeV4 = siteConfigWriteHandlers.V5_ACTIVE.canonicalizeInput(v4);
    const activeV5 = siteConfigWriteHandlers.V5_ACTIVE.canonicalizeInput(v5);
    expect(
      siteConfigWriteHandlers.V5_ACTIVE.prepareWrite(activeV4).schemaVersion,
    ).toBe(5);
    expect(
      siteConfigWriteHandlers.V5_ACTIVE.prepareWrite(activeV5).schemaVersion,
    ).toBe(5);
    expect(
      siteConfigWriteHandlers.V5_ACTIVE.prepareWrite(activeV4).document[
        'schemaVersion'
      ],
    ).toBe(5);
  });
});
