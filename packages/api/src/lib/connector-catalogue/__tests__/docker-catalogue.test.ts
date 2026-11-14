import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { listedFromDocker, readDockerCatalogue } from '../docker-catalogue.js';
import { candidateOf } from '../policy.js';

const file = (path: string, yaml: string) => ({ path, content: Buffer.from(yaml), mode: 0o644 });

const NOTION = `name: notion-remote
type: remote
meta:
  category: productivity
about:
  title: Notion
  description: Manage projects and documentation
  icon: https://www.google.com/s2/favicons?domain=notion.so&sz=64
remote:
  transport_type: streamable-http
  url: https://mcp.notion.com/mcp
`;

const CONTEXT7 = `name: context7
type: remote
about:
  title: Context7
  description: Library documentation
remote:
  transport_type: streamable-http
  url: https://mcp.context7.com/mcp
  headers:
    CONTEXT7_API_KEY: "\${CONTEXT7_API_KEY}"
config:
  secrets:
    - name: context7.api_key
      env: CONTEXT7_API_KEY
      required: false
`;

const KEYED = CONTEXT7.replace('required: false', 'required: true').replace(/context7/g, 'keyed');

const fetchFiles = (files: ReturnType<typeof file>[]) =>
  (async () => ({ notModified: false, commit: 'a'.repeat(40), etag: null, files })) as never;

describe("Docker's MCP catalogue", () => {
  it('reads the remote entries, with provenance, and leaves the images Docker runs out', async () => {
    const pass = await readDockerCatalogue(
      fetchFiles([
        file('servers/notion-remote/server.yaml', NOTION),
        file('servers/sqlite/server.yaml', 'name: sqlite\ntype: server\nimage: mcp/sqlite\n'),
        file('servers/notion-remote/readme.md', '# Notion'),
        file('servers/broken/server.yaml', 'name: [unclosed'),
      ]),
    );
    expect(pass.malformed).toBe(1);
    expect(pass.servers.map((server) => server.name)).toEqual(['notion-remote']);
    const read = candidateOf(pass.servers[0] as never, {});
    expect(read).toMatchObject({
      ok: true,
      candidate: {
        id: 'docker:notion-remote',
        source: 'docker',
        name: 'Notion',
        url: 'https://mcp.notion.com/mcp',
        trust: 'verified',
        category: 'productivity',
      },
    });
  });

  it('takes a remote whose header is optional, and refuses one whose key is required', () => {
    const parse = (yaml: string) =>
      listedFromDocker(parseYaml(yaml) as Parameters<typeof listedFromDocker>[0], 'v1');
    expect(candidateOf(parse(CONTEXT7), {}).ok).toBe(true);
    expect(candidateOf(parse(KEYED), {})).toEqual({ ok: false, reason: 'requires_headers' });
  });
});
