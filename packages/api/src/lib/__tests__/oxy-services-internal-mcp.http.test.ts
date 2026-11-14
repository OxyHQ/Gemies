/** Installed candidate SDK and MCP over HTTP. Remote Oxy authority and effect storage
 * are explicit synthetic fixtures; Mention's independent PG receiver tests prove durability. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { AppCapabilityCatalog, CapabilityCatalogBinding } from '@oxy.so/contracts';
import { canonicalCapabilityJson } from '@oxy.so/contracts';
import type { OxyToolExecutionContext } from '../tools/oxy-services.js';
import { createInternalCatalogMcpHttpService } from '@oxy.so/mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: undefined as unknown, warn: vi.fn(), error: vi.fn() }));
vi.mock('../oxy.js', () => ({
  get oxy() {
    return state.client;
  },
}));
vi.mock('../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: state.warn, error: state.error } },
}));
// Bypass only Vitest's auth-stub alias, resolving the actual installed candidate package.
const real: typeof import('@oxy.so/core/server') = createRequire(import.meta.url)(
  '@oxy.so/core/server',
);
const keys = generateKeyPairSync('ed25519');
/** A secret-looking string Oxy echoes in its refusals: it must never reach a log. */
const requester = 'fixture-present-requester';
const serviceToken = 'fixture-alia-service';
const account = 'fixture-owner';
const servers: Server[] = [];
let issuer: string;
let catalog: AppCapabilityCatalog;
let binding: CapabilityCatalogBinding;
let denyTickets = false;
let denyReceiver = false;
let receiverNotReady = false;
let dropCallConnection = false;
let receiverPosts = 0;
let loseResponseAfterEffect = false;
let destroyReceiverResponse: () => void;
let registryFailure: 'digest' | 'missing-id' | 'version' | undefined;
let wrongResource = false;
let alive = true;
let approvals = 0;
let effects = 0;
let legacyCalls = 0;
let authorityBodies: Array<Record<string, unknown>>;
let ticketBodies: Array<Record<string, unknown>>;
let seenKeys: string[];
let fingerprints: Map<string, string>;
let faults: string[];
let toolsModule: typeof import('../tools/oxy-services.js');
let stepOf: Map<string, string | undefined>;

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function context(): OxyToolExecutionContext {
  return {
    requesterAccountId: account,
    ownerAccountId: account,
    actor: { type: 'alia' as const, ownerAccountId: account },
    runId: 'fixture-run',
    autonomy: 'execute_on_request' as const,
  };
}
interface Executable {
  execute(input: Record<string, unknown>, options?: { toolCallId?: string }): Promise<unknown>;
}
async function tool(ctx = context()): Promise<Executable> {
  const built = await toolsModule.buildOxyServiceTools(account, ctx);
  expect(built.oxy_mention__savePost).toBeDefined();
  return built.oxy_mention__savePost as unknown as Executable;
}
function ticket(input: Record<string, unknown>) {
  return real.issueCapabilityTicket(
    {
      aud: catalog.audience,
      sub: `alia:${account}`,
      requesterAccountId: account,
      ownerAccountId: account,
      actor: context().actor,
      coordinator: { applicationId: 'fixture-alia-app', credentialId: 'fixture-alia-credential' },
      executionAuthorization: {
        kind: 'direct_request',
        id: String(input.executionAuthorizationId),
      },
      runId: 'fixture-run',
      // The authorization bound its step (a run-scoped call); the ticket request names none.
      ...(typeof stepOf.get(String(input.executionAuthorizationId)) === 'string'
        ? { stepId: stepOf.get(String(input.executionAuthorizationId)) }
        : {}),
      resource: {
        appId: 'mention',
        effectiveAccountId: account,
        resourceType: 'mention_account',
        resourceId: wrongResource ? 'another-subject' : account,
      },
      tool: 'savePost',
      capabilities: ['posts.save'],
      limits: [],
      autonomy: 'execute_on_request',
      catalog: binding,
    },
    { privateKey: keys.privateKey, keyId: 'fixture-key', issuer, ttlSeconds: 60 },
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  denyTickets =
    denyReceiver =
    receiverNotReady =
    dropCallConnection =
    wrongResource =
    loseResponseAfterEffect =
      false;
  receiverPosts = 0;
  registryFailure = undefined;
  alive = true;
  approvals = effects = legacyCalls = 0;
  stepOf = new Map();
  authorityBodies = [];
  ticketBodies = [];
  seenKeys = [];
  fingerprints = new Map();
  faults = [];
  const authority = express();
  authority.use(
    rateLimit({
      windowMs: 60_000,
      limit: 128,
      keyGenerator: () => 'fixture-i05-alia-authority',
      validate: false,
    }),
  );
  authority.use(express.json());
  authority.post('/auth/service-token', (_req, res) =>
    res.json({ token: serviceToken, expiresIn: 300 }),
  );
  authority.get('/capabilities/catalogs', (req, res) => {
    if (req.header('authorization') !== `Bearer ${serviceToken}`)
      faults.push('catalog service authority');
    res.json({
      registrations: [
        {
          ...(registryFailure === 'missing-id' ? {} : { id: binding.registrationId }),
          version: registryFailure === 'version' ? 'different-version' : binding.version,
          digest: registryFailure === 'digest' ? '0'.repeat(64) : binding.digest,
          catalog,
        },
      ],
    });
  });
  authority.get('/capabilities/service-identity', (req, res) => {
    if (req.header('authorization') !== `Bearer ${serviceToken}`)
      faults.push('coordinator service authority');
    res.json({
      service: { applicationId: 'fixture-alia-app', credentialId: 'fixture-alia-credential' },
    });
  });
  authority.post('/capabilities/first-party-execution-authorizations', (req, res) => {
    // Gemies' own workload on its declared authority: the person by id, never a bearer of theirs.
    if (
      req.header('authorization') !== `Bearer ${serviceToken}` ||
      'subjectToken' in req.body ||
      req.body.requesterAccountId !== account ||
      req.body.authority !== 'first_party' ||
      req.body.kind !== 'direct_request' ||
      req.header('x-oxy-user-id')
    )
      faults.push('first-party authority');
    approvals += 1;
    authorityBodies.push(req.body);
    const id = `fixture-approval-${approvals}`;
    stepOf.set(id, req.body.stepId);
    res.status(201).json({ authorization: { id } });
  });
  authority.post('/capabilities/tickets', (req, res) => {
    if (req.header('authorization') !== `Bearer ${serviceToken}` || req.header('x-oxy-user-id'))
      faults.push('ticket service authority');
    ticketBodies.push(req.body);
    if ('runId' in req.body || 'stepId' in req.body) faults.push('ticket overrides its scope');
    if (denyTickets) {
      res.status(403).json({ message: requester });
      return;
    }
    res
      .status(201)
      .json({ decision: { allowed: true, reason: 'synthetic_allowed' }, ticket: ticket(req.body) });
  });
  // Nothing is held after a call, so nothing is ever retired.
  authority.delete('/capabilities/execution-authorizations/:id', (_req, res) => {
    faults.push('an authorization was retired');
    res.status(204).end();
  });
  issuer = await listen(createServer(authority));
  const app = express();
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 128,
      keyGenerator: () => 'fixture-i05-alia-receiver',
      validate: false,
    }),
  );
  app.all('/_oxy/mcp', (req, res) => {
    if (!req.header('authorization')?.startsWith('Capability ') || req.header('x-oxy-user-id'))
      faults.push('receiver authority');
    if (denyReceiver) {
      res.status(403).json({ message: requester });
      return;
    }
    // The client POSTs initialize, the initialized notification, then the
    // call: cutting the third is a network failure after the call was sent.
    if (dropCallConnection && req.method === 'POST' && ++receiverPosts === 3) {
      req.socket.destroy();
      return;
    }
    if (receiverNotReady) {
      res.status(503).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Internal MCP catalogue is not registered with Oxy.' },
      });
      return;
    }
    destroyReceiverResponse = () => res.destroy();
    void receiver.handleMcp(req, res);
  });
  app.post('/posts/save', (_req, res) => {
    legacyCalls += 1;
    res.status(500).end();
  });
  const origin = await listen(createServer(app));
  catalog = {
    schemaVersion: '1',
    appId: 'mention',
    version: 'fixture.1',
    audience: 'mention-api',
    internalBaseUrl: origin,
    accountResourceType: 'mention_account',
    internalTransport: 'mcp',
    tools: [
      {
        name: 'savePost',
        version: '1.0.0',
        description: 'Synthetic canonical save',
        inputSchema: {
          type: 'object',
          properties: { postId: { type: 'string' } },
          required: ['postId'],
          additionalProperties: false,
        },
        capabilityPackage: 'create',
        requiredCapabilities: ['posts.save'],
        resourceTypes: ['mention_account'],
        effect: 'write',
        idempotency: 'required',
        rollback: 'manual',
        exposure: ['internal'],
        invocation: { method: 'POST', path: '/posts/save' },
        limitKeys: [],
      },
      {
        name: 'getPost',
        version: '1.0.0',
        description: 'Synthetic canonical read',
        inputSchema: {
          type: 'object',
          properties: { postId: { type: 'string' } },
          required: ['postId'],
          additionalProperties: false,
        },
        capabilityPackage: 'read',
        requiredCapabilities: ['posts.read'],
        resourceTypes: ['mention_account'],
        effect: 'read',
        idempotency: 'none',
        rollback: 'none',
        exposure: ['internal'],
        invocation: { method: 'GET', path: '/posts/get' },
        limitKeys: [],
      },
    ],
    events: [],
  };
  binding = {
    registrationId: 'fixture-mention-registration',
    version: catalog.version,
    digest: createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex'),
  };
  const receiver = createInternalCatalogMcpHttpService({
    catalog,
    binding,
    verifyTicket: async (value) => {
      if (!alive) throw new Error('synthetic authority withdrawn');
      return real.verifyCapabilityTicket(value, {
        issuer,
        audience: catalog.audience,
        resolvePublicKey: () => keys.publicKey,
      });
    },
    resolveResource: () => ({
      appId: 'mention',
      effectiveAccountId: account,
      resourceType: 'mention_account',
      resourceId: account,
    }),
    authorize: async (_input, ctx) =>
      alive && ctx.principal.kind === 'capability'
        ? {
            allowed: true as const,
            effectiveAccountId: ctx.principal.claims.resource.effectiveAccountId,
          }
        : { allowed: false as const, reason: 'synthetic_withdrawn' },
    handlers: {
      savePost: async (input, ctx) => {
        const key = ctx.request.requestInfo?.headers['idempotency-key'];
        if (typeof key !== 'string') throw new Error('synthetic key missing');
        seenKeys.push(key);
        const digest = canonicalCapabilityJson(input);
        const previous = fingerprints.get(key);
        if (previous && previous !== digest) throw new Error('synthetic operation conflict');
        if (!previous) {
          fingerprints.set(key, digest);
          effects += 1;
        }
        if (loseResponseAfterEffect) destroyReceiverResponse();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ saved: input.postId, auditEventId: 'fixture-audit' }),
            },
          ],
        };
      },
      getPost: async (input) => {
        if (loseResponseAfterEffect) destroyReceiverResponse();
        return { content: [{ type: 'text', text: JSON.stringify({ post: input.postId }) }] };
      },
    },
  });
  state.client = new real.OxyServer({
    baseURL: issuer,
    serviceAuth: { apiKey: 'oxy_dk_fixture_alia', apiSecret: 'fixture-only-service-secret' },
  });
  vi.stubEnv('OXY_API_URL', issuer);
  toolsModule = await import('../tools/oxy-services.js');
});
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  vi.unstubAllEnvs();
  state.client = undefined;
  expect(faults).toEqual([]);
  const logged = inspect([...state.warn.mock.calls, ...state.error.mock.calls], { depth: 8 });
  expect(logged).not.toContain(requester);
  expect(logged).not.toContain(serviceToken);
});

describe('Alia installed common agency and internal MCP pilot', () => {
  it('preserves domain result and pins catalogue over real MCP, with nothing to retire', async () => {
    const save = await tool();
    expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'call-1' })).toEqual({
      saved: 'post-1',
      auditEventId: 'fixture-audit',
    });
    expect(authorityBodies[0]).toMatchObject({
      runId: 'fixture-run',
      actor: context().actor,
      authority: 'first_party',
      kind: 'direct_request',
      requesterAccountId: account,
    });
    expect(ticketBodies[0]).toEqual({
      expectedCatalog: binding,
      executionAuthorizationId: 'fixture-approval-1',
    });
    expect(effects).toBe(1);
    expect(legacyCalls).toBe(0);
  });
  it('keeps transport-after-effect unknown distinct from acknowledged success', async () => {
    loseResponseAfterEffect = true;
    const save = await tool();
    const outcome = await save.execute({ postId: 'post-1' }, { toolCallId: 'unknown-call' });
    expect(outcome).toMatchObject({ error: 'oxy_app_result_unknown', status: 'unknown' });
    expect(outcome).not.toHaveProperty('retirement');
    expect(approvals).toBe(1);
    expect(ticketBodies).toHaveLength(1);
    expect(effects).toBe(1);
    expect(legacyCalls).toBe(0);
  });
  it('keeps a stable operation key across replay and rejects changed payload without a second effect', async () => {
    const save = await tool();
    for (let n = 0; n < 2; n++) {
      expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'same-call' })).toMatchObject({
        saved: 'post-1',
      });
    }
    expect(
      await save.execute({ postId: 'other-post' }, { toolCallId: 'same-call' }),
    ).toHaveProperty('error');
    expect(new Set(seenKeys).size).toBe(1);
    expect(effects).toBe(1);
    expect(legacyCalls).toBe(0);
  });
  it('authorizes a run-scoped step per call, bound to its run, step and limits, with no session', async () => {
    const statuses = vi.fn(async () => undefined);
    const resource = {
      appId: 'mention',
      effectiveAccountId: account,
      resourceType: 'mention_account',
      resourceId: account,
    };
    const ctx = {
      ...context(),
      onStepStatus: statuses,
      runScope: {
        [toolsModule.oxyRunScopeKey(resource, 'savePost')]: {
          stepId: 'fixture-step',
          limits: [{ key: 'postId', value: 1 }],
        },
      },
    };
    const save = await tool(ctx);
    expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'step-call' })).toMatchObject({
      saved: 'post-1',
    });
    expect(authorityBodies).toEqual([
      expect.objectContaining({
        kind: 'direct_request',
        runId: 'fixture-run',
        stepId: 'fixture-step',
        limits: [{ tool: 'savePost', key: 'postId', value: 1 }],
        requesterAccountId: account,
        resource,
      }),
    ]);
    expect(ticketBodies[0]).toEqual({
      executionAuthorizationId: 'fixture-approval-1',
      expectedCatalog: binding,
    });
    expect(statuses.mock.calls).toEqual([
      ['fixture-step', 'running'],
      ['fixture-step', 'succeeded', 'fixture-audit'],
    ]);
    expect(approvals).toBe(1);
  });
  it.each(['digest', 'missing-id', 'version'] as const)(
    'refuses %s registry provenance before any authority/effect',
    async (failure) => {
      registryFailure = failure;
      expect(await toolsModule.buildOxyServiceTools(account, context())).toEqual({});
      expect(approvals).toBe(0);
      expect(effects).toBe(0);
    },
  );
  it('rejects a signed ticket outside the trusted account resource before an effect', async () => {
    wrongResource = true;
    const save = await tool();
    expect(await save.execute({ postId: 'post-1' })).toHaveProperty('error');
    expect(effects).toBe(0);
    expect(legacyCalls).toBe(0);
  });
  it('requires a named run for direct use', async () => {
    const save = await tool({ ...context(), runId: undefined });
    expect(await save.execute({ postId: 'post-1' })).toHaveProperty('error', 'oxy_app_unavailable');
    expect(approvals).toBe(0);
    expect(effects).toBe(0);
  });
  it('rejects ticket issuance before execution', async () => {
    denyTickets = true;
    const save = await tool();
    const outcome = await save.execute({ postId: 'post-1' }, { toolCallId: 'ticket-denied' });
    expect(outcome).toMatchObject({ error: 'oxy_app_unavailable' });
    expect(effects).toBe(0);
    expect(approvals).toBe(1);
    expect(legacyCalls).toBe(0);
  });
  it.each(['ticket', 'receiver'])(
    'fails closed on %s failure without legacy fallback or leaking bearers',
    async (phase) => {
      denyTickets = phase === 'ticket';
      denyReceiver = phase === 'receiver';
      const save = await tool();
      // Refused before it ran, at the ticket or at the receiver (403): nothing happened.
      expect(
        await save.execute({ postId: 'post-1' }, { toolCallId: 'call-failure' }),
      ).toMatchObject(
        phase === 'ticket'
          ? { error: 'oxy_app_unavailable' }
          : { error: 'oxy_app_unavailable', status: 'not_executed' },
      );
      expect(legacyCalls).toBe(0);
      expect(effects).toBe(0);
    },
  );
});

describe('a refusal or a failed read is never an unknown outcome', () => {
  it('a receiver that is not ready (503) is unavailable, not unknown', async () => {
    receiverNotReady = true;
    const save = await tool();
    expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'not-ready' })).toMatchObject({
      error: 'oxy_app_unavailable',
      status: 'not_executed',
    });
    expect(effects).toBe(0);
  });

  it('a read cut off after it was sent is unavailable: a read has no effect to be unsure of', async () => {
    dropCallConnection = true;
    const built = await toolsModule.buildOxyServiceTools(account, context());
    const read = built.oxy_mention__getPost as unknown as Executable;
    expect(await read.execute({ postId: 'post-1' }, { toolCallId: 'read-cut' })).toMatchObject({
      error: 'oxy_app_unavailable',
      status: 'failed',
    });
  });

  it('an effect cut off after it was sent stays unknown', async () => {
    dropCallConnection = true;
    const save = await tool();
    expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'save-cut' })).toMatchObject({
      error: 'oxy_app_result_unknown',
      status: 'unknown',
    });
  });
});
