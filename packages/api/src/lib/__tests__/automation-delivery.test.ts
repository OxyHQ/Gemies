/**
 * A task delivers where it was asked for (ADR 0037, amendment): the conversation is the turn's,
 * set by the server, never one the model wrote into the task's inputs.
 */
import { describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../structured-automation-creation.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createStructuredAutomation: vi.fn(async (input: { definition: Record<string, unknown> }) => {
    created.push(input.definition);
    return {
      automation: { id: 'a1', objective: 'o', enabled: true, trigger: { type: 'schedule' } },
    };
  }),
}));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { triggers: child, general: child } };
});

const { deliveryConversationOf, withDelivery } = await import('../automation-delivery.js');
const { createAutomationTool } = await import('../tools/automation-create.js');

describe('where a task delivers', () => {
  it('is the turn’s conversation, over anything the model put there', () => {
    const inputs = withDelivery(
      { runOnce: true, deliverTo: { conversationId: 'someone-elses' } },
      'telegram:8988966019:570038640',
    );
    expect(inputs).toEqual({
      runOnce: true,
      deliverTo: { conversationId: 'telegram:8988966019:570038640' },
    });
    expect(deliveryConversationOf(inputs)).toBe('telegram:8988966019:570038640');
  });

  it('is the gemie’s thread for a task asked in no conversation', () => {
    const inputs = withDelivery({ deliverTo: { conversationId: 'forged' } }, undefined);
    expect(inputs).toEqual({});
    expect(deliveryConversationOf(inputs)).toBeUndefined();
    expect(deliveryConversationOf(null)).toBeUndefined();
  });

  it('is recorded by the task tool from the turn it runs in', async () => {
    const tool = createAutomationTool(
      'owner-1',
      undefined,
      { _id: 'gemie-1', taskAuthority: 'session' },
      { conversationId: 'telegram:8988966019:570038640' },
    );
    await tool.execute?.(
      {
        objective: 'El tiempo de mañana en Barcelona',
        trigger: { type: 'schedule', cron: '0 8 * * *', timezone: 'Europe/Madrid' },
        executionMode: 'execute',
        maximumAutonomy: 'autonomous',
        actions: [],
        resources: [],
        dataFlow: { sources: [], destinations: [] },
        inputs: { deliverTo: { conversationId: 'forged' } },
        enabled: true,
      } as never,
      { toolCallId: 'c1', messages: [] } as never,
    );
    expect(created.at(-1)?.inputs).toEqual({
      deliverTo: { conversationId: 'telegram:8988966019:570038640' },
    });
  });
});
