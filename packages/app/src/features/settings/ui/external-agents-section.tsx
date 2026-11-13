import {
  useExternalAgents,
  type ExternalAgent,
} from '@/features/connections/runtime/use-external-agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsRowsSkeleton } from '@/shared/ui/skeletons';
import { Button } from '@oxy.so/bloom/button';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { SettingsProfilePage } from '@oxy.so/bloom/settings-modal';
import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { View } from 'react-native';

const CLI_LABELS: Record<ExternalAgent['cli'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

const agentLabel = (agent: ExternalAgent) => `${CLI_LABELS[agent.cli]} · ${agent.hostName}`;

/**
 * Connect a coding-agent CLI (Claude Code, Codex, OpenCode) to Gemies as one of the person's gemies
 * (ADR 0030, ADR 0038): mint a single-use code, hand over the one text to paste — the agent signs in
 * to nothing, the code is the authorisation — and list what is connected. A connected one can be
 * reconnected (a new machine, a lost credential) with a code for it, keeping the gemie.
 */
export function ExternalAgentsSection() {
  const { t, locale } = useTranslation();
  const { agents, loading, invite, inviteExpired, createInvite, remove } = useExternalAgents(
    locale ?? 'en',
  );
  const [creating, setCreating] = useState(false);

  const copyPrompt = async (prompt: string) => {
    await Clipboard.setStringAsync(prompt);
    toast.success(t('settings.connections.externalAgents.copied'));
  };

  const handleCreate = async (agentId?: string) => {
    setCreating(true);
    try {
      await copyPrompt((await createInvite(agentId)).prompt);
    } catch (err) {
      console.error('Failed to create the pairing code:', err);
      toast.error(t('settings.connections.externalAgents.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (invite) await copyPrompt(invite.prompt);
  };

  const handleRemove = async (agent: ExternalAgent) => {
    try {
      await remove(agent.agentId);
      toast.success(t('settings.connections.externalAgents.removed'));
    } catch (err) {
      console.error('Failed to remove the external agent:', err);
      toast.error(t('settings.connections.externalAgents.removeFailed'));
    }
  };

  if (loading) {
    return <SettingsRowsSkeleton rows={2} />;
  }

  const reconnecting = invite?.agentId
    ? agents.find((agent) => agent.agentId === invite.agentId)
    : undefined;
  const expiresAt = invite
    ? new Date(invite.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const inviteRows = invite
    ? [
        {
          key: 'code',
          label: invite.code,
          description: [
            reconnecting
              ? t('settings.connections.externalAgents.reconnectFor', {
                  name: agentLabel(reconnecting),
                })
              : null,
            inviteExpired
              ? t('settings.connections.externalAgents.expired')
              : t('settings.connections.externalAgents.codeHint', { time: expiresAt }),
          ]
            .filter(Boolean)
            .join(' '),
          control: (
            <View className="flex-row gap-2">
              {inviteExpired ? null : (
                <Button
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  leadingIcon={RiFileCopyLine}
                  onPress={handleCopy}
                >
                  {t('settings.connections.externalAgents.copy')}
                </Button>
              )}
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                leadingIcon={RiRefreshLine}
                disabled={creating}
                onPress={() => handleCreate(invite.agentId)}
              >
                {t('settings.connections.externalAgents.regenerate')}
              </Button>
            </View>
          ),
        },
        ...(inviteExpired
          ? []
          : [
              {
                key: 'prompt',
                label: t('settings.connections.externalAgents.promptLabel'),
                description: invite.prompt,
              },
            ]),
      ]
    : [];

  return (
    <SettingsProfilePage
      sections={[
        {
          key: 'connect',
          label: t('settings.connections.externalAgents.title'),
          description: t('settings.connections.externalAgents.description'),
          rows: [
            {
              key: 'create',
              label: t('settings.connections.externalAgents.createLabel'),
              description: t('settings.connections.externalAgents.createHint'),
              control: (
                <Button
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  leadingIcon={RiAddLine}
                  disabled={creating}
                  onPress={() => handleCreate()}
                >
                  {t('settings.connections.externalAgents.create')}
                </Button>
              ),
            },
            ...inviteRows,
          ],
        },
        {
          key: 'connected',
          label: t('settings.connections.externalAgents.connectedTitle'),
          rows: agents.length
            ? agents.map((agent) => ({
                key: agent.agentId,
                label: agentLabel(agent),
                description: agent.online
                  ? t('settings.connections.externalAgents.online')
                  : t('settings.connections.externalAgents.offline'),
                control: (
                  <View className="flex-row gap-2">
                    <Button
                      size="sm"
                      appearance="outline"
                      tone="neutral"
                      disabled={creating}
                      onPress={() => handleCreate(agent.agentId)}
                    >
                      {t('settings.connections.externalAgents.reconnect')}
                    </Button>
                    <Button
                      size="sm"
                      appearance="outline"
                      tone="neutral"
                      onPress={() => handleRemove(agent)}
                    >
                      {t('settings.connections.externalAgents.remove')}
                    </Button>
                  </View>
                ),
              }))
            : [{ key: 'empty', label: t('settings.connections.externalAgents.empty') }],
        },
      ]}
    />
  );
}
