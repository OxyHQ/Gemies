import { Button } from '@oxy.so/bloom/button';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { englishCopy, type Translate } from '../lib/copy';
import { errorMessage } from '../runtime/error-utils';
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
} from '../runtime/gemie-accounts';

/** This component's own strings. */
const K = 'gemie.accounts';

/** Product names, the same in every language. */
const PLATFORM_LABELS: Record<GemieAccountPlatform, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
};

/** One row of the list: the same rhythm as a settings row, a divider above all but the first. */
function Row({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <View className={`gap-3 py-2.5 pe-2.5 ${first ? '' : 'border-t border-border'}`}>
      {children}
    </View>
  );
}

function Choice<T extends string>({
  label,
  value,
  items,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  items: readonly { value: T; label: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <View className="gap-1">
      <Text variant="body-2-regular" className="text-text-secondary">
        {label}
      </Text>
      <Select
        size="sm"
        value={value}
        onValueChange={(next) => onChange(next as T)}
        disabled={disabled}
      >
        <SelectTrigger label={label}>
          <SelectValue placeholder={label} />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={items.map((item) => ({ ...item, id: item.value }))}
          width={280}
          valueExtractor={(item) => item.id}
          renderItem={(item) => (
            <SelectItem value={item.id} label={item.label}>
              <SelectItemText>{item.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
    </View>
  );
}

/** The account being linked: its QR code until the person scans it with the platform's app. */
function LinkingAccount({
  gemieId,
  name,
  platform,
  link,
  t,
  onDone,
  onCancel,
}: {
  gemieId: string;
  name: string;
  platform: GemieAccountPlatform;
  link: GemieAccountLink;
  t: Translate;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { data } = useGemieAccountQr(gemieId, link);
  const status = data?.status ?? 'qr-pending';
  const label = PLATFORM_LABELS[platform];

  useEffect(() => {
    if (status === 'qr-pending') return;
    if (status === 'connected') toast.success(t(`${K}.linked`, { platform: label, name }));
    else toast.error(t(`${K}.linkExpired`, { platform: label }));
    onDone();
  }, [label, name, onDone, status, t]);

  return (
    <Row>
      <Text variant="body-2-semibold">{t(`${K}.scanTitle`, { platform: label })}</Text>
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
      <View className="flex-row">
        <Button size="sm" appearance="outline" tone="neutral" onPress={onCancel}>
          {t(`${K}.cancel`)}
        </Button>
      </View>
    </Row>
  );
}

/** The chats a `chosen` account answers, picked from its recent ones. */
function ChosenChats({
  gemieId,
  account,
  t,
}: {
  gemieId: string;
  account: GemieAccount;
  t: Translate;
}) {
  const { data: chats, isPending } = useGemieAccountChats(gemieId, account._id);
  const { setReplies } = useGemieAccountMutations(gemieId);

  const toggle = async (chatId: string, on: boolean) => {
    const replyChatIds = on
      ? [...account.replyChatIds, chatId]
      : account.replyChatIds.filter((id) => id !== chatId);
    try {
      await setReplies.mutateAsync({ accountId: account._id, replyChatIds });
    } catch {
      toast.error(t(`${K}.saveFailed`));
    }
  };

  if (isPending) {
    return (
      <Skeleton.Region>
        <View className="gap-2">
          {[0, 1, 2].map((row) => (
            <Skeleton.Box key={row} width={180} height={14} />
          ))}
        </View>
      </Skeleton.Region>
    );
  }
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
  gemieId,
  name,
  account,
  first,
  t,
}: {
  gemieId: string;
  name: string;
  account: GemieAccount;
  first: boolean;
  t: Translate;
}) {
  const { setReplies, remove } = useGemieAccountMutations(gemieId);
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
      toast.error(t(`${K}.saveFailed`));
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: t(`${K}.removeTitle`, { platform }),
      description: t(`${K}.removeDescription`, { platform, name }),
      confirmLabel: t(`${K}.remove`),
      cancelLabel: t(`${K}.cancel`),
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
    <Row first={first}>
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text variant="body-2-semibold">{platform}</Text>
          <Text variant="body-2-regular">{[identifier, status].filter(Boolean).join(' · ')}</Text>
          <Text variant="body-2-regular" className="text-text-secondary">
            {account.lastActiveAt
              ? t(`${K}.lastMessage`, { when: new Date(account.lastActiveAt).toLocaleString() })
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
          <Choice
            label={t(`${K}.repliesLabel`, { name })}
            value={account.replies}
            disabled={setReplies.isPending}
            items={[
              { value: 'everyone', label: t(`${K}.replies.everyone`) },
              { value: 'chosen', label: t(`${K}.replies.chosen`) },
              { value: 'nobody', label: t(`${K}.replies.nobody`, { name }) },
            ]}
            onChange={(replies) => save({ replies })}
          />
          {account.replies === 'chosen' ? (
            <ChosenChats gemieId={gemieId} account={account} t={t} />
          ) : null}
          {account.replies !== 'nobody' ? (
            <Choice
              label={t(`${K}.groupRepliesLabel`)}
              value={account.groupReplies}
              disabled={setReplies.isPending}
              items={[
                { value: 'mentions', label: t(`${K}.groupReplies.mentions`) },
                { value: 'never', label: t(`${K}.groupReplies.never`) },
              ]}
              onChange={(groupReplies) => save({ groupReplies })}
            />
          ) : null}
        </>
      ) : null}
    </Row>
  );
}

export interface GemieAccountsProps {
  /** The gemie the accounts are linked to (Alia's id, in the Alia app). */
  gemieId: string;
  /** The gemie's name, as the copy says it. */
  name: string;
  /** The host's translator, keyed as `gemie.accounts.*`; English when absent. */
  t?: Translate;
}

/**
 * The WhatsApp and Telegram accounts the person linked to a gemie (ADR 0035), drawn without a
 * frame of its own so each app puts it in its own: the Gemies app in a gemie's editor card, the
 * Alia app in its settings. The gemie answers what arrives on them as the person chooses, and only
 * its own turns can read or send through them. Only what this deployment can link is offered.
 */
export function GemieAccounts({ gemieId, name, t = englishCopy }: GemieAccountsProps) {
  const { data, isPending, isError } = useGemieAccounts(gemieId);
  const { link, remove } = useGemieAccountMutations(gemieId);
  const [linking, setLinking] = useState<{
    platform: GemieAccountPlatform;
    link: GemieAccountLink;
  } | null>(null);
  const linked = useCallback(() => setLinking(null), []);

  if (isPending) {
    return (
      <Skeleton.Region>
        <View className="gap-3 py-2.5">
          <Skeleton.Box width={260} height={14} />
          <Skeleton.Box width={160} height={14} />
        </View>
      </Skeleton.Region>
    );
  }

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
    <View>
      <Row first>
        <Text variant="body-2-regular" className="text-text-secondary">
          {isError ? t(`${K}.loadFailed`) : t(`${K}.description`, { name })}
        </Text>
      </Row>
      {accounts.map((account) => (
        <AccountRow
          key={account._id}
          gemieId={gemieId}
          name={name}
          account={account}
          first={false}
          t={t}
        />
      ))}
      {linking ? (
        <LinkingAccount
          gemieId={gemieId}
          name={name}
          platform={linking.platform}
          link={linking.link}
          t={t}
          onDone={linked}
          onCancel={handleCancel}
        />
      ) : isError ? null : (
        <Row>
          <Text variant="body-2-semibold">{t(`${K}.link`)}</Text>
          {platforms.length === 0 ? (
            <Text variant="body-2-regular" className="text-text-secondary">
              {t(`${K}.unavailable`)}
            </Text>
          ) : (
            <View className="flex-row gap-2">
              {platforms.map((platform) => (
                <Button
                  key={platform}
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  accessibilityLabel={t(`${K}.linkNamed`, { platform: PLATFORM_LABELS[platform] })}
                  loading={link.isPending && link.variables === platform}
                  disabled={link.isPending}
                  onPress={() => handleLink(platform)}
                >
                  {PLATFORM_LABELS[platform]}
                </Button>
              ))}
            </View>
          )}
        </Row>
      )}
    </View>
  );
}
