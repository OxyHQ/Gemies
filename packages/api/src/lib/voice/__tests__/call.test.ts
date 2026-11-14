import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});

const { creditsForCost } = await import('../../credits-manager.js');
const { KaanaBillingError, KaanaError } = await import('@kaana.ai/sdk');
const {
  catalogueModel,
  failing,
  harness,
  LIVE_DEFAULT,
  LIVE_FALLBACK,
  liveLine,
  pausedAfter,
  pcmBase64,
  RecordingSink,
  say,
  START,
  until,
  withTool,
} = await import('./support.js');

/**
 * A voice call end to end against `@kaana.ai/sdk/testing`, the real client
 * against Kaana's own rules in memory, and a scripted chat route (ADR 0041):
 * a `live` session opened on the catalogue's default line, every handed-over
 * turn answered by the chat route sentence by sentence, supersession stopping
 * a turn, limits, credits per minute and typed failures.
 */

async function opened(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.call.open(START);
  await until('session.ready', () => h.sink.types().includes('session.ready'));
  return h;
}

type Harness = Awaited<ReturnType<typeof opened>>;

/** The client-visible wire, as one string: what the device could ever see. */
function wire(h: Harness): string {
  return JSON.stringify(h.sink.events);
}

/** The catalogue's voice of a gender on a line. */
function voiceOf(model: typeof LIVE_DEFAULT, gender: 'female' | 'male'): string {
  return model.audio!.voices.find((voice) => voice.gender === gender)!.id;
}

/** The voice hands a turn over, after the person's words were transcribed. */
function personSays(
  h: Harness,
  delegationId: string,
  words: string,
  itemId = `in_${delegationId}`,
) {
  const session = h.session();
  session.emit({
    type: 'transcript.delta',
    source: 'input_audio',
    itemId,
    contentIndex: 0,
    text: words,
  });
  session.emit({
    type: 'transcript.done',
    source: 'input_audio',
    itemId,
    contentIndex: 0,
    transcript: words,
  });
  session.emit({ type: 'delegation.requested', delegationId, text: words });
}

const replies = (h: Harness, delegationId?: string) =>
  h
    .commands('delegation.reply')
    .filter((reply) => delegationId === undefined || reply.delegationId === delegationId);

describe('opening', () => {
  it("opens a live session on the catalogue's default line, holding only a persona", async () => {
    const h = await opened({
      history: [
        { id: 'm1', role: 'user', content: '¿Qué tal el día?' },
        { id: 'm2', role: 'assistant', content: 'Muy bien, gracias.' },
      ],
    });
    const session = h.session();
    // The default, though another live line is listed first and is cheaper.
    expect(session.model.modelId).toBe(LIVE_DEFAULT.modelId);
    const { open } = session;
    expect(open.kind).toBe('live');
    expect(open.config).toEqual({
      instructions: expect.any(String),
      voice: voiceOf(LIVE_DEFAULT, 'female'),
      inputAudioFormat: 'pcm16_24khz',
      outputAudioFormat: 'pcm16_24khz',
      turnDetection: { type: 'server_vad', createResponse: true, interruptResponse: true },
      inputAudioTranscription: { language: 'es-ES' },
      delegation: { acknowledgement: 'auto' },
    });
    // The persona: the gemie, the language, the conversation so far; no tools, no backend prompt.
    expect(open.config.instructions).toContain('es-ES');
    expect(open.config.instructions).toContain('Person: ¿Qué tal el día?');
    expect(open.config.instructions).toContain('You: Muy bien, gracias.');
    expect(open.config).not.toHaveProperty('tools');
    expect(open.limits).toMatchObject({ maxDurationMs: 30 * 60_000, idleTimeoutMs: 2 * 60_000 });
    // The catalogue was read for the person.
    const list = h.server.requests.find(
      (request) => request.method === 'GET' && request.path.endsWith('/models'),
    );
    expect(list?.headers.get('X-Oxy-User-Id')).toBe('user-1');
    expect(h.sink.types().slice(0, 2)).toEqual(['session.accepted', 'session.ready']);
    expect(h.sink.find('session.ready')[0]!.model.id).toBe(
      `${LIVE_DEFAULT.modelId}@${LIVE_DEFAULT.currentRevision}`,
    );
    // The device never sees the persona or the upstream voice id.
    expect(wire(h)).not.toContain('Person:');
    expect(wire(h)).not.toContain(voiceOf(LIVE_DEFAULT, 'female'));
    expect(h.startCall).toHaveBeenCalledOnce();
    expect(h.reserve).toHaveBeenCalledOnce();
    await h.call.end('hangup');
  });

  it("speaks in the catalogue's voice of the person's gender, never an unreviewed one", async () => {
    const h = harness();
    await h.call.open({ ...START, voice: 'male' });
    await until('session.ready', () => h.sink.types().includes('session.ready'));
    expect(h.session().open.config.voice).toBe(voiceOf(LIVE_DEFAULT, 'male'));
    await h.call.end('hangup');

    // A default line with no voice of that gender is passed over for one that has it.
    const femaleOnly = liveLine('test-voice/female-only', {
      isDefault: true,
      voices: {
        ...LIVE_DEFAULT.audio!,
        voices: [{ id: 'only-female', name: 'F', languages: ['en'], gender: 'female' }],
      },
    });
    const other = await opened({ models: [femaleOnly, LIVE_FALLBACK] });
    expect(other.session().model.modelId).toBe(femaleOnly.modelId);
    await other.call.end('hangup');
    const male = harness({ models: [femaleOnly, LIVE_FALLBACK] });
    await male.call.open({ ...START, voice: 'male' });
    await until('session.ready', () => male.sink.types().includes('session.ready'));
    expect(male.session().model.modelId).toBe(LIVE_FALLBACK.modelId);
    expect(male.session().open.config.voice).toBe(voiceOf(LIVE_FALLBACK, 'male'));
    await male.call.end('hangup');
  });

  it('forwards audio only into a created session, acknowledging the first frame once', async () => {
    const h = harness();
    // Before there is a session, a frame goes nowhere.
    h.call.onClientAudio(new Uint8Array(1920));
    await h.call.open(START);
    await until('session.ready', () => h.sink.types().includes('session.ready'));
    h.call.onClientAudio(new Uint8Array(1920));
    h.call.onClientAudio(new Uint8Array(1920));
    await until('appended', () => h.commands('input_audio.append').length === 2);
    expect(h.sink.find('input.ready')).toHaveLength(1);
    // A frame over the contract's bound is not forwarded.
    h.call.onClientAudio(new Uint8Array(49_153));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands('input_audio.append')).toHaveLength(2);
    await h.call.end('hangup');
  });

  it('refuses a person without voice-mode on the server, before anything is reserved or dialled', async () => {
    const h = harness({ voiceMode: false });
    await h.call.open(START);
    expect(h.sink.find('error')[0]?.code).toBe('plan-required');
    expect(h.sink.find('session.closed')[0]?.reason).toBe('error');
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.startCall).not.toHaveBeenCalled();
    expect(h.server.sessions).toHaveLength(0);
    expect(h.sink.closed).toBe(true);
  });

  it('never tells a person to pay when their plan could not be read: a retryable unavailable', async () => {
    const h = harness({ entitlementsUnavailable: true });
    await h.call.open(START);
    expect(h.sink.find('error')[0]).toMatchObject({
      code: 'realtime-unavailable',
      retryable: true,
    });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.server.sessions).toHaveLength(0);
  });

  it('refuses when the credits do not cover the first block, without taking over another call', async () => {
    const h = harness({ reserve: async () => null });
    await h.call.open(START);
    expect(h.sink.find('error')[0]?.code).toBe('credits-exhausted');
    expect(h.startCall).not.toHaveBeenCalled();
    expect(h.server.sessions).toHaveLength(0);
  });

  it('refuses an agent it cannot reach as agent-unavailable', async () => {
    const missing = harness({ turnAgent: { kind: 'unavailable', reason: 'not_found' } });
    await missing.call.open({ ...START, agentId: 'agent-1' });
    expect(missing.sink.find('error')[0]?.code).toBe('agent-unavailable');
    expect(missing.server.sessions).toHaveLength(0);
  });

  it('refuses a group conversation: its turns are its members’, never Alia’s by default', async () => {
    const h = harness();
    await h.call.open({ ...START, conversationId: 'group-1' });
    expect(h.sink.find('error')[0]?.code).toBe('agent-unavailable');
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.startCall).not.toHaveBeenCalled();
    expect(h.server.sessions).toHaveLength(0);
  });

  it('is realtime-unavailable without a Kaana client, or with no line that holds a live call', async () => {
    const none = harness({ noKaana: true });
    await none.call.open(START);
    expect(none.sink.find('error')[0]?.code).toBe('realtime-unavailable');

    // Dictation lines and a `conversation` line hold no live call.
    const noLive = harness({
      models: [
        catalogueModel('x-ai/grok-voice-transcribe-2.0'),
        catalogueModel('x-ai/grok-voice-3.0'),
      ],
    });
    await noLive.call.open(START);
    expect(noLive.sink.find('error')[0]?.code).toBe('realtime-unavailable');
    expect(noLive.reserve).not.toHaveBeenCalled();
  });

  it('tries the next live line only when the default model itself refused', async () => {
    const tried: string[] = [];
    // Kaana answering the default line with its own refusal of the model.
    const refusing =
      (refusal: () => Error) => (kaana: import('../../kaana/port.js').KaanaClient) => ({
        ...kaana,
        realtime: {
          connect: (async (request, options) => {
            tried.push(request.model);
            if (request.model === LIVE_DEFAULT.modelId) throw refusal();
            return kaana.realtime.connect(request, options);
          }) as typeof kaana.realtime.connect,
        },
      });
    const modelGone = () =>
      new KaanaError({
        code: 'model_not_found',
        message: 'gone',
        status: 404,
        requestId: 'req_1',
        retryable: false,
      });
    const h = await opened({ wrapKaana: refusing(modelGone) });
    expect(tried).toEqual([LIVE_DEFAULT.modelId, LIVE_FALLBACK.modelId]);
    expect(h.session().model.modelId).toBe(LIVE_FALLBACK.modelId);
    expect(h.session().open.config.voice).toBe(voiceOf(LIVE_FALLBACK, 'female'));
    await h.call.end('hangup');

    tried.length = 0;
    const billing = () =>
      new KaanaBillingError({
        code: 'insufficient_balance',
        message: 'no balance',
        status: 402,
        requestId: 'req_2',
        retryable: false,
      });
    const refused = harness({ wrapKaana: refusing(billing) });
    await refused.call.open(START);
    // Not the model's refusal: no other line is tried.
    expect(tried).toEqual([LIVE_DEFAULT.modelId]);
    expect(refused.sink.find('error')[0]?.code).toBe('realtime-limited');
    // Nothing was served: every credit held is given back.
    expect(refused.refund).toHaveBeenCalledOnce();
    expect(refused.finalize).not.toHaveBeenCalled();
  });
});

describe('hanging up while the call opens', () => {
  it('ends the row written meanwhile and gives back a block held meanwhile', async () => {
    let releaseStart: () => void = () => undefined;
    const h = harness();
    h.startCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStart = () => resolve({ replaced: 0 });
        }),
    );
    const opening = h.call.open(START);
    await until('startCall', () => h.startCall.mock.calls.length === 1);
    await h.call.end('hangup');
    releaseStart();
    await opening;
    expect(h.finishCall).toHaveBeenCalledWith(h.call.callId, 'hangup');
    expect(h.server.sessions).toHaveLength(0);
    expect(h.refund).toHaveBeenCalledOnce();
  });
});

describe('every turn is a typed turn, through the chat route', () => {
  it('runs the delegated turn with the stored history, its ids and the person’s credentials', async () => {
    const h = await opened({ history: [{ id: 'm1', role: 'user', content: 'Antes' }] });
    h.call.setAccessToken('token-2', 'clarity-assertion');
    personSays(h, 'd1', 'Recuérdame llamar a Ana mañana');
    await until('turn asked', () => h.turns.requests.length === 1);
    const request = h.turns.requests[0]!;
    expect(request).toMatchObject({
      accessToken: 'token-2',
      appAssertion: 'clarity-assertion',
      conversationId: START.conversationId,
    });
    expect(request).not.toHaveProperty('agentId');
    expect(request.turnId).toMatch(/^[0-9a-f-]{36}$/);
    // The person's words are their message, under the id their transcript was drawn under.
    const userMessageId = h.sink.find('transcript.done')[0]!.messageId;
    expect(request.messages).toEqual([
      { id: 'm1', role: 'user', content: 'Antes' },
      { id: userMessageId, role: 'user', content: 'Recuérdame llamar a Ana mañana' },
    ]);
    await until('final reply', () => replies(h).some((reply) => reply.final));
    // Stored by the chat route, as a typed turn is; the call stores nothing itself.
    expect(h.stored.map((message) => message.id)).toEqual([
      'm1',
      userMessageId,
      request.assistantMessageId,
    ]);
    expect(h.sink.find('messages.saved')[0]).toEqual(
      expect.objectContaining({
        conversationId: START.conversationId,
        messageIds: [userMessageId, request.assistantMessageId],
      }),
    );
    await h.call.end('hangup');
  });

  it('names the gemie the call named, as a typed turn does', async () => {
    const h = harness();
    await h.call.open({ ...START, agentId: 'gemie-7' });
    await until('session.ready', () => h.sink.types().includes('session.ready'));
    personSays(h, 'd1', 'Hola');
    await until('turn asked', () => h.turns.requests.length === 1);
    expect(h.turns.requests[0]!.agentId).toBe('gemie-7');
    await h.call.end('hangup');
  });

  it('streams the answer one sentence per reply, the last final, with its exact spans verbatim', async () => {
    const h = await opened();
    h.turns.answer(
      say('Listo. Te llamo a las 10:30 en la ', 'Calle Mayor 12. Tu código es AB12-CD', '.'),
    );
    personSays(h, 'd1', 'Recuérdamelo');
    await until('final reply', () => replies(h).some((reply) => reply.final));
    const sent = replies(h, 'd1');
    expect(sent.map(({ text, final }) => ({ text, final }))).toEqual([
      { text: 'Listo.', final: false },
      { text: 'Te llamo a las 10:30 en la Calle Mayor 12.', final: false },
      { text: 'Tu código es AB12-CD.', final: true },
    ]);
    expect(sent[0]).not.toHaveProperty('verbatim');
    expect(sent[1]!.verbatim).toEqual(['10:30', 'Calle Mayor', '12']);
    expect(sent[2]!.verbatim).toEqual(['AB12-CD']);
    // Every span is a part of its reply, exactly as written.
    for (const reply of sent)
      for (const span of reply.verbatim ?? []) expect(reply.text).toContain(span);
    expect(h.sink.find('assistant.done').at(-1)?.status).toBe('completed');
    await h.call.end('hangup');
  });

  it('tells the device which tool runs, under the answer it belongs to, and the voice to hold on', async () => {
    const h = await opened();
    h.turns.answer(withTool('createReminder', true, 'Hecho, te lo recuerdo mañana.'));
    personSays(h, 'd1', 'Recuérdame comprar pan');
    await until('final reply', () => replies(h).some((reply) => reply.final));
    const { assistantMessageId } = h.turns.requests[0]!;
    expect(h.sink.find('tool.started')).toEqual([
      expect.objectContaining({
        messageId: assistantMessageId,
        callId: 'call_createReminder',
        name: 'createReminder',
      }),
    ]);
    expect(h.sink.find('tool.finished')[0]).toMatchObject({
      messageId: assistantMessageId,
      ok: true,
    });
    expect(h.commands('delegation.context')).toEqual([
      expect.objectContaining({
        delegationId: 'd1',
        text: expect.stringContaining('createReminder'),
      }),
    ]);
    // The voice's own words of this turn are drawn under the same answer.
    h.session().emit({
      type: 'transcript.delta',
      source: 'output_audio',
      itemId: 'out_1',
      contentIndex: 0,
      text: 'Hecho',
    });
    await until('assistant transcript', () => h.sink.find('transcript.delta').length === 2);
    expect(h.sink.find('transcript.delta')[1]).toMatchObject({
      role: 'assistant',
      messageId: assistantMessageId,
    });
    await h.call.end('hangup');
  });

  it('carries the voice audio to the device, framed by its item', async () => {
    const h = await opened();
    h.session().emit({
      type: 'output_audio.delta',
      responseId: 'r1',
      itemId: 'out_1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });
    await until('audio', () => h.sink.audio.length === 1);
    expect(h.sink.audioFor('out_1')).toBe(40 * 48);
    await h.call.end('hangup');
  });

  it('a failed turn is a typed failure: the voice is told in context and the turn dropped, no filler', async () => {
    const h = await opened();
    h.turns.answer(failing('RATE_LIMITED'));
    personSays(h, 'd1', 'Hola');
    await until('dropped', () => h.commands('delegation.cancel').length === 1);
    expect(replies(h)).toHaveLength(0);
    expect(h.commands('delegation.context')[0]!.text).toMatch(/could not be answered/);
    expect(h.sink.find('assistant.done').at(-1)?.status).toBe('failed');
    expect(h.sink.find('messages.saved')).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
    // The call goes on: the next turn is answered.
    personSays(h, 'd2', 'Otra vez');
    await until('answered', () => replies(h, 'd2').some((reply) => reply.final));
    expect(h.sink.types()).not.toContain('session.closed');
    await h.call.end('hangup');
  });
});

describe('a superseded turn is stopped', () => {
  it("aborts the turn's signal and stops it the way Stop does; its words open the next turn", async () => {
    const h = await opened();
    const first = pausedAfter('Vale, ');
    h.turns.answer(first.script, say('Perfecto, a las cinco.'));
    personSays(h, 'd1', 'Pon una alarma');
    await until('first turn', () => h.turns.requests.length === 1);
    const stopped = h.turns.requests[0]!;
    // A newer delegation before d1's final reply: Kaana supersedes d1 first.
    h.session().emit({ type: 'delegation.requested', delegationId: 'd2', text: 'a las cinco' });
    await until('second turn', () => h.turns.requests.length === 2);
    expect(stopped.signal.aborted).toBe(true);
    expect(h.turns.cancelled).toEqual([
      expect.objectContaining({ turnId: stopped.turnId, conversationId: START.conversationId }),
    ]);
    // Nothing more is spoken for it.
    expect(replies(h, 'd1')).toHaveLength(0);
    // The stopped turn stored nothing, so its words come with the next.
    expect(h.turns.requests[1]!.messages.at(-1)?.content).toBe('Pon una alarma a las cinco');
    await until('answered', () => replies(h, 'd2').some((reply) => reply.final));
    expect(h.stored.map((message) => message.content)).toEqual([
      'Pon una alarma a las cinco',
      'Perfecto, a las cinco.',
    ]);
    await h.call.end('hangup');
  });

  it('never repeats words a superseded turn managed to store', async () => {
    const h = await opened();
    const first = pausedAfter('Hecho.');
    h.turns.answer(first.script);
    personSays(h, 'd1', 'Uno');
    await until('first turn', () => h.turns.requests.length === 1);
    // The first turn had already been stored when the voice moved on.
    const { messages, assistantMessageId } = h.turns.requests[0]!;
    h.stored.push(messages.at(-1)!, {
      id: assistantMessageId,
      role: 'assistant',
      content: 'Hecho.',
    });
    h.session().emit({ type: 'delegation.requested', delegationId: 'd2', text: 'Dos' });
    await until('second turn', () => h.turns.requests.length === 2);
    expect(h.turns.requests[1]!.messages.at(-1)?.content).toBe('Dos');
    await h.call.end('hangup');
  });
});

describe('limits', () => {
  it('ends an idle call with idle-timeout, once, and settles', async () => {
    const h = await opened({ limits: { idleTimeoutMs: 1_000 } });
    await until('closed', () => h.sink.types().includes('session.closed'), 2_000);
    expect(h.sink.find('session.closed')[0]?.reason).toBe('idle-timeout');
    expect(h.finishCall).toHaveBeenCalledWith(h.call.callId, 'idle_timeout');
    expect(h.session().closed).toBe(true);
    expect(h.finalize).toHaveBeenCalledOnce();
  });

  it('warns a minute before the duration ends, then ends with max-duration', async () => {
    const h = await opened({ limits: { maxDurationMs: 120, warningBeforeMs: 60 } });
    await until('closed', () => h.sink.types().includes('session.closed'), 2_000);
    expect(h.sink.find('session.warning')[0]).toMatchObject({
      code: 'ending-soon',
      remainingMs: 60,
    });
    expect(h.sink.find('session.closed')[0]?.reason).toBe('max-duration');
  });

  it('follows the upstream when Kaana closes the session for its own limit', async () => {
    const h = await opened();
    h.session().emit({
      type: 'session.closed',
      reason: 'idle_timeout',
      units: [],
      usageSource: 'provider_reported',
      closedAt: new Date().toISOString(),
    });
    await until('closed', () => h.sink.types().includes('session.closed'));
    expect(h.sink.find('session.closed')[0]?.reason).toBe('idle-timeout');
  });
});

describe('one call per person', () => {
  it('hangs up with call-moved-elsewhere when another device takes over', async () => {
    const h = await opened();
    const session = h.session();
    await h.held()!.takenOver();
    expect(h.sink.find('session.closed')[0]?.reason).toBe('call-moved-elsewhere');
    expect(h.sink.find('error')).toHaveLength(0);
    // The takeover already ended the row; this task does not end it again.
    expect(h.finishCall).not.toHaveBeenCalled();
    expect(session.closed).toBe(true);
  });

  it('a hang-up leaves the answer being given to finish and be stored, as a typed turn does', async () => {
    const h = await opened();
    const answer = pausedAfter('Vale.');
    h.turns.answer(answer.script);
    personSays(h, 'd1', 'Hola');
    await until('turn asked', () => h.turns.requests.length === 1);
    await h.call.end('hangup');
    // Only this side stopped listening: the chat route's turn is not cancelled.
    expect(h.turns.cancelled).toHaveLength(0);
    expect(h.turns.requests[0]!.signal.aborted).toBe(true);
  });
});

describe('reconnection', () => {
  it('resumes the same upstream session after a dropped connection', async () => {
    const h = await opened();
    const session = h.session();
    session.drop();
    await until('reconnecting', () => h.sink.types().includes('session.reconnecting'));
    // The same session, resumed: an event after the drop reaches the client.
    session.emit({ type: 'input_audio.speech_started', itemId: 'u9', audioStartMs: 0 });
    await until('event after resume', () => h.sink.find('user.speech_started').length === 1);
    expect(h.server.sessions).toHaveLength(1);
    await h.call.end('hangup');
  });

  it('opens a new session on the same line, from the stored messages, when resume cannot work', async () => {
    const h = await opened({ history: [{ id: 'm1', role: 'user', content: 'antes' }] });
    const first = h.session();
    h.stored.push({ id: 'm2', role: 'assistant', content: 'después' });
    // Gone while the connection was down: the resume is refused.
    first.drop();
    first.end('upstream_error');
    await until('second session', () => h.server.sessions.length === 2);
    await until('ready again', () => h.sink.find('session.ready').length === 2);
    expect(h.server.sessions[1]!.model.modelId).toBe(first.model.modelId);
    expect(h.server.sessions[1]!.open.config.instructions).toContain('You: después');
    expect(h.startCall).toHaveBeenCalledOnce();
    await h.call.end('hangup');
  });

  it('opens a new session when the Kaana task shuts down, stopping the turns of the old one', async () => {
    const h = await opened();
    const answer = pausedAfter('Vale.');
    h.turns.answer(answer.script);
    personSays(h, 'd1', 'Hola');
    await until('turn asked', () => h.turns.requests.length === 1);
    h.session().emit({
      type: 'session.closed',
      reason: 'server_shutdown',
      units: [],
      usageSource: 'provider_reported',
      closedAt: new Date().toISOString(),
    });
    await until('second session', () => h.server.sessions.length === 2);
    expect(h.turns.requests[0]!.signal.aborted).toBe(true);
    expect(h.turns.cancelled).toHaveLength(1);
    await h.call.end('hangup');
  });

  it('replays what a resuming client missed, and ends when nobody resumes in time', async () => {
    const h = await opened({ limits: { resumeWindowMs: 60 } });
    const lastSeen = h.sink.events.at(-1)!.seq;
    h.call.detach(h.sink);
    h.session().emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const back = new RecordingSink();
    expect(h.call.attach(back, lastSeen)).toBe(true);
    expect(back.types()).toEqual(['user.speech_started', 'session.resumed']);
    h.call.detach(back);
    await until('closed', () => h.call.isClosed);
    await h.call.ended;
    expect(h.finishCall).toHaveBeenCalledWith(h.call.callId, 'error');
  });
});

describe('credits per minute, at the real cost', () => {
  it("settles the call's minutes at the line's price per minute; the turns are charged as turns", async () => {
    let clock = 1_000_000;
    const h = await opened({ now: () => clock });
    const perMinute = Number(LIVE_DEFAULT.pricePerMinute!.amount);
    // The block held five minutes at the catalogue's minute.
    expect(h.reservations[0]!.creditsReserved).toBe(creditsForCost(perMinute * 5));
    personSays(h, 'd1', 'Hola');
    await until('answered', () => replies(h).some((reply) => reply.final));
    clock += 90_000;
    await h.call.end('hangup');
    // 90 s, silence included, at the published minute: the turn is not in it.
    expect(h.finalize).toHaveBeenCalledOnce();
    expect(h.finalize).toHaveBeenCalledWith(h.reservations[0], creditsForCost(perMinute * 1.5));
    expect(h.session().closed).toBe(true);
    expect(h.recordAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        model: LIVE_DEFAULT.modelId,
        resolvedModelReference: `${LIVE_DEFAULT.modelId}@${LIVE_DEFAULT.currentRevision}`,
      }),
    );
    expect(h.finishCall).toHaveBeenCalledWith(h.call.callId, 'hangup');
  });

  it('ends with credits-exhausted after the turn being answered when the next block is refused', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const h = await opened({
      now: () => clock,
      limits: { creditCheckMs: 10 },
      reserve: async (userId, credits) => {
        calls += 1;
        return calls === 1
          ? {
              userId,
              creditsReserved: credits,
              initialFreeCredits: 0,
              initialPaidCredits: 0,
              grantKind: 'paid_balance',
            }
          : null;
      },
    });
    const answer = pausedAfter('Un momento. ', 'Ya está.');
    h.turns.answer(answer.script);
    personSays(h, 'd1', 'Hola');
    await until('turn asked', () => h.turns.requests.length === 1);
    // Four and a half minutes into a five-minute block, mid-answer.
    clock += 270_000;
    await until('next block asked', () => calls === 2);
    expect(h.sink.types()).not.toContain('session.closed');
    // Never mid-answer: the turn being answered finishes first.
    answer.release();
    await until('closed', () => h.sink.types().includes('session.closed'));
    expect(replies(h).at(-1)?.final).toBe(true);
    expect(h.sink.find('error')[0]?.code).toBe('credits-exhausted');
    expect(h.sink.find('session.closed')[0]?.reason).toBe('credits-exhausted');
  });
});

describe('typed failures', () => {
  it('a fatal upstream error ends the call typed, with no filler audio or text', async () => {
    const h = await opened();
    const audioBefore = h.sink.audio.length;
    h.session().emit({
      type: 'error',
      fatal: true,
      error: {
        schemaVersion: 1,
        code: 'provider_overloaded',
        message: 'busy',
        retryable: true,
        requestId: 'r',
      },
    });
    await until('closed', () => h.sink.types().includes('session.closed'));
    expect(h.sink.find('error')[0]).toMatchObject({
      code: 'realtime-failed',
      retryable: true,
      reference: h.call.callId,
    });
    expect(h.sink.audio.length).toBe(audioBefore);
    expect(h.sink.find('transcript.done')).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });
});
