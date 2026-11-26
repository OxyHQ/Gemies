import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { useStartGroup } from '@/features/agents/runtime/use-start-group';
import { agentDisplayName } from '@/features/agents/model/identity';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useTranslation } from '@/shared/i18n/use-translation';
import { readAgentCharacter } from '@gemies/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { useAvatarFlights } from '@oxy.so/bloom/avatar-flight';
import { List } from '@oxy.so/bloom/list';
import { Dialog } from '@oxy.so/bloom/dialog';
import { SelectedAgentPreview } from '@oxy.so/bloom/multi-agent-chat/selected-agent-preview';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';

/** The most agents one group holds (the API's own limit, `domain/conversation-groups.ts`). */
const GROUP_MAX = 6;
const GROUP_MIN = 2;

/**
 * The dialog in which the person picks who joins a new group conversation, as Bloom's multi-agent
 * chat does: the chosen agents composed above (one large avatar, a trio, a ring), and the person's
 * own agents below as chips to toggle. Opened from the chat menu ("Start a group chat"); it starts
 * the conversation and goes to it.
 */
export function GroupPickerDialog() {
  const { t } = useTranslation();
  const open = useUIStore((s) => s.groupPickerOpen);
  const setOpen = useUIStore((s) => s.setGroupPickerOpen);
  const { data: agents } = useMyAgents();
  const { start, starting } = useStartGroup();
  const flights = useAvatarFlights();
  const [selected, setSelected] = useState<string[]>([]);

  const chosen = useMemo(
    () =>
      selected.flatMap((id) => {
        const agent = agents?.find((candidate) => candidate._id === id);
        return agent
          ? [
              {
                id,
                name: agentDisplayName(agent),
                label: '',
                description: '',
                avatar: readAgentCharacter(agent.character, agent.color),
                // Already painted in it; an account colour that did not resolve leaves that paint.
                color: agent.color ?? '',
              },
            ]
          : [];
      }),
    [selected, agents],
  );

  const close = () => {
    setOpen(false);
    setSelected([]);
  };
  const selectAgent = (id: string, checked: boolean) =>
    setSelected((ids) =>
      checked
        ? ids.includes(id) || ids.length >= GROUP_MAX
          ? ids
          : [...ids, id]
        : ids.filter((candidate) => candidate !== id),
    );
  const begin = async () => {
    try {
      await start(selected);
      close();
    } catch {
      toast.error(t('group.startFailed'));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('group.title')}
      actions={[
        {
          label: t('group.start', { count: selected.length }),
          disabled: selected.length < GROUP_MIN || starting,
          shouldCloseOnPress: false,
          onPress: () => void begin(),
        },
      ]}
    >
      <View style={styles.stack}>
        <SelectedAgentPreview agents={chosen} flights={flights} anchor="picker" caption />
        <List
          accessibilityLabel={t('group.choose')}
          style={{ width: '100%' }}
          items={(agents ?? []).map((agent) => ({
            id: agent._id,
            title: agentDisplayName(agent),
            label: agentDisplayName(agent),
            role: 'checkbox',
            leading: (
              <AgentAvatar
                character={readAgentCharacter(agent.character, agent.color)}
                size={36}
                portrait
              />
            ),
            checked: selected.includes(agent._id),
            selecting: true,
            onCheckedChange: (checked) => selectAgent(agent._id, checked),
          }))}
        />
        {(agents ?? []).length < GROUP_MIN ? <Muted>{t('group.needTwo')}</Muted> : null}
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: 'center', gap: 16 },
});
