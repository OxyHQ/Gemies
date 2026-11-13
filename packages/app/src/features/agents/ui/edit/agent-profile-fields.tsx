import type { AgentDraft, IdentityDraft } from '@/features/agents/runtime/use-agent-autosave';
import { AgentEditorSections } from '@/features/agents/ui/edit/sections/agent-editor-sections';
import { useTranslation } from '@/shared/i18n/use-translation';
import { AgentCreator, AgentCreatorField } from '@oxy.so/bloom/agent-creator';
import { TextFieldInput } from '@oxy.so/bloom/text-field';

/**
 * Who the agent is: Bloom's `AgentCreator` for the name, the tagline, the description and the
 * look, the handle as a row of the editor's own card, and below it the cards of what the agent has
 * (how it works on its own, what it hears, its inbox, what it remembers: `AgentEditorSections`).
 *
 * Two stores, one editor. The name, the handle and the colour are the bot ACCOUNT's, saved to Oxy;
 * the tagline, description and character (its shape and features, no colour) are the agent row's,
 * saved to Gemies. The editor hands back one agent, and each field is routed to the draft it belongs
 * to. No voice: gemies have none.
 *
 * A gemie with no Oxy account (ADR 0036, an external agent) is the same editor with what it has:
 * its name and colour are its row's, and it has no handle, and none of the cards below — they
 * configure Gemies' own runtime (its work, accounts, events, inbox and memory), and an external
 * agent runs on its owner's computer.
 *
 * The colour control is Bloom's free picker: any colour, written as a hex where the identity lives.
 */
export function AgentProfileFields({
  id,
  hasAccount,
  identity,
  draft,
  onEditIdentity,
  onEditDraft,
  onClose,
}: {
  id: string;
  /** Whether the gemie IS an Oxy account: it has a handle and the cards of Gemies' runtime. */
  hasAccount: boolean;
  identity: IdentityDraft;
  draft: Pick<AgentDraft, 'tagline' | 'description' | 'character'>;
  onEditIdentity: (patch: Partial<IdentityDraft>) => void;
  onEditDraft: (patch: Partial<AgentDraft>) => void;
  /** The creator's own close button, when the editor is a panel. */
  onClose?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AgentCreator
      style={{ flex: 1 }}
      onClose={onClose}
      showPreferences={false}
      sections={hasAccount ? <AgentEditorSections agentId={id} name={identity.name} /> : undefined}
      agent={{
        id,
        name: identity.name,
        label: draft.tagline,
        description: draft.description,
        avatar: draft.character,
        color: identity.color,
      }}
      onChange={(next) => {
        const account: Partial<IdentityDraft> = {};
        if (next.name !== identity.name) account.name = next.name;
        if (next.color !== identity.color) account.color = next.color;
        if (Object.keys(account).length > 0) onEditIdentity(account);
        const patch: Partial<AgentDraft> = {};
        if (next.label !== draft.tagline) patch.tagline = next.label;
        if (next.description !== draft.description) patch.description = next.description;
        if (next.avatar !== draft.character) patch.character = next.avatar;
        if (Object.keys(patch).length > 0) onEditDraft(patch);
      }}
    >
      {/* The handle was PROPOSED at creation and may carry a collision suffix nobody chose, so it is
          editable here rather than permanent: a row of the editor's own card, handed in. */}
      {hasAccount ? (
        <AgentCreatorField label={t('agents.handleLabel')}>
          <TextFieldInput
            label={t('agents.handlePlaceholder')}
            size="sm"
            maxLength={32}
            value={identity.handle}
            onChangeText={(text) => onEditIdentity({ handle: text })}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </AgentCreatorField>
      ) : null}
    </AgentCreator>
  );
}
