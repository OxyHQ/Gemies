import {
  GEMIE_ACCOUNT_STATUSES,
  useGemieAccountChats,
  useGemieAccountMutations,
  useGemieAccountQr,
  useGemieAccounts,
  type GemieAccount,
  type GemieAccountGroupReplies,
  type GemieAccountLink,
  type GemieAccountPlatform,
  type GemieAccountReplies,
} from '@/features/agents/runtime/use-gemie-accounts';
import { EditorSelect } from '@/features/agents/ui/edit/sections/editor-select';
import { errorMessage } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Button } from '@oxy.so/bloom/button';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

/** This section's own strings. */
const K = 'agents.editor.accounts';

/** Product names, the same in every language. */
const PLATFORM_LABELS: Record<GemieAccountPlatform, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
};

/** The account being linked: its QR code until the person scans it with the platform's app. */
function LinkingAccount({
  agentId,
  name,
  platform,
  link,
  onDone,
  onCancel,
}: {
  agentId: string;
  name: string;
  platform: GemieAccountPlatform;
  link: GemieAccountLink;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { data } = useGemieAccountQr(agentId, link);
  const status = data?.status ?? 'qr-pending';
  const label = PLATFORM_LABELS[platform];

  useEffect(() => {
    if (status === 'qr-pending') return;
    if (status === 'connected') toast.success(t(`${K}.linked`, { platform: label, name }));
    else toast.error(t(`${K}.linkExpired`, { platform: label }));
    onDone();
  }, [label, name, onDone, status, t]);

  return (
    <AgentCreatorField label={t(`${K}.scanTitle`, { platform: label })} multiline>
      <View className="items-start gap-3">
        <Text variant="body-2-regular" className="text-text-secondary">
          {t(`${K}.scan.${platform}`)}
        </Text>
        {data?.qr ? (
          // The code carries its own white quiet zone, so it scans on a dark theme too.
          <QRCode value={data.qr} size={200} quietZone={12} backgroundColor="white" color="black" />
        ) : (
          // The code's own shape while the provider makes it: the same square, the quiet zone in.
          <Skeleton.Region>
            <Skeleton.Box width={224} height={224} />
          </Skeleton.Region>
        )}
        <Button size="sm" appearance="outline" tone="neutral" onPress={onCancel}>
          {t('common.cancel')}
        </Button>
      </View>
    </AgentCreatorField>
  );
}

/** The chats a `chosen` account answers, picked from its recent ones. */
function ChosenChats({ agentId, account }: { agentId: string; account: GemieAccount }) {
  const { t } = useTranslation();
  const { data: chats, isPending } = useGemieAccountChats(agentId, account._id, true);
  const { setReplies } = useGemieAccountMutations(agentId);

  const toggle = async (chatId: string, on: boolean) => {
    const replyChatIds = on
      ? [...account.replyChatIds, chatId]
      : account.replyChatIds.filter((id) => id !== chatId);
    try {
      await setReplies.mutateAsync({ accountId: account._id, replyChatIds });
    } catch {
      toast.error(t('settings.saveFailed'));
    }
  };

  if (isPending) return <SettingsSkeletonRows control="switch" rows={3} />;
  if (!chats?.length) {
    return (
      <Text variant="body-2-regular" className="text-text-secondary">
        {t(`${K}.noChats`)}
      </Text>
    );
  }
  return (
    <View className="gap-1">
      {chats.map((chat) => (
        <View key={chat.chatId} className="flex-row items-center justify-between gap-3 py-1">
          <Text variant="body-2-regular" numberOfLines={1} className="flex-1">
            {chat.kind === 'group' ? t(`${K}.groupChat`, { name: chat.name }) : chat.name}
          </Text>
          <Switch
            accessibilityLabel={t(`${K}.answerChat`, { name: chat.name })}
            checked={account.replyChatIds.includes(chat.chatId)}
            disabled={setReplies.isPending}
            onCheckedChange={(on) => toggle(chat.chatId, on)}
          />
        </View>
      ))}
    </View>
  );
}

/** One linked account: its live status, who it answers, and removing it. */
function AccountRow({
  agentId,
  name,
  account,
}: {
  agentId: string;
  name: string;
  account: GemieAccount;
}) {
  const { t } = useTranslation();
  const { setReplies, remove } = useGemieAccountMutations(agentId);
  const platform = PLATFORM_LABELS[account.platform] ?? account.platform;
  const status = GEMIE_ACCOUNT_STATUSES.includes(account.status)
    ? t(`${K}.status.${account.status}`)
    : account.status;
  const identifier = account.phoneNumber || account.displayName;
  const live = account.status === 'connected' || account.status === 'disconnected';

  const save = async (patch: {
    replies?: GemieAccountReplies;
    groupReplies?: GemieAccountGroupReplies;
  }) => {
    try {
      await setReplies.mutateAsync({ accountId: account._id, ...patch });
    } catch {
      toast.error(t('settings.saveFailed'));
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: t(`${K}.removeTitle`, { platform }),
      description: t(`${K}.removeDescription`, { platform, name }),
      confirmLabel: t(`${K}.remove`),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(account._id);
      toast.success(t(`${K}.removed`, { platform }));
    } catch {
      toast.error(t(`${K}.removeFailed`));
    }
  };

  return (
    <AgentCreatorField label={platform} multiline>
      <View className="gap-3">
        <View className="flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-1 gap-0.5">
            <Text variant="body-2-regular">{[identifier, status].filter(Boolean).join(' · ')}</Text>
            <Text variant="body-2-regular" className="text-text-secondary">
              {account.lastActiveAt
                ? t(`${K}.lastMessage`, {
                    when: new Date(account.lastActiveAt).toLocaleString(),
                  })
                : t(`${K}.noMessagesYet`)}
            </Text>
          </View>
          <Button
            size="sm"
            appearance="outline"
            tone="danger"
            accessibilityLabel={t(`${K}.removeNamed`, { platform })}
            disabled={remove.isPending}
            onPress={handleRemove}
          >
            {t(`${K}.remove`)}
          </Button>
        </View>
        {live ? (
          <>
            <EditorSelect
              label={t(`${K}.repliesLabel`, { name })}
              value={account.replies}
              disabled={setReplies.isPending}
              items={[
                { value: 'everyone', label: t(`${K}.replies.everyone`) },
                { value: 'chosen', label: t(`${K}.replies.chosen`) },
                { value: 'nobody', label: t(`${K}.replies.nobody`, { name }) },
              ]}
              onChange={(value) => save({ replies: value as GemieAccountReplies })}
            />
            {account.replies === 'chosen' ? (
              <ChosenChats agentId={agentId} account={account} />
            ) : null}
            {account.replies !== 'nobody' ? (
              <EditorSelect
                label={t(`${K}.groupRepliesLabel`)}
                value={account.groupReplies}
                disabled={setReplies.isPending}
                items={[
                  { value: 'mentions', label: t(`${K}.groupReplies.mentions`) },
                  { value: 'never', label: t(`${K}.groupReplies.never`) },
                ]}
                onChange={(value) => save({ groupReplies: value as GemieAccountGroupReplies })}
              />
            ) : null}
          </>
        ) : null}
      </View>
    </AgentCreatorField>
  );
}

/**
 * The WhatsApp and Telegram accounts the person linked to this gemie (ADR 0035). The gemie answers
 * what arrives on them as the person chose, and only its own turns can read or send through them.
 */
export function AgentAccountsSection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useGemieAccounts(agentId);
  const { link, remove } = useGemieAccountMutations(agentId);
  const [linking, setLinking] = useState<{
    platform: GemieAccountPlatform;
    link: GemieAccountLink;
  } | null>(null);

  const linked = useCallback(() => setLinking(null), []);

  const handleLink = async (platform: GemieAccountPlatform) => {
    try {
      setLinking({ platform, link: await link.mutateAsync(platform) });
    } catch (error) {
      toast.error(
        t(`${K}.linkFailed`, {
          platform: PLATFORM_LABELS[platform],
          reason: errorMessage(error, t(`${K}.tryAgain`)),
        }),
      );
    }
  };

  const handleCancel = async () => {
    const pending = linking;
    setLinking(null);
    if (pending) await remove.mutateAsync(pending.link.accountId).catch(() => {});
  };

  // The account being linked shows as its QR code, not as a row beside it.
  const accounts = (data?.accounts ?? []).filter(
    (account) => account._id !== linking?.link.accountId,
  );
  const platforms = data?.platforms ?? [];

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      {isPending ? (
        <SettingsSkeletonRows control="value" rows={2} />
      ) : (
        <>
          <View className="py-2.5 pe-2.5">
            <Text variant="body-2-regular" className="text-text-secondary">
              {isError ? t(`${K}.loadFailed`) : t(`${K}.description`, { name })}
            </Text>
          </View>
          {accounts.map((account) => (
            <AccountRow key={account._id} agentId={agentId} name={name} account={account} />
          ))}
          {linking ? (
            <LinkingAccount
              agentId={agentId}
              name={name}
              platform={linking.platform}
              link={linking.link}
              onDone={linked}
              onCancel={handleCancel}
            />
          ) : isError ? null : platforms.length === 0 ? (
            <AgentCreatorField label={t(`${K}.link`)}>
              <Text variant="body-2-regular" className="text-text-secondary">
                {t(`${K}.unavailable`)}
              </Text>
            </AgentCreatorField>
          ) : (
            <AgentCreatorField label={t(`${K}.link`)}>
              <View className="flex-row gap-2">
                {platforms.map((platform) => (
                  <Button
                    key={platform}
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    accessibilityLabel={t(`${K}.linkNamed`, {
                      platform: PLATFORM_LABELS[platform],
                    })}
                    loading={link.isPending && link.variables === platform}
                    disabled={link.isPending}
                    onPress={() => handleLink(platform)}
                  >
                    {PLATFORM_LABELS[platform]}
                  </Button>
                ))}
              </View>
            </AgentCreatorField>
          )}
        </>
      )}
    </AgentCreatorSection>
  );
}
