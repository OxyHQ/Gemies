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
import { Linking, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { englishCopy, type Translate } from '../../lib/copy';
import { errorMessage } from '../../runtime/error-utils';
import {
  useConnectedAccountChats,
  useConnectedAccountMutations,
  useConnectedAccountQr,
  useConnectedAccounts,
  type ConnectedAccount,
  type ConnectedAccountPatch,
  type GemieAccountLink,
  type GemieAccountPlatform,
  type GrantableGemie,
} from '../../runtime/connected-accounts';
import { GrantSwitchRow } from '../connectors/GrantSwitchRow';
import { K, PLATFORM_LABELS, PlatformMark, accountName, statusText } from './account-parts';

/** The value the answering select gives "nobody answers on its own". */
const NOBODY = '';

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

/** A code to scan, drawn with its own white quiet zone so it scans on a dark theme too. */
function Code({ value }: { value: string | null | undefined }) {
  return value ? (
    <QRCode value={value} size={200} quietZone={12} backgroundColor="white" color="black" />
  ) : (
    // The code's own shape while the provider makes it: the same square, the quiet zone in.
    <Skeleton.Region>
      <Skeleton.Box width={224} height={224} />
    </Skeleton.Region>
  );
}

/**
 * Telegram's two steps (ADR 0037): open the shared Gemies bot from this link, so Telegram says who
 * the person is, and add it in Telegram › Settings › Telegram Business › Chatbots. The link opens
 * Telegram here, and its code opens it on a phone. Once Telegram knows who the person is, only the
 * second step is left.
 */
function TelegramSteps({ link, t }: { link: string | null; t: Translate }) {
  return (
    <View className="gap-2">
      <Text variant="body-2-regular" className="text-text-secondary">
        {t(`${K}.telegram.note`)}
      </Text>
      {link ? (
        <>
          <Text variant="body-2-regular">{t(`${K}.telegram.step1`)}</Text>
          <Text variant="body-2-regular">{t(`${K}.telegram.step2`)}</Text>
          <View className="flex-row">
            <Button size="sm" onPress={() => void Linking.openURL(link)}>
              {t(`${K}.telegram.open`)}
            </Button>
          </View>
          <Code value={link} />
        </>
      ) : (
        <Text variant="body-2-regular">{t(`${K}.telegram.waitingBusiness`)}</Text>
      )}
    </View>
  );
}

/**
 * The account being connected, until the person finishes on their phone: WhatsApp's code to scan,
 * or Telegram's steps.
 */
function ConnectingAccount({
  platform,
  link,
  t,
  onDone,
  onCancel,
}: {
  platform: GemieAccountPlatform;
  link: GemieAccountLink;
  t: Translate;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { data } = useConnectedAccountQr(link);
  const status = data?.status ?? 'qr-pending';
  const label = PLATFORM_LABELS[platform];

  useEffect(() => {
    if (status === 'qr-pending') return;
    // Telegram reports a connection its person turned off as paused: connected all the same.
    if (status === 'connected' || status === 'paused') {
      toast.success(t(`${K}.connected`, { platform: label }));
    } else toast.error(t(`${K}.linkExpired`, { platform: label }));
    onDone();
  }, [label, onDone, status, t]);

  return (
    <Row>
      {platform === 'telegram' ? (
        <>
          <Text variant="body-2-semibold">{t(`${K}.telegram.linkTitle`)}</Text>
          <TelegramSteps link={data?.qr ?? null} t={t} />
        </>
      ) : (
        <>
          <Text variant="body-2-semibold">{t(`${K}.scanTitle`, { platform: label })}</Text>
          <Text variant="body-2-regular" className="text-text-secondary">
            {t(`${K}.scan.${platform}`)}
          </Text>
          <Code value={data?.qr} />
        </>
      )}
      <View className="flex-row">
        <Button size="sm" appearance="outline" tone="neutral" onPress={onCancel}>
          {t(`${K}.cancel`)}
        </Button>
      </View>
    </Row>
  );
}

/** A Telegram account the person left before finishing: its steps, kept until it is connected. */
function PendingTelegram({ account, t }: { account: ConnectedAccount; t: Translate }) {
  const { data } = useConnectedAccountQr({ accountId: account._id, qr: null });
  return <TelegramSteps link={data?.qr ?? null} t={t} />;
}

/** The chats a `chosen` account answers, picked from its recent ones. */
function ChosenChats({
  account,
  save,
  saving,
  t,
}: {
  account: ConnectedAccount;
  save: (patch: ConnectedAccountPatch) => Promise<void>;
  saving: boolean;
  t: Translate;
}) {
  const { data: chats, isPending } = useConnectedAccountChats(account._id);

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
            disabled={saving}
            onCheckedChange={(on) =>
              save({
                replyChatIds: on
                  ? [...account.replyChatIds, chat.chatId]
                  : account.replyChatIds.filter((id) => id !== chat.chatId),
              })
            }
          />
        </View>
      ))}
    </View>
  );
}

/**
 * Who answers the account on its own — one of the person's gemies, or nobody — and, when one
 * does, whom it answers. Choosing a gemie grants it the account too.
 */
function Answering({
  account,
  gemies,
  save,
  saving,
  t,
}: {
  account: ConnectedAccount;
  gemies: readonly GrantableGemie[];
  save: (patch: ConnectedAccountPatch) => Promise<void>;
  saving: boolean;
  t: Translate;
}) {
  const answering = gemies.find((gemie) => gemie.id === account.answeringGemieId) ?? null;
  const telegram = account.platform === 'telegram';
  return (
    <View className="gap-3">
      <Choice
        label={t(`${K}.answeringLabel`)}
        value={answering?.id ?? NOBODY}
        disabled={saving}
        items={[
          { value: NOBODY, label: t(`${K}.answeringNobody`) },
          ...gemies.map((gemie) => ({ value: gemie.id, label: gemie.name })),
        ]}
        onChange={(id) => save({ answeringGemieId: id === NOBODY ? null : id })}
      />
      {answering === null ? (
        <Text variant="body-2-regular" className="text-text-secondary">
          {t(`${K}.answeringNone`)}
        </Text>
      ) : (
        <>
          {telegram && account.status === 'connected' && account.canReply === false ? (
            <Text variant="body-2-regular" className="text-text-secondary">
              {t(`${K}.telegram.cannotReply`, { name: answering.name })}
            </Text>
          ) : null}
          <Choice
            label={t(`${K}.repliesLabel`, { name: answering.name })}
            value={account.replies}
            disabled={saving}
            items={[
              { value: 'everyone', label: t(`${K}.replies.everyone`) },
              { value: 'chosen', label: t(`${K}.replies.chosen`) },
              { value: 'nobody', label: t(`${K}.replies.nobody`, { name: answering.name }) },
            ]}
            onChange={(replies) => save({ replies })}
          />
          {account.replies === 'chosen' ? (
            <ChosenChats account={account} save={save} saving={saving} t={t} />
          ) : null}
          {/* Telegram Business covers private chats only: it has no groups to choose for. */}
          {account.replies !== 'nobody' && !telegram ? (
            <Choice
              label={t(`${K}.groupRepliesLabel`)}
              value={account.groupReplies}
              disabled={saving}
              items={[
                { value: 'mentions', label: t(`${K}.groupReplies.mentions`) },
                { value: 'never', label: t(`${K}.groupReplies.never`) },
              ]}
              onChange={(groupReplies) => save({ groupReplies })}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

/** One connected account: its live status, the gemies that may use it, who answers it, removing it. */
function AccountRow({
  account,
  gemies,
  t,
}: {
  account: ConnectedAccount;
  gemies: readonly GrantableGemie[];
  t: Translate;
}) {
  const { update, grant, remove } = useConnectedAccountMutations();
  const platform = PLATFORM_LABELS[account.platform] ?? account.platform;
  const name = accountName(account);
  const telegram = account.platform === 'telegram';
  const live =
    account.status === 'connected' ||
    account.status === 'disconnected' ||
    account.status === 'paused';

  const save = useCallback(
    async (patch: ConnectedAccountPatch) => {
      try {
        await update.mutateAsync({ accountId: account._id, ...patch });
      } catch {
        toast.error(t(`${K}.saveFailed`));
      }
    },
    [account._id, t, update],
  );

  const setGranted = async (gemieId: string, granted: boolean) => {
    try {
      await grant.mutateAsync({ accountId: account._id, gemieId, granted });
    } catch {
      toast.error(t(`${K}.saveFailed`));
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: t(`${K}.removeTitle`, { platform }),
      description: telegram
        ? t(`${K}.telegram.removeDescription`)
        : t(`${K}.removeDescription`, { platform }),
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
    <Row>
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <PlatformMark platform={account.platform} size={28} />
        <View className="flex-1 gap-0.5">
          <Text variant="body-2-semibold">{name}</Text>
          <Text variant="body-2-regular">{statusText(account, t)}</Text>
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
      {telegram && account.status === 'qr-pending' ? (
        <PendingTelegram account={account} t={t} />
      ) : null}
      {live ? (
        <>
          <View>
            <Text variant="body-2-semibold">{t(`${K}.usedBy`)}</Text>
            <Text variant="body-2-regular" className="text-text-secondary">
              {t(`${K}.usedByHint`)}
            </Text>
            {gemies.map((gemie, index) => (
              <GrantSwitchRow
                key={gemie.id}
                first={index === 0}
                label={gemie.name}
                detail={account.answeringGemieId === gemie.id ? t(`${K}.answersOnItsOwn`) : null}
                checked={account.gemieIds.includes(gemie.id)}
                disabled={grant.isPending || update.isPending}
                accessibilityLabel={t(`${K}.grantLabel`, { gemie: gemie.name, account: name })}
                onCheckedChange={(granted) => void setGranted(gemie.id, granted)}
              />
            ))}
          </View>
          <Answering
            account={account}
            gemies={gemies}
            save={save}
            saving={update.isPending || grant.isPending}
            t={t}
          />
        </>
      ) : null}
    </Row>
  );
}

export interface GemieConnectedAccountsProps {
  /** The host's translator, keyed as `gemie.accounts.*`; English when absent. */
  t?: Translate;
}

/**
 * Settings › Connected accounts (ADR 0035 as amended; Telegram through Telegram Business, ADR 0037):
 * the person connects their WhatsApp and Telegram accounts ONCE, here, chooses which of their gemies
 * may use each (Alia among them), and which one, if any, answers what arrives on it on its own. The
 * other granted gemies read and send through it only when the person asks them or their tasks need
 * it. Drawn without a frame of its own, so each app puts it in its own settings: the Gemies and the
 * Alia apps draw this same panel. Only what this deployment can connect is offered.
 */
export function GemieConnectedAccounts({ t = englishCopy }: GemieConnectedAccountsProps) {
  const { data, isPending, isError, isFetching, refetch } = useConnectedAccounts();
  const { connect, remove } = useConnectedAccountMutations();
  const [connecting, setConnecting] = useState<{
    platform: GemieAccountPlatform;
    link: GemieAccountLink;
  } | null>(null);
  /** The last connection that failed, said in the panel with a way to try again. */
  const [connectFailure, setConnectFailure] = useState<{
    platform: GemieAccountPlatform;
    reason: string;
  } | null>(null);
  const finished = useCallback(() => setConnecting(null), []);

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

  const handleConnect = async (platform: GemieAccountPlatform) => {
    setConnectFailure(null);
    try {
      setConnecting({ platform, link: await connect.mutateAsync(platform) });
    } catch (error) {
      setConnectFailure({ platform, reason: errorMessage(error, t(`${K}.tryAgain`)) });
    }
  };

  const handleCancel = async () => {
    const pending = connecting;
    setConnecting(null);
    if (pending) await remove.mutateAsync(pending.link.accountId).catch(() => {});
  };

  /**
   * Nothing could be read: the API did not answer (offline, or mid-rollout before it serves these
   * routes). Said so, with a retry, and nothing else is offered until it answers. A later refresh
   * that fails keeps what was already read.
   */
  if (isError && data === undefined) {
    return (
      <View>
        <Row first>
          <Text variant="body-2-regular" className="text-text-secondary">
            {t(`${K}.loadFailed`)}
          </Text>
          <View className="flex-row">
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              loading={isFetching}
              onPress={() => void refetch()}
            >
              {t(`${K}.retry`)}
            </Button>
          </View>
        </Row>
      </View>
    );
  }

  // The account being connected shows as its QR code, not as a row beside it.
  const accounts = (data?.accounts ?? []).filter(
    (account) => account._id !== connecting?.link.accountId,
  );
  const platforms = data?.platforms ?? [];
  const gemies = data?.gemies ?? [];

  return (
    <View>
      <Row first>
        <Text variant="body-2-regular" className="text-text-secondary">
          {t(`${K}.description`)}
        </Text>
      </Row>
      {accounts.map((account) => (
        <AccountRow key={account._id} account={account} gemies={gemies} t={t} />
      ))}
      {connecting ? (
        <ConnectingAccount
          platform={connecting.platform}
          link={connecting.link}
          t={t}
          onDone={finished}
          onCancel={handleCancel}
        />
      ) : (
        <Row>
          <Text variant="body-2-semibold">{t(`${K}.connect`)}</Text>
          {platforms.length === 0 ? (
            <Text variant="body-2-regular" className="text-text-secondary">
              {t(`${K}.unavailable`)}
            </Text>
          ) : null}
          {platforms.includes('telegram') ? (
            <Text variant="body-2-regular" className="text-text-secondary">
              {t(`${K}.telegram.note`)}
            </Text>
          ) : null}
          {platforms.length === 0 ? null : (
            <View className="flex-row flex-wrap gap-2">
              {platforms.map((platform) => (
                <Button
                  key={platform}
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  accessibilityLabel={t(`${K}.connectNamed`, {
                    platform: PLATFORM_LABELS[platform],
                  })}
                  loading={connect.isPending && connect.variables === platform}
                  disabled={connect.isPending}
                  onPress={() => handleConnect(platform)}
                >
                  {PLATFORM_LABELS[platform]}
                </Button>
              ))}
            </View>
          )}
          {connectFailure ? (
            <View className="gap-2">
              <Text
                variant="body-2-regular"
                className="text-error-primary"
                accessibilityRole="alert"
              >
                {t(`${K}.connectFailed`, {
                  platform: PLATFORM_LABELS[connectFailure.platform],
                  reason: connectFailure.reason,
                })}
              </Text>
              <View className="flex-row">
                <Button
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  disabled={connect.isPending}
                  onPress={() => handleConnect(connectFailure.platform)}
                >
                  {t(`${K}.retry`)}
                </Button>
              </View>
            </View>
          ) : null}
        </Row>
      )}
    </View>
  );
}
