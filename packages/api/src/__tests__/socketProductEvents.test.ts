import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the API pushes on the realtime socket (`docs/realtime.mdx`): every product event is ONE
 * Socket.IO event, `rt`, carrying a typed frame — durable ones numbered from the account's log,
 * signals not. Approval events are not among them: no agent asks for approval (ADR 0020 §3).
 *
 * ## Why a socket event is the easiest thing in the product to delete by accident
 *
 * Nothing throws when an event nobody is listening for is emitted, and nothing
 * throws when a listener binds a name nobody emits. Renaming
 * `agent-activity` to `agent:activity` on either side compiles, deploys,
 * passes every existing test, and silently removes the live run view from the
 * product. The same is true of `notification` and `show:progress`.
 *
 * So the required name set is derived from the CONSUMER — the app's own
 * `socket.on(...)` calls, read off disk — rather than written out here from
 * memory, and every name in it is then produced by driving the real emitter
 * against a real Socket.IO server.
 *
 * ## Why the real server and not a mock
 *
 * Both halves are measured through the adapter's `broadcast`, which is the
 * function Socket.IO itself calls with the packet and the target rooms. Mocking
 * `io.to(...).emit(...)` would assert that a name this file chose was passed to
 * a function this file wrote; reading the broadcast asserts what the server was
 * actually asked to send, and to whom.
 */

const H = vi.hoisted(() => ({
  notificationRow: {
    id: 'notif-ws13',
    oxyUserId: 'user-ws13',
    type: 'chat_response_ready',
    title: 'Alia has responded',
    body: 'the answer',
    priority: 'normal',
    data: { conversationId: 'conv-ws13' },
    channels: ['in_app'],
    deliveryStatus: { in_app: 'pending' },
    createdAt: new Date(0),
  },
}));

// The two things a socket server needs that a unit test cannot supply.
vi.mock('../lib/redis.js', () => ({
  getRedisClient: vi.fn(() => null),
  getRedisSubClient: vi.fn(() => null),
}));
vi.mock('../lib/oxy.js', () => ({
  oxy: {
    middleware: { socket: vi.fn(() => (_socket: unknown, next: () => void) => next()) },
  },
}));

// Stores only. `notification-service.ts` itself, and its channel resolution, run.
vi.mock('../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
// The account's log: numbered 1, 2, 3… as Postgres would (its own test is `accountEvents.pgdb.test.ts`).
vi.mock('../db/realtime/accountEventRepository.js', () => {
  let seq = 0;
  return {
    appendAccountEvent: vi.fn(async (_db: unknown, _user: string, type: string, data: unknown) => ({
      seq: ++seq,
      type,
      data,
      createdAt: new Date(0),
    })),
  };
});
vi.mock('../db/notifications/notificationRepository.js', () => ({
  createNotification: vi.fn(async () => H.notificationRow),
  setDeliveryStatus: vi.fn(async () => undefined),
  hasActivePushToken: vi.fn(async () => false),
  hasActiveWebPushSubscription: vi.fn(async () => false),
  countUnread: vi.fn(async () => 0),
  listActivePushTokens: vi.fn(async () => []),
  listActiveWebPushSubscriptions: vi.fn(async () => []),
  deactivatePushTokenById: vi.fn(async () => undefined),
  deactivatePushTokenByToken: vi.fn(async () => undefined),
  deactivateWebPushSubscriptionById: vi.fn(async () => undefined),
  dismissNotification: vi.fn(async () => true),
  markAllNotificationsRead: vi.fn(async () => 0),
  markNotificationRead: vi.fn(async () => true),
  touchPushTokens: vi.fn(async () => undefined),
}));
vi.mock('../db/integrations/botRepository.js', () => ({
  findSystemBot: vi.fn(async () => null),
  findLinkedBotUser: vi.fn(async () => null),
}));
vi.mock('../lib/channels/outbound.js', () => ({ sendChannelMessage: vi.fn(async () => []) }));

vi.mock('../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      general: child,
      agents: child,
      chat: child,
      v1: child,
      providers: child,
      triggers: child,
    },
  };
});

import { emitAgentActivity, emitLegacyAliaActivity, initSocket } from '../socket.js';
import { publishRoomEvent } from '../lib/chat/room/bus.js';
import { publishConversationReaction } from '../lib/chat/reactions/bus.js';
import type { Server } from 'socket.io';
import { sendNotification } from '../lib/notification-service.js';
import {
  REALTIME_EVENT,
  REALTIME_SIGNAL_TYPES,
  type RealtimeFrame,
} from '../lib/realtime/contract.js';
import { ACCOUNT_EVENT_TYPES } from '../domain/account-events.js';

// ── The recorder: what the server was asked to broadcast ───────────────────

interface Broadcast {
  event: string;
  rooms: string[];
  payload: unknown;
}

const broadcasts: Broadcast[] = [];
const server = http.createServer();
let io: Server;

beforeAll(() => {
  io = initSocket(server);
  const adapter = io.of('/').adapter;
  vi.spyOn(adapter, 'broadcast').mockImplementation((packet, opts) => {
    const data = (packet as { data: [string, unknown] }).data;
    broadcasts.push({
      event: data[0],
      rooms: [...((opts as { rooms?: Set<string> }).rooms ?? [])],
      payload: data[1],
    });
  });
});

afterAll(async () => {
  await io.close();
  server.close();
});

beforeEach(() => {
  broadcasts.length = 0;
});

const frames = () =>
  broadcasts.map((b) => ({ event: b.event, rooms: b.rooms, frame: b.payload as RealtimeFrame }));

describe('every product event is a typed `rt` frame, to its own room', () => {
  it('a reaction is durable: numbered, to its owner', async () => {
    const update = {
      conversationId: 'conversation-ws13',
      messageId: 'answer-ws13',
      reactions: ['❤️'],
      revision: 2,
      mutationId: 'mutation-ws13',
    };
    await publishConversationReaction('user-ws13', update);
    expect(frames()).toEqual([
      {
        event: REALTIME_EVENT,
        rooms: ['user:user-ws13'],
        frame: { v: 1, type: 'message.reaction', data: update, seq: expect.any(Number) },
      },
    ]);
  });

  it('an agent run, to its agent topic AND its session topic', () => {
    emitAgentActivity('agent-ws13', {
      type: 'tool_call',
      content: 'running',
      timestamp: 1,
      sessionId: 'sess-ws13',
    });
    // Two topics: the agent detail screen and the in-chat task card are different followers.
    expect(
      frames().map((f) => ({ rooms: f.rooms, topic: f.frame.topic, type: f.frame.type })),
    ).toEqual([
      { rooms: ['agent:agent-ws13'], topic: 'agent:agent-ws13', type: 'agent.activity' },
      {
        rooms: ['agent-session:sess-ws13'],
        topic: 'agent-session:sess-ws13',
        type: 'agent.activity',
      },
    ]);
    expect(frames()[0]?.frame.data).toMatchObject({ agentId: 'agent-ws13', type: 'tool_call' });
  });

  it("keeps `alia:activity` for the Oxy apps on an SDK before 6.0, to the person's room only", () => {
    emitLegacyAliaActivity('user-ws13', {
      state: 'working',
      agentId: 'agent-ws13',
      sessionId: 'sess-ws13',
      timestamp: 1,
    });
    expect(broadcasts.map((b) => ({ event: b.event, rooms: b.rooms }))).toEqual([
      { event: 'alia:activity', rooms: ['user:user-ws13'] },
    ]);
  });

  it('a notification is durable, through the service', async () => {
    const sent = await sendNotification({
      userId: 'user-ws13',
      type: 'chat_response_ready',
      title: 'Alia has responded',
      body: 'the answer',
      channels: ['in_app'],
    });
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toMatchObject({
      event: REALTIME_EVENT,
      rooms: ['user:user-ws13'],
      frame: {
        type: 'notification',
        seq: expect.any(Number),
        data: {
          notification: { id: 'notif-ws13', type: 'chat_response_ready', body: 'the answer' },
        },
      },
    });
    expect(sent.deliveryStatus).toEqual({ in_app: 'sent' });
  });

  it('a room\'s frame is a signal, and a member starting to answer is "typing" for the person', async () => {
    await publishRoomEvent({
      userId: 'u',
      conversationId: 'c',
      chainId: 'p',
      event: 'alia.agent_start',
      data: { consultId: 'k', agent: { id: 'pepe', name: 'Pepe' } },
    });
    await publishRoomEvent({
      userId: 'u',
      conversationId: 'c',
      chainId: 'p',
      event: 'alia.agent_end',
      data: { consultId: 'k' },
    });
    const types = frames().map((f) => [f.frame.type, (f.frame.data as { state?: string }).state]);
    expect(types).toEqual([
      ['activity', 'thinking'],
      ['room', undefined],
      ['activity', 'idle'],
      ['room', undefined],
    ]);
    expect(frames()[0]?.frame.data).toMatchObject({
      conversationId: 'c',
      actor: { agentId: 'pepe', name: 'Pepe' },
    });
  });
});

describe('the SDK and the API speak the same list of frames', () => {
  /** A tuple of the SDK's contract, read off disk: the API does not compile the SDK. */
  const sdkTuple = (name: string): string[] => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../sdk/src/realtime/contract.ts'),
      'utf8',
    );
    const body = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(source)?.[1];
    return [...(body ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  };

  it('names every durable type and every signal the same on both sides', () => {
    expect(sdkTuple('REALTIME_DURABLE_TYPES').sort()).toEqual([...ACCOUNT_EVENT_TYPES].sort());
    expect(sdkTuple('REALTIME_SIGNAL_TYPES').sort()).toEqual([...REALTIME_SIGNAL_TYPES].sort());
    expect(sdkTuple('REALTIME_SIGNAL_TYPES').length).toBeGreaterThan(3);
  });

  it('listens for no socket event by name but `rt`, and the runtime offer hears only what the API sends it', () => {
    const appRoot = path.resolve(import.meta.dirname, '../../../app');
    const sdkRoot = path.resolve(import.meta.dirname, '../../../sdk');
    const onNames = new Set<string>();
    const protocol = new Set<string>();
    let files = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', '.expo', 'dist', '__tests__'].includes(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        files += 1;
        const source = fs.readFileSync(full, 'utf8');
        for (const line of source.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          for (const match of line.matchAll(/\bsocket\??\.on\(\s*['"]([^'"]+)['"]/g))
            onNames.add(match[1] as string);
        }
        // The formatter may break the call after its parenthesis: matched across lines.
        for (const match of source.matchAll(/\.listen\(\s*['"]([^'"]+)['"]/g))
          protocol.add(match[1] as string);
      }
    };
    walk(path.join(appRoot, 'src'));
    walk(path.join(sdkRoot, 'src'));
    expect(files).toBeGreaterThan(100);
    for (const transport of ['connect', 'disconnect', 'connect_error']) onNames.delete(transport);
    // `rt` is read by `realtime/connection.ts` through its constant: no other name is listened for.
    expect([...onNames]).toEqual([]);
    // The local runtime's own protocol (`lib/inference/user-runtime-bridge.ts` sends both).
    expect([...protocol].sort()).toEqual(['user-runtime:abort', 'user-runtime:request']);
  });
});
