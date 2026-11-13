import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiPlugLine } from '@oxy.so/bloom/icons/RiPlugLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { View } from 'react-native';
import { englishCopy, type Translate } from '../../lib/copy';
import {
  type Connection,
  connectorReturnTo,
  useConnections,
  useConnectorActions,
} from '../../runtime/connectors';
import { ConnectorLogo } from './ConnectorLogo';

/** This component's own strings. */
const K = 'gemie.connectors';

export interface GemieConnectedConnectorsProps {
  /**
   * The native app's URL scheme (`gemies`, `alia`): a provider's sign-in returns to the store at
   * `<scheme>://connectors`, and on the web to the store's page (`connectorReturnTo`).
   */
  nativeScheme: string;
  /** Opens the store, from the header and from the empty list. */
  onBrowse: () => void;
  /** The host's translator; English without one. */
  t?: Translate;
}

const STATUS_COLOR = { running: 'success', error: 'error', installed: 'warning' } as const;

/**
 * What the person connected, for Settings: every account on its own, with its logo, which account
 * of the provider it is, its state, which gemies may use it, and how to reconnect, rename or
 * disconnect it. Nothing they have not connected is listed here; the store is a tap away.
 */
export function GemieConnectedConnectors({
  nativeScheme,
  onBrowse,
  t = englishCopy,
}: GemieConnectedConnectorsProps) {
  const connections = useConnections();
  const actions = useConnectorActions({ returnTo: connectorReturnTo(nativeScheme) });
  const [pending, setPending] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Connection | null>(null);

  const reconnect = async (connection: Connection) => {
    setPending(connection._id);
    try {
      const done = await actions.reconnect.mutateAsync(connection._id);
      if (done?.status === 'running') {
        toast.success(t(`${K}.reconnected`, { name: connection.displayName }));
      }
    } catch {
      toast.error(t(`${K}.reconnectFailed`, { name: connection.displayName }));
    } finally {
      setPending(null);
    }
  };

  const disconnect = async (connection: Connection) => {
    const name = label(connection);
    const ok = await confirm({
      title: t(`${K}.disconnectTitle`, { name }),
      description: t(`${K}.disconnectDescription`, { name: connection.displayName }),
      confirmLabel: t(`${K}.disconnect`),
      cancelLabel: t(`${K}.cancel`),
      destructive: true,
    });
    if (!ok) return;
    setPending(connection._id);
    try {
      await actions.disconnect.mutateAsync(connection._id);
      toast.success(t(`${K}.disconnected`, { name }));
    } catch {
      toast.error(t(`${K}.disconnectFailed`));
    } finally {
      setPending(null);
    }
  };

  if (connections.isPending) return <ConnectedSkeleton />;

  if (connections.isError) {
    return (
      <View className="items-start gap-2 py-2.5">
        <Text variant="body-2-regular" className="text-text-secondary">
          {t(`${K}.connected.loadFailed`)}
        </Text>
        <Button size="sm" appearance="outline" tone="neutral" onPress={() => connections.refetch()}>
          {t(`${K}.store.retry`)}
        </Button>
      </View>
    );
  }

  const rows = connections.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={RiPlugLine}
        title={t(`${K}.connected.emptyTitle`)}
        description={t(`${K}.connected.emptyDescription`)}
        action={{ label: t(`${K}.connected.browse`), onPress: onBrowse }}
      />
    );
  }

  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between gap-3 pb-1">
        <Text variant="body-2-regular" className="flex-1 text-text-secondary">
          {t(`${K}.connected.description`)}
        </Text>
        <Button size="sm" appearance="outline" tone="neutral" onPress={onBrowse}>
          {t(`${K}.connected.browse`)}
        </Button>
      </View>
      {rows.map((connection, index) => (
        <View
          key={connection._id}
          className={`gap-2 py-3 ${index === 0 ? '' : 'border-t border-border'}`}
        >
          <View className="flex-row items-center gap-3">
            <ConnectorLogo name={connection.displayName} logoUrl={connection.logoUrl} size={36} />
            <View className="flex-1 gap-0.5">
              <Text variant="body-2-semibold" numberOfLines={1}>
                {connection.displayName}
              </Text>
              <Text variant="body-2-regular" className="text-text-secondary" numberOfLines={1}>
                {[
                  connection.accountLabel ??
                    (connection.source === 'custom' ? connection.config.url : null),
                  t(`${K}.toolCount`, { count: connection.tools.length }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <Badge
              size="label-small"
              variant="subtle"
              color={STATUS_COLOR[connection.status]}
              content={t(`${K}.status.${connection.status}`)}
            />
          </View>
          {connection.status !== 'running' && connection.statusMessage ? (
            <Text variant="body-2-regular" className="text-text-secondary">
              {connection.statusMessage}
            </Text>
          ) : null}
          {connection.usedBy.length > 0 ? (
            <Text variant="body-2-regular" className="text-text-secondary">
              {t(`${K}.usedBy`, { names: connection.usedBy.map((gemie) => gemie.name).join(', ') })}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            {connection.status !== 'running' ? (
              <Button
                size="sm"
                appearance="solid"
                tone="accent"
                loading={pending === connection._id}
                onPress={() => void reconnect(connection)}
              >
                {t(`${K}.reconnect`)}
              </Button>
            ) : null}
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              disabled={pending === connection._id}
              onPress={() => setRenaming(connection)}
            >
              {t(`${K}.rename`)}
            </Button>
            {connection.status === 'running' ? (
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                disabled={pending === connection._id}
                onPress={() => void reconnect(connection)}
              >
                {t(`${K}.reconnect`)}
              </Button>
            ) : null}
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              disabled={pending === connection._id}
              onPress={() => void disconnect(connection)}
            >
              {t(`${K}.disconnect`)}
            </Button>
          </View>
        </View>
      ))}
      <RenameDialog
        connection={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (accountLabel) => {
          if (!renaming) return;
          await actions.rename.mutateAsync({ id: renaming._id, accountLabel });
        }}
        t={t}
      />
    </View>
  );
}

/** `Notion · ana@acme.com`: the connector, and which of the person's accounts. */
function label(connection: Connection): string {
  return connection.accountLabel
    ? `${connection.displayName} · ${connection.accountLabel}`
    : connection.displayName;
}

function RenameDialog({
  connection,
  onClose,
  onSave,
  t,
}: {
  connection: Connection | null;
  onClose: () => void;
  onSave: (accountLabel: string | null) => Promise<void>;
  t: Translate;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = value ?? connection?.accountLabel ?? '';

  const close = () => {
    setValue(null);
    onClose();
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(current.trim() || null);
      close();
    } catch {
      toast.error(t(`${K}.renameFailed`));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={connection !== null}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      maxWidth={384}
      title={t(`${K}.renameTitle`)}
      description={t(`${K}.renameDescription`, { name: connection?.displayName ?? '' })}
      actions={[
        { label: t(`${K}.cancel`), color: 'cancel', disabled: saving },
        {
          label: t(`${K}.renameSave`),
          onPress: save,
          disabled: saving,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View>
        <TextFieldLabel>{t(`${K}.renameLabel`)}</TextFieldLabel>
        <TextFieldInput
          label={t(`${K}.renameLabel`)}
          placeholder="ana@acme.com"
          value={current}
          onChangeText={setValue}
          autoCapitalize="none"
        />
      </View>
    </Dialog>
  );
}

/** The list's shape while it is read: rows, never a spinner. */
function ConnectedSkeleton() {
  return (
    <Skeleton.Region>
      <View className="gap-4 py-2.5">
        {[0, 1].map((index) => (
          <View key={index} className="flex-row items-center gap-3">
            <Skeleton.Box width={36} height={36} borderRadius={8} />
            <View className="flex-1 gap-1.5">
              <Skeleton.Box width={140} height={14} />
              <Skeleton.Box width={200} height={12} />
            </View>
          </View>
        ))}
      </View>
    </Skeleton.Region>
  );
}
