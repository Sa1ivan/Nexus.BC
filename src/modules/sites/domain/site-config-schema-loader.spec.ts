import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSiteConfigSchemaPath } from './site-config-schema-loader';

describe('SiteConfig schema loader', () => {
  it('ignores a shadow contract in process.cwd()', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-schema-loader-'));
    const project = join(root, 'project');
    const moduleDirectory = join(project, 'src/modules/sites/domain');
    const expected = join(project, 'contracts/site-config/v4.schema.json');
    const shadowRoot = join(root, 'shadow');
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(join(project, 'contracts/site-config'), { recursive: true });
    mkdirSync(join(shadowRoot, 'contracts/site-config'), { recursive: true });
    writeFileSync(expected, '{"trusted":true}');
    writeFileSync(
      join(shadowRoot, 'contracts/site-config/v4.schema.json'),
      '{"trusted":false}',
    );
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(shadowRoot);

    try {
      expect(resolveSiteConfigSchemaPath(moduleDirectory)).toBe(expected);
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
