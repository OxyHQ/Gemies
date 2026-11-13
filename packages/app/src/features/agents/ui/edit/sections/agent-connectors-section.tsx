import { useUpdateAgent } from '@/features/agents/runtime/use-agents';
import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import {
  ConnectorLogo,
  GrantSwitchRow,
  connectorQueryKeys,
  useConnections,
} from '@gemies/sdk/connectors';
import { AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

/** This section's own strings. */
const K = 'agents.editor.connectors';

/** The grant that gives a gemie one connected account (`domain/capability-grants.ts`, `mcp:<id>`). */
const grantOf = (connectionId: string) => `mcp:${connectionId}`;

/**
 * Which of the person's connected accounts this gemie may use, one switch each: a gemie is granted
 * an account, never a connector in general, so with two Notion workspaces it reaches only the one
 * it was given. Connecting more is the store's (`/connectors`).
 */
export function AgentConnectorsSection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: agents, isPending: agentsPending } = useMyAgents();
  const connections = useConnections();
  const update = useUpdateAgent();
  const agent = agents?.find((candidate) => candidate._id === agentId);
  const grants = agent?.capabilityGrants ?? [];

  const toggle = async (connectionId: string, on: boolean) => {
    const grant = grantOf(connectionId);
    const next = on ? [...grants, grant] : grants.filter((existing) => existing !== grant);
    try {
      await update.mutateAsync({ id: agentId, updates: { capabilityGrants: next } });
      // Settings › Connected says which gemies use each account.
      await queryClient.invalidateQueries({ queryKey: connectorQueryKeys.connected });
    } catch {
      toast.error(t('settings.saveFailed'));
    }
  };

  const rows = (connections.data ?? []).filter((connection) => connection.status === 'running');

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      {agentsPending || connections.isPending ? (
        <SettingsSkeletonRows control="switch" rows={2} />
      ) : (
        <>
          {rows.length === 0 ? (
            <View className="py-2.5 pe-2.5">
              <Text variant="body-2-regular" className="text-text-secondary">
                {t(`${K}.empty`, { name })}
              </Text>
            </View>
          ) : (
            rows.map((connection, index) => (
              <GrantSwitchRow
                key={connection._id}
                first={index === 0}
                leading={
                  <ConnectorLogo
                    name={connection.displayName}
                    logoUrl={connection.logoUrl}
                    size={24}
                  />
                }
                label={
                  connection.accountLabel
                    ? `${connection.displayName} · ${connection.accountLabel}`
                    : connection.displayName
                }
                checked={grants.includes(grantOf(connection._id))}
                disabled={update.isPending}
                accessibilityLabel={t(`${K}.grantLabel`, {
                  connector: connection.displayName,
                  name,
                })}
                onCheckedChange={(on) => void toggle(connection._id, on)}
              />
            ))
          )}
          <View className="flex-row border-t border-border py-2.5 pe-2.5">
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              onPress={() => router.push('/(app)/connectors')}
            >
              {t('gemie.connectors.connected.browse')}
            </Button>
          </View>
        </>
      )}
    </AgentCreatorSection>
  );
}
