import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SITE_CONFIG_V4_CANONICAL_BYTES_LIMIT,
  SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT,
  validateAndCanonicalizeSiteConfigV4Json,
} from '../../src/modules/sites/domain/site-config-v4';

const contractRoot = join(process.cwd(), 'contracts/site-config');

function fixture(name: string): string {
  return readFileSync(join(contractRoot, 'fixtures', name), 'utf8');
}

function validConfig(): Record<string, unknown> {
  return JSON.parse(fixture('valid-v4.json')) as Record<string, unknown>;
}

describe('SiteConfig v4 cloud contract', () => {
  it('keeps every frozen artifact covered by the SHA-256 manifest', () => {
    const manifest = readFileSync(
      join(contractRoot, 'manifest.sha256'),
      'utf8',
    ).trim();
    const manifestPaths = manifest.split('\n').map((line) => line.slice(66));
    const actualPaths = [
      'v4.schema.json',
      ...readdirSync(join(contractRoot, 'fixtures')).map(
        (name) => `fixtures/${name}`,
      ),
    ].sort();

    expect([...new Set(manifestPaths)].sort()).toEqual(actualPaths);
    expect(manifestPaths).toHaveLength(actualPaths.length);

    for (const line of manifest.split('\n')) {
      const match = /^(?<hash>[a-f\d]{64}) {2}(?<path>.+)$/u.exec(line);
      expect(match?.groups).toBeDefined();

      const bytes = readFileSync(join(contractRoot, match!.groups!['path']!));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        match!.groups!['hash'],
      );
    }
  });

  it('bounds every schema array and explicit string while excluding chrome from page blocks', () => {
    const schema = JSON.parse(
      readFileSync(join(contractRoot, 'v4.schema.json'), 'utf8'),
    ) as Record<string, unknown>;
    const arrays: Record<string, unknown>[] = [];
    const strings: Record<string, unknown>[] = [];
    const objects: Record<string, unknown>[] = [];

    visitSchema(schema, (node) => {
      if (node['type'] === 'array') arrays.push(node);
      if (node['type'] === 'string') strings.push(node);
      if (node['type'] === 'object') objects.push(node);
    });

    expect(arrays.length).toBeGreaterThan(0);
    expect(arrays.every((node) => typeof node['maxItems'] === 'number')).toBe(
      true,
    );
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.every((node) => typeof node['maxLength'] === 'number')).toBe(
      true,
    );
    expect(objects.length).toBeGreaterThan(0);
    expect(
      objects.every((node) => node['additionalProperties'] === false),
    ).toBe(true);
    const rootProperties = schema['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const pages = rootProperties['pages']!;
    const page = pages['items'] as Record<string, unknown>;
    const pageProperties = page['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const blocks = pageProperties['blocks']!;
    const blockUnion = blocks['items'] as Record<string, unknown>;
    const blockTypes = (blockUnion['oneOf'] as Record<string, unknown>[]).map(
      (blockSchema) => {
        const properties = blockSchema['properties'] as Record<
          string,
          Record<string, unknown>
        >;
        return properties['type']!['const'];
      },
    );

    expect(blockTypes).toEqual([
      'hero',
      'contentMedia',
      'featureGrid',
      'offerList',
      'gallery',
      'testimonials',
      'faq',
      'callToAction',
      'leadForm',
    ]);

    const definitions = schema['definitions'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(definitions['id']!['maxLength']).toBe(128);
    expect(definitions['slug']!['maxLength']).toBe(128);
    expect(definitions['url']!['maxLength']).toBe(2_048);
    expect(definitions['label']!['maxLength']).toBe(256);
    expect(definitions['shortText']!['maxLength']).toBe(256);
    expect(definitions['longText']!['maxLength']).toBe(10_000);
    expect(pages).toMatchObject({ minItems: 1, maxItems: 50 });
    expect(blocks['maxItems']).toBe(100);

    const leadForm = (blockUnion['oneOf'] as Record<string, unknown>[]).at(-1)!;
    const leadProperties = leadForm['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(leadProperties['fields']!['maxItems']).toBe(32);
    expect(SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT).toBe(1_310_720);
    expect(SITE_CONFIG_V4_CANONICAL_BYTES_LIMIT).toBe(1_048_576);
  });

  it('accepts exact v4 and canonicalizes bundled media paths deterministically', () => {
    const result = validateAndCanonicalizeSiteConfigV4Json(
      fixture('valid-v4.json'),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonicalJson).toContain(
        '"src":"images/landing/office-studio.webp"',
      );
      expect(result.canonicalJson).not.toContain('./images/');
      expect(result.canonicalBytes).toBe(
        Buffer.byteLength(result.canonicalJson),
      );
      expect(result.canonicalBytes).toBeLessThanOrEqual(
        SITE_CONFIG_V4_CANONICAL_BYTES_LIMIT,
      );
    }
  });

  it.each([
    ['legacy-v3.json', 'unsupported-schema'],
    ['future-v5.json', 'unsupported-schema'],
    ['invalid-data-url-v4.json', 'invalid-site-config'],
    ['invalid-unsafe-path-v4.json', 'invalid-site-config'],
  ] as const)('rejects %s with %s', (name, code) => {
    expect(
      validateAndCanonicalizeSiteConfigV4Json(fixture(name)),
    ).toMatchObject({
      ok: false,
      code,
    });
  });

  it('rejects an oversized JSON envelope before parsing', () => {
    const serialized = `{"schemaVersion":4,"padding":"${'x'.repeat(
      SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT,
    )}"}`;

    expect(validateAndCanonicalizeSiteConfigV4Json(serialized)).toEqual({
      ok: false,
      code: 'json-envelope-too-large',
    });
  });

  it('rejects JSON nesting deeper than 32', () => {
    const serialized = `${'{"nested":'.repeat(33)}null${'}'.repeat(33)}`;

    expect(validateAndCanonicalizeSiteConfigV4Json(serialized)).toEqual({
      ok: false,
      code: 'json-depth-exceeded',
    });
  });

  it('ignores braces, brackets, and escaped quotes inside JSON strings during depth preflight', () => {
    const config = validConfig();
    config['name'] = `${'{['.repeat(40)}\\"${']}'.repeat(40)}`;

    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(config)),
    ).toMatchObject({
      ok: true,
    });
  });

  it('enforces schema shape and semantic uniqueness', () => {
    const withExtraProperty = { ...validConfig(), unexpected: true };
    const duplicatePage = structuredClone(validConfig());
    const pages = duplicatePage['pages'] as Record<string, unknown>[];
    pages.push(structuredClone(pages[0]!));

    expect(
      validateAndCanonicalizeSiteConfigV4Json(
        JSON.stringify(withExtraProperty),
      ),
    ).toMatchObject({ ok: false, code: 'invalid-site-config' });
    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(duplicatePage)),
    ).toMatchObject({
      ok: false,
      code: 'invalid-site-config',
    });
  });

  it('rejects credentialed HTTPS and page-owned chrome', () => {
    const credentialedLink = structuredClone(validConfig());
    const chrome = credentialedLink['chrome'] as Record<
      string,
      Record<string, unknown>
    >;
    const header = chrome['header']!;
    header['cta'] = {
      ...(header['cta'] as Record<string, unknown>),
      target: 'https://user:secret@example.com',
    };

    const pageOwnedChrome = structuredClone(validConfig());
    const page = (pageOwnedChrome['pages'] as Record<string, unknown>[])[0]!;
    const ownedHeader = structuredClone(
      (pageOwnedChrome['chrome'] as Record<string, unknown>)['header'],
    ) as Record<string, unknown>;
    ownedHeader['id'] = 'page-header';
    ownedHeader['anchor'] = 'page-header';
    (page['blocks'] as unknown[]).push(ownedHeader);

    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(credentialedLink)),
    ).toMatchObject({ ok: false, code: 'invalid-site-config' });
    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(pageOwnedChrome)),
    ).toMatchObject({
      ok: false,
      code: 'invalid-site-config',
    });
  });

  it.each([
    'http://example.com/image.png',
    'https://user:secret@example.com/image.png',
    'https://cdn.example.com/%2e%2e/secrets.png',
    'https://cdn.example.com/%252e%252e/secrets.png',
    'https://cdn.example.com/image%2500.png',
    'https://cdn.example.com\\..\\secrets.png',
    '//example.com/image.png',
    'blob:https://example.com/id',
    'file:///tmp/image.png',
    '/assets/image.png',
    '/builder/image.png',
    'images/image.png?download=1',
    'images/image.png#fragment',
    'images\\image.png',
    'images/%2e%2e/secrets.png',
    'images/%252e%252e/secrets.png',
    'images/image%2500.png',
    'images/folder/%2Fsecrets.png',
    'images/folder/\u0000image.png',
  ])('rejects unsafe media source %s', (src) => {
    const config = validConfig();
    const page = (config['pages'] as Record<string, unknown>[])[0]!;
    const hero = (page['blocks'] as Record<string, unknown>[])[0]!;
    (hero['media'] as Record<string, unknown>)['src'] = src;

    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(config)),
    ).toMatchObject({
      ok: false,
      code: 'invalid-site-config',
    });
  });

  it('accepts credential-free HTTPS media', () => {
    const config = validConfig();
    const page = (config['pages'] as Record<string, unknown>[])[0]!;
    const hero = (page['blocks'] as Record<string, unknown>[])[0]!;
    (hero['media'] as Record<string, unknown>)['src'] =
      'https://cdn.example.com/image.png';

    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(config)),
    ).toMatchObject({
      ok: true,
    });
  });

  it.each([
    'http://example.com',
    'https://user:secret@example.com',
    '//example.com',
    'javascript:alert(1)',
    '/builder/../admin',
    '/safe/%2e%2e/admin',
    '/safe/%252e%252e/admin',
    '/safe/name%2500',
    'https://example.com/\u0000bad',
  ])('rejects unsafe link target %s', (target) => {
    const config = validConfig();
    const chrome = config['chrome'] as Record<string, Record<string, unknown>>;
    const header = chrome['header']!;
    header['cta'] = { ...(header['cta'] as Record<string, unknown>), target };

    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(config)),
    ).toMatchObject({
      ok: false,
      code: 'invalid-site-config',
    });
  });

  it.each([
    ['anchor', '/internal'],
    ['internal', 'https://example.com'],
    ['external', '#anchor'],
    ['email', 'tel:+79990000000'],
    ['phone', 'mailto:hello@example.com'],
  ])('requires link kind %s to match target %s', (kind, target) => {
    const config = validConfig();
    const chrome = config['chrome'] as Record<string, Record<string, unknown>>;
    const header = chrome['header']!;
    header['cta'] = {
      ...(header['cta'] as Record<string, unknown>),
      kind,
      target,
    };

    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(config)),
    ).toMatchObject({ ok: false, code: 'invalid-site-config' });
  });

  it('requires footer map embedUrl to be credential-free HTTPS', () => {
    const config = validConfig();
    const chrome = config['chrome'] as Record<string, Record<string, unknown>>;
    chrome['footer']!['map'] = {
      label: 'Map',
      address: 'Address',
      embedUrl: '/internal-map',
    };

    expect(
      validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(config)),
    ).toMatchObject({ ok: false, code: 'invalid-site-config' });
  });

  it('enforces global block ids, rendered-page anchors, collection ids, and form field ids', () => {
    const variants = [
      duplicateGlobalBlockId(validConfig()),
      duplicateRenderedPageAnchor(validConfig()),
      duplicateCollectionItemId(validConfig()),
      duplicateFormFieldId(validConfig()),
      duplicateContainedLinkId(validConfig()),
    ];

    for (const config of variants) {
      expect(
        validateAndCanonicalizeSiteConfigV4Json(JSON.stringify(config)),
      ).toMatchObject({
        ok: false,
        code: 'invalid-site-config',
      });
    }
  });

  it('rejects a schema-valid canonical document larger than 1 MiB', () => {
    const config = validConfig();
    config['pages'] = Array.from({ length: 50 }, (_, pageIndex) => ({
      id: `page-${pageIndex}`,
      slug: `page-${pageIndex}`,
      title: `Page ${pageIndex}`,
      seo: {
        title: `Page ${pageIndex}`,
        description: '',
        socialImage: null,
        noIndex: false,
      },
      blocks: Array.from({ length: 100 }, (_, blockIndex) => ({
        id: `block-${pageIndex}-${blockIndex}`,
        anchor: `block-${blockIndex}`,
        type: 'contentMedia',
        hidden: false,
        variant: 'textOnly',
        eyebrow: '',
        title: 'Content',
        body: 'x'.repeat(90),
      })),
    }));
    const serialized = JSON.stringify(config);

    expect(Buffer.byteLength(serialized)).toBeGreaterThan(
      SITE_CONFIG_V4_CANONICAL_BYTES_LIMIT,
    );
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT,
    );
    expect(validateAndCanonicalizeSiteConfigV4Json(serialized)).toEqual({
      ok: false,
      code: 'canonical-document-too-large',
    });
  });
});

function visitSchema(
  value: unknown,
  visitor: (node: Record<string, unknown>) => void,
): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => visitSchema(item, visitor));
    return;
  }

  const node = value as Record<string, unknown>;
  visitor(node);
  Object.values(node).forEach((item) => visitSchema(item, visitor));
}

function duplicateGlobalBlockId(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const chrome = config['chrome'] as Record<string, Record<string, unknown>>;
  const page = (config['pages'] as Record<string, unknown>[])[0]!;
  const block = (page['blocks'] as Record<string, unknown>[])[0]!;
  block['id'] = chrome['header']!['id'];
  return config;
}

function duplicateRenderedPageAnchor(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const chrome = config['chrome'] as Record<string, Record<string, unknown>>;
  const page = (config['pages'] as Record<string, unknown>[])[0]!;
  const block = (page['blocks'] as Record<string, unknown>[])[0]!;
  block['anchor'] = chrome['header']!['anchor'];
  return config;
}

function duplicateCollectionItemId(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const page = (config['pages'] as Record<string, unknown>[])[0]!;
  (page['blocks'] as Record<string, unknown>[]).push({
    id: 'faq-home',
    anchor: 'faq',
    type: 'faq',
    hidden: false,
    variant: 'borderedAccordion',
    eyebrow: '',
    title: 'FAQ',
    description: '',
    allowMultipleOpen: false,
    items: [
      {
        id: 'duplicate',
        question: 'One?',
        answer: 'One.',
        initiallyOpen: false,
      },
      {
        id: 'duplicate',
        question: 'Two?',
        answer: 'Two.',
        initiallyOpen: false,
      },
    ],
  });
  return config;
}

function duplicateFormFieldId(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const page = (config['pages'] as Record<string, unknown>[])[0]!;
  const lead = (page['blocks'] as Record<string, unknown>[])[1]!;
  const field = (lead['fields'] as Record<string, unknown>[])[0]!;
  (lead['fields'] as Record<string, unknown>[]).push(structuredClone(field));
  return config;
}

function duplicateContainedLinkId(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const chrome = config['chrome'] as Record<string, Record<string, unknown>>;
  const header = chrome['header']!;
  const navigationItems = header['navigationItems'] as Record<
    string,
    unknown
  >[];
  navigationItems.push(structuredClone(navigationItems[0]!));
  return config;
}
