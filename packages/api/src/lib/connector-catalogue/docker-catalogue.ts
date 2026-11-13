/**
 * Reading Docker's MCP catalogue (`github.com/docker/mcp-registry`), the store's second source.
 *
 * Docker keeps its catalogue as one `servers/<name>/server.yaml` per server in a public repository
 * under the MIT licence, and reviews every entry before it is merged. Most entries are images Docker
 * runs locally (never offered here); the `type: remote` ones are providers' remote servers, and those
 * are the ones read. One pass is one download of the repository's archive from `codeload.github.com`
 * (`fetchRepositoryFiles`, shared with the skill catalogue, which honours GitHub's rate limits).
 *
 * A Docker entry has no namespace its publisher proved, so its badge is `verified` (a reviewed
 * catalogue lists it), never `official`. The official MCP Registry is the primary source: an endpoint
 * it already lists is not taken from Docker (`sync.ts`). An entry's version is its file's digest, so
 * a commit that leaves it unchanged changes nothing.
 */

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ConnectorCategory } from '../../db/schema/integrations.js';
import { GitHubRateLimitError, fetchRepositoryFiles } from '../skills/github.js';
import { CatalogueRateLimitError, type CataloguePass, type ListedServer } from './policy.js';

export const DOCKER_CATALOGUE_REPOSITORY = { owner: 'docker', repo: 'mcp-registry' } as const;
const SERVER_FILE = /^servers\/([^/]+)\/server\.yaml$/;

/** Where an entry of Docker's catalogue is read, for its provenance. */
export function dockerListingUrl(name: string): string {
  return `https://github.com/${DOCKER_CATALOGUE_REPOSITORY.owner}/${DOCKER_CATALOGUE_REPOSITORY.repo}/blob/main/servers/${encodeURIComponent(name)}/server.yaml`;
}
/** A `server.yaml` larger than this is not one: it is skipped as malformed. */
const MAX_SERVER_FILE_BYTES = 64 * 1024;

const serverYaml = z.object({
  name: z.string(),
  type: z.string(),
  meta: z.object({ category: z.string().optional() }).partial().optional(),
  about: z
    .object({ title: z.string(), description: z.string(), icon: z.string() })
    .partial()
    .optional(),
  source: z.object({ project: z.string() }).partial().optional(),
  remote: z
    .object({
      transport_type: z.string().optional(),
      url: z.string(),
      headers: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  config: z
    .object({
      secrets: z
        .array(
          z.object({
            name: z.string().optional(),
            env: z.string().optional(),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .partial()
    .optional(),
});

type DockerServer = z.infer<typeof serverYaml>;

/** Docker's categories that map onto the store's; any other is read from the server's words. */
const DOCKER_CATEGORIES: ReadonlyMap<string, ConnectorCategory> = new Map([
  ['productivity', 'productivity'],
  ['communication', 'communication'],
  ['devops', 'development'],
  ['developer-tools', 'development'],
  ['monitoring', 'development'],
  ['security', 'development'],
  ['database', 'data'],
  ['analytics', 'data'],
  ['documentation', 'search'],
  ['search', 'search'],
  ['payments', 'finance'],
  ['finance', 'finance'],
  ['blockchain', 'finance'],
  ['crm', 'marketing'],
  ['marketing', 'marketing'],
  ['e-commerce', 'commerce'],
  ['ecommerce', 'commerce'],
  ['design', 'design'],
]);

/**
 * Whether a header the remote sends is one the person must fill in: a header naming a secret
 * (`${CONTEXT7_API_KEY}`) is required unless that secret is marked `required: false`.
 */
function requiresHeaders(server: DockerServer): boolean {
  const headers = Object.values(server.remote?.headers ?? {});
  if (headers.length === 0) return false;
  const optional = new Set(
    (server.config?.secrets ?? [])
      .filter((secret) => secret.required === false)
      .flatMap((secret) => (secret.env ? [secret.env] : [])),
  );
  return headers.some((value) => {
    const named = typeof value === 'string' ? [...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)] : [];
    return named.length === 0 ? false : named.some((match) => !optional.has(match[1] ?? ''));
  });
}

/** A Docker entry as the store judges every catalogue's (`policy.ts`). */
export function listedFromDocker(server: DockerServer, version: string): ListedServer {
  const remote = server.remote;
  return {
    source: 'docker',
    name: server.name,
    version,
    updatedAt: null,
    active: true,
    title: server.about?.title,
    description: server.about?.description,
    repositoryUrl: server.source?.project,
    icons: server.about?.icon ? [{ src: server.about.icon }] : [],
    remotes:
      server.type === 'remote' && remote
        ? [
            {
              type: remote.transport_type ?? 'streamable-http',
              url: remote.url,
              requiresHeaders: requiresHeaders(server),
              templated: remote.url.includes('{') || remote.url.includes('${'),
            },
          ]
        : [],
    publisher: null,
    category: DOCKER_CATEGORIES.get(server.meta?.category?.toLowerCase() ?? ''),
    trustAt: () => 'verified',
  };
}

/** Every remote server of Docker's catalogue at its default branch. Throws on any failure. */
export async function readDockerCatalogue(
  fetchFiles: typeof fetchRepositoryFiles = fetchRepositoryFiles,
): Promise<CataloguePass> {
  let read: Awaited<ReturnType<typeof fetchRepositoryFiles>>;
  try {
    read = await fetchFiles({ ...DOCKER_CATALOGUE_REPOSITORY, path: 'servers' });
  } catch (err: unknown) {
    if (err instanceof GitHubRateLimitError) {
      throw new CatalogueRateLimitError(new Date(Date.now() + err.retryAfterMs), 'GitHub');
    }
    throw err;
  }
  if (read.notModified) throw new Error('GitHub answered 304 to a request that sent no validator');

  const servers: ListedServer[] = [];
  let malformed = 0;
  for (const file of read.files) {
    if (!SERVER_FILE.test(file.path)) continue;
    if (file.symlink || file.content.byteLength > MAX_SERVER_FILE_BYTES) {
      malformed += 1;
      continue;
    }
    try {
      const parsed = serverYaml.safeParse(parseYaml(file.content.toString('utf8')));
      if (!parsed.success) {
        malformed += 1;
        continue;
      }
      // Entries Docker runs as images are packages, never offered: only remotes are listed.
      if (parsed.data.type !== 'remote') continue;
      const digest = createHash('sha256').update(file.content).digest('hex').slice(0, 12);
      servers.push(listedFromDocker(parsed.data, digest));
    } catch {
      malformed += 1;
    }
  }
  if (servers.length === 0) throw new Error("Docker's catalogue listed no remote server");
  return { servers, malformed };
}
