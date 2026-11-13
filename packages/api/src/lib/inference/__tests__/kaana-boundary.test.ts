import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const read = (relativePath: string): string =>
  readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

const retiredRuntimeFiles = [
  'kaana.ts',
  'kaana-client.ts',
  'kaana-transport.ts',
  'kaana-endpoint.ts',
  'kaana-request.ts',
  'kaana-error.ts',
  'kaana-connectivity.ts',
  'kaana-catalogue.ts',
  'kaana-openai-adapter.ts',
] as const;

describe('Gemies to Kaana boundary', () => {
  it('has no bespoke signer or wire transport', () => {
    for (const file of retiredRuntimeFiles) {
      expect(existsSync(path.join(REPO_ROOT, 'packages/api/src/lib/inference', file)), file).toBe(
        false,
      );
    }
  });

  it('uses the published Kaana workload transport', () => {
    const source = read('packages/api/src/lib/kaana/transport.ts');
    expect(source).toContain("import { kaanaForOxyService } from '@kaana.ai/sdk/server'");
    expect(source).toContain('kaanaForOxyService(oxy');
  });

  it('does not configure direct Kaana signing or a direct Kaana origin', () => {
    const activeFiles = [
      '.github/workflows/deploy-aws.yml',
      'packages/api/.env.example',
      'packages/api/src/lib/kaana/transport.ts',
      'packages/api/src/lib/inference/workload-identity-config.ts',
    ];
    const forbidden = [
      'KAANA_EDGE_SIGNING_PRIVATE_KEY',
      'KAANA_EDGE_KEY_ID',
      'KAANA_BASE_URL',
      '/internal/v1/inference',
      'x-kaana-signature',
    ];
    for (const file of activeFiles) {
      // The deploy workflow names retired variables only in explicit removal
      // lists. Exclude those two declarations from the active-configuration
      // census; deployWorkflow.test.ts separately proves the lists are exact
      // and the ECS renderer really deletes them.
      const source = read(file)
        .split('\n')
        .filter((line) => !/TASK_(?:SECRET|CONFIGURATION)_REMOVALS_JSON:/.test(line))
        .join('\n');
      for (const token of forbidden) expect(source, `${file}: ${token}`).not.toContain(token);
    }
  });
});
