import {
  useAgentDraftAutosave,
  useAgentIdentityAutosave,
} from '@/features/agents/runtime/use-agent-autosave';
import { hasOxyAccount } from '@/features/agents/model/identity';
import { AgentProfileFields } from '@/features/agents/ui/edit/agent-profile-fields';
import type { Agent } from '@/shared/contracts/agents';

/**
 * The agent editor, for one loaded agent, as Bloom's multi-agent chat shows it: who the agent is
 * (Bloom's `AgentCreator`) and its handle. It owns the draft; `AgentEditorLoader` owns loading it
 * and keys this on the agent, so opening another agent starts another draft and opening the same
 * one again never restarts this one (the write loop `use-agent-autosave.ts` explains).
 */
export function AgentEditor({ agent, onClose }: { agent: Agent; onClose?: () => void }) {
  const { draft, editDraft } = useAgentDraftAutosave(agent);
  const { identity, editIdentity } = useAgentIdentityAutosave(agent);

  return (
    <AgentProfileFields
      id={agent._id}
      hasAccount={hasOxyAccount(agent)}
      identity={identity}
      draft={draft}
      onEditIdentity={editIdentity}
      onEditDraft={editDraft}
      onClose={onClose}
    />
  );
}
