import { AgentAccountsSection } from '@/features/agents/ui/edit/sections/agent-accounts-section';
import { AgentConnectorsSection } from '@/features/agents/ui/edit/sections/agent-connectors-section';
import { AgentHearsSection } from '@/features/agents/ui/edit/sections/agent-hears-section';
import { AgentInboxSection } from '@/features/agents/ui/edit/sections/agent-inbox-section';
import { AgentMemorySection } from '@/features/agents/ui/edit/sections/agent-memory-section';
import { AgentTelegramBotSection } from '@/features/agents/ui/edit/sections/agent-telegram-bot-section';
import { AgentWorkSection } from '@/features/agents/ui/edit/sections/agent-work-section';
import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';

/**
 * What an agent HAS beyond who it is, as the cards below the editor's details card: how it works
 * on its own, the WhatsApp and Telegram accounts it answers on (ADR 0035), its own Telegram bot
 * (ADR 0037), the connected accounts (Notion, Linear…) it may use, what it hears about, what waits
 * in its inbox and what it remembers about the person. They are per agent, so they live here, where
 * the agent is edited, and not in the settings.
 */
export function AgentEditorSections({
  agentId,
  name,
  look,
}: {
  agentId: string;
  name: string;
  /** Its character and colour, which its Telegram bot takes as its picture. */
  look: { character: AvatarCharacter; color: string | null };
}) {
  return (
    <>
      <AgentWorkSection agentId={agentId} name={name} />
      <AgentAccountsSection agentId={agentId} name={name} />
      <AgentTelegramBotSection agentId={agentId} name={name} look={look} />
      <AgentConnectorsSection agentId={agentId} name={name} />
      <AgentHearsSection agentId={agentId} name={name} />
      <AgentInboxSection agentId={agentId} name={name} />
      <AgentMemorySection agentId={agentId} name={name} />
    </>
  );
}
