import { registeredCatalog } from './fixtures/oxy-catalog.js';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oxy.js', () => {
  const { OxyServer }: typeof import('@oxy.so/core/server') = createRequire(import.meta.url)(
    '@oxy.so/core/server',
  );
  const client = new OxyServer({
    baseURL: 'https://api.oxy.so',
    serviceAuth: { apiKey: 'synthetic-app', apiSecret: 'synthetic-secret' },
  });
  return {
    get oxy() {
      return client;
    },
  };
});

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

import {
  buildOxyServiceTools,
  getOxyServicePromptFragment,
  idempotencyKey,
  listOxyAccountReadTools,
  oxyRunScopeKey,
  type OxyToolExecutionContext,
} from '../tools/oxy-services.js';

const CATALOG = {
  schemaVersion: '1',
  appId: 'inbox',
  version: '1.0.0',
  audience: 'oxy-inbox-api',
  internalBaseUrl: 'https://inbox.example.test',
  accountResourceType: 'email_account',
  tools: [
    {
      name: 'searchEmails',
      version: '1.0.0',
      description: 'Search emails',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      capabilityPackage: 'read',
      requiredCapabilities: ['email.read'],
      resourceTypes: ['email_account'],
      effect: 'read',
      idempotency: 'none',
      rollback: 'none',
      exposure: ['internal', 'mcp'],
      invocation: { method: 'GET', path: '/email/search' },
      limitKeys: [],
    },
  ],
  events: [],
};

interface ExecutableTool {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

function context(userId: string): OxyToolExecutionContext {
  return {
    requesterAccountId: userId,
    ownerAccountId: userId,
    actor: { type: 'alia', ownerAccountId: userId },
    runId: `run-${userId}`,
    autonomy: 'execute_on_request',
  };
}

/** What Gemies asked Oxy to authorize, call by call (`/capabilities/first-party-execution-authorizations`). */
type AuthorizationRequest = Record<string, unknown> & {
  requesterAccountId?: string;
  resource?: Record<string, unknown>;
};

describe('Oxy capability tools', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let authorizations: AuthorizationRequest[];
  let tickets: Record<string, unknown>[];

  beforeEach(() => {
    authorizations = [];
    tickets = [];
    fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/service-token'))
        return Response.json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
      if (url.endsWith('/capabilities/catalogs')) {
        return new Response(JSON.stringify({ registrations: [registeredCatalog(CATALOG)] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/capabilities/service-identity')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ALIA-SERVICE-TOKEN');
        return new Response(
          JSON.stringify({
            service: { applicationId: 'alia-app', credentialId: 'alia-credential' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (
        url.endsWith('/capabilities/first-party-execution-authorizations') &&
        init?.method === 'POST'
      ) {
        // Gemies' own workload, on its declared authority: no person's bearer anywhere.
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer ALIA-SERVICE-TOKEN');
        const body = JSON.parse(String(init.body)) as AuthorizationRequest;
        expect(JSON.stringify(body)).not.toMatch(/subjectToken|taskId/);
        authorizations.push(body);
        return new Response(
          JSON.stringify({ authorization: { id: `AUTHORIZATION-${authorizations.length}` } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/capabilities/tickets')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ALIA-SERVICE-TOKEN');
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        tickets.push(request);
        // The authorization bound its own run and step: the ticket request names neither.
        expect(request).toEqual({
          executionAuthorizationId: `AUTHORIZATION-${authorizations.length}`,
        });
        return new Response(
          JSON.stringify({
            decision: { allowed: true, reason: 'allowed' },
            ticket: 'SHORT-TICKET',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url.includes('/email/search')) {
        expect(url).toBe('https://inbox.example.test/email/search?q=hello');
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Capability SHORT-TICKET',
        );
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-oxy-audit-event-id': 'audit-event-1',
          },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('authorizes each call on Gemies’ own authority for the person, with no session, and sends only a ticket to the app', async () => {
    const tools = await buildOxyServiceTools('user-1', context('user-1'));
    const search = tools.oxy_inbox__searchEmails as unknown as ExecutableTool;
    expect(search).toBeDefined();
    await search.execute({ q: 'hello' });

    expect(authorizations).toEqual([
      expect.objectContaining({
        authority: 'first_party',
        kind: 'direct_request',
        tool: 'searchEmails',
        runId: 'run-user-1',
        requesterAccountId: 'user-1',
        resource: expect.objectContaining({ appId: 'inbox', effectiveAccountId: 'user-1' }),
      }),
    ]);
    expect(authorizations[0]).not.toHaveProperty('stepId');

    const appCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith('https://inbox.example.test/'),
    );
    expect(appCall).toBeDefined();
    expect(((appCall?.[1] as RequestInit).headers as Record<string, string>).authorization).toBe(
      'Capability SHORT-TICKET',
    );
    // Nothing to retire: no approval, task or session is held after the call.
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('renders its prompt from the same registry snapshot', async () => {
    await buildOxyServiceTools('user-2', context('user-2'));
    const fragment = getOxyServicePromptFragment('user-2');
    expect(fragment).toContain('Inbox');
    expect(fragment).toContain('oxy_inbox__searchEmails');
  });

  it('authorizes a run-scoped step per call with its step and declared limits, once per stage', async () => {
    const resource = {
      appId: 'inbox',
      effectiveAccountId: 'user-3',
      resourceType: 'email_account',
      resourceId: 'user-3',
    };
    const onStepStatus = vi.fn(async () => undefined);
    const tools = await buildOxyServiceTools('user-3', {
      requesterAccountId: 'user-3',
      ownerAccountId: 'user-3',
      actor: { type: 'alia', ownerAccountId: 'user-3' },
      runId: 'run-user-3',
      autonomy: 'autonomous',
      runScope: {
        [oxyRunScopeKey(resource, 'searchEmails')]: {
          stepId: 'step-user-3',
          limits: [{ key: 'q', value: 5 }],
        },
      },
      onStepStatus,
    });
    const search = tools.oxy_inbox__searchEmails as unknown as ExecutableTool;
    await search.execute({ q: 'hello' });
    await expect(search.execute({ q: 'second' })).resolves.toEqual({
      error: 'searchEmails is authorized once for this automation stage',
    });

    expect(authorizations).toEqual([
      expect.objectContaining({
        kind: 'direct_request',
        runId: 'run-user-3',
        stepId: 'step-user-3',
        limits: [{ tool: 'searchEmails', key: 'q', value: 5 }],
        requesterAccountId: 'user-3',
        resource,
      }),
    ]);
    expect(tickets).toEqual([{ executionAuthorizationId: 'AUTHORIZATION-1' }]);
    expect(onStepStatus.mock.calls).toEqual([
      ['step-user-3', 'running'],
      ['step-user-3', 'succeeded', 'audit-event-1'],
    ]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith('https://inbox.example.test/'),
      ),
    ).toHaveLength(1);
  });

  describe('what the model is told when a call fails', () => {
    function refuse(
      match: (url: string, init?: RequestInit) => boolean,
      response: () => Response,
    ): void {
      const original = fetchMock.getMockImplementation() as
        | ((input: string | URL, init?: RequestInit) => Promise<Response>)
        | undefined;
      fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) =>
        match(String(input), init) ? response() : original?.(input, init),
      );
    }

    it('hides raw authority errors while preserving consent and refusing bypass', async () => {
      refuse(
        (url, init) =>
          url.endsWith('/capabilities/first-party-execution-authorizations') &&
          init?.method === 'POST',
        () =>
          new Response(JSON.stringify({ error: 'coordinator_not_active_or_authorized' }), {
            status: 400,
          }),
      );
      const tools = await buildOxyServiceTools('user-1', context('user-1'));
      const result = await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({
        q: 'hello',
      });
      expect(result).toMatchObject({ error: 'oxy_app_unavailable' });
      const text = JSON.stringify(result);
      expect(text).not.toContain('coordinator_not_active_or_authorized');
      expect(text).not.toContain('consent');
      expect(text).toContain('Do not claim it succeeded or use another route to bypass the check');
    });

    it('treats the app refusing its ticket as an authority failure', async () => {
      refuse(
        (url) => url.includes('/email/search'),
        () => new Response('ticket rejected', { status: 403 }),
      );
      const tools = await buildOxyServiceTools('user-1', context('user-1'));
      const result = await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({
        q: 'hello',
      });
      expect(result).toMatchObject({ error: 'oxy_app_unavailable' });
    });

    it("keeps the app's own answer to the request, which the model can act on", async () => {
      refuse(
        (url) => url.includes('/email/search'),
        () => new Response('query too long', { status: 422 }),
      );
      const tools = await buildOxyServiceTools('user-1', context('user-1'));
      const result = await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({
        q: 'hello',
      });
      expect(result).toEqual({ error: expect.stringContaining('query too long') });
    });
  });

  it("lets Alia read the owner's apps any number of times in her run scope", async () => {
    const root = {
      appId: 'inbox',
      effectiveAccountId: 'user-5',
      resourceType: 'email_account',
      resourceId: 'user-5',
    };
    const tools = await buildOxyServiceTools('user-5', {
      requesterAccountId: 'user-5',
      ownerAccountId: 'user-5',
      actor: { type: 'alia', ownerAccountId: 'user-5' },
      runId: 'run-user-5',
      autonomy: 'autonomous',
      runScope: {
        [oxyRunScopeKey(root, 'searchEmails')]: { repeatable: true },
      },
    });
    const search = tools.oxy_inbox__searchEmails as unknown as ExecutableTool;
    await expect(search.execute({ q: 'hello' })).resolves.toEqual({ data: [] });
    await expect(search.execute({ q: 'hello' })).resolves.toEqual({ data: [] });
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/capabilities/tickets')),
    ).toHaveLength(2);
    // Each read is its own authorization, for the run, with no step: a standing read belongs to
    // the task, not to one step.
    expect(authorizations).toHaveLength(2);
    for (const authorization of authorizations) {
      expect(authorization).toMatchObject({ kind: 'direct_request', runId: 'run-user-5' });
      expect(authorization).not.toHaveProperty('stepId');
    }
  });

  it('binds Alia to exactly the resources her run scope names, account root or not', async () => {
    const root = {
      appId: 'inbox',
      effectiveAccountId: 'user-5',
      resourceType: 'email_account',
      resourceId: 'user-5',
    };
    const other = { ...root, resourceId: 'shared-box' };
    const tools = await buildOxyServiceTools('user-5', {
      requesterAccountId: 'user-5',
      ownerAccountId: 'user-5',
      actor: { type: 'alia', ownerAccountId: 'user-5' },
      runId: 'run-user-5',
      runScope: {
        [oxyRunScopeKey(root, 'searchEmails')]: { repeatable: true },
        [oxyRunScopeKey(other, 'searchEmails')]: { repeatable: true },
        [oxyRunScopeKey(root, 'notInTheCatalog')]: { repeatable: true },
      },
    });
    const names = Object.keys(tools).sort();
    expect(names).toHaveLength(2);
    expect(names.every((name) => name.startsWith('oxy_inbox__searchEmails__'))).toBe(true);
  });

  it("lists every read tool at the owner's account roots for an Alia run scope", async () => {
    await expect(listOxyAccountReadTools('user-6')).resolves.toEqual([
      {
        resource: {
          appId: 'inbox',
          effectiveAccountId: 'user-6',
          resourceType: 'email_account',
          resourceId: 'user-6',
        },
        tool: 'searchEmails',
      },
    ]);
  });

  it('does not expose undeclared Oxy tools to a run-scoped background stage', async () => {
    const tools = await buildOxyServiceTools('user-4', {
      requesterAccountId: 'user-4',
      ownerAccountId: 'user-4',
      actor: { type: 'alia', ownerAccountId: 'user-4' },
      runId: 'run-user-4',
      autonomy: 'autonomous',
      runScope: {},
    });
    expect(tools).toEqual({});
  });

  describe('the idempotency key of an effect', () => {
    const args = { emailId: 'email-1', starred: true };

    it('is one per tool call, so a deliberate identical repeat is not a duplicate', () => {
      expect(idempotencyKey('run-1', 'updateEmailFlags', args, 'call-a')).not.toBe(
        idempotencyKey('run-1', 'updateEmailFlags', args, 'call-b'),
      );
    });

    it('is stable for a retry of the same call', () => {
      expect(idempotencyKey('run-1', 'updateEmailFlags', args, 'call-a')).toBe(
        idempotencyKey(
          'run-1',
          'updateEmailFlags',
          { starred: true, emailId: 'email-1' },
          'call-a',
        ),
      );
    });

    it('falls back to the arguments when there is no call id', () => {
      expect(idempotencyKey('run-1', 'updateEmailFlags', args, undefined)).toBe(
        idempotencyKey('run-1', 'updateEmailFlags', { ...args }, undefined),
      );
    });
  });
});
