import {
  type GemieTelegramBot,
  useGemieTelegramBot,
  useGemieTelegramBotMutations,
} from '@/features/agents/runtime/use-gemie-telegram-bot';
import { EditorSelect } from '@/features/agents/ui/edit/sections/editor-select';
import { errorMessage } from '@/shared/api/error-utils';
import { queryKeys } from '@/shared/api/query-keys';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { readAgentCharacter } from '@gemies/sdk';
import { Admonition } from '@oxy.so/bloom/admonition';
import { AgentAvatar, type AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiTelegramFill } from '@oxy.so/bloom/icons/RiTelegramFill';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Linking, View } from 'react-native';

/** This section's own strings. */
const K = 'agents.editor.telegramBot';

/** Telegram's own blue: its logo is the same in light and dark. */
const TELEGRAM_BLUE = '#26A5E4';

const BOTFATHER_URL = 'https://t.me/BotFather';

/** How the bot's delivery reads at a glance, and the badge colour it takes. */
const STATUS_COLOR = {
  ok: 'success',
  failing: 'error',
  missing: 'warning',
  unknown: 'default',
} as const;

type T = ReturnType<typeof useTranslation>['t'];
type Look = { character: AvatarCharacter; color: string | null };

/** One row of the card, with the hairline above it that every row but the first has. */
function Row({
  first,
  className = '',
  children,
}: {
  first?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <View className={`py-3 pe-3 ${first ? '' : 'border-t border-border'} ${className}`}>
      {children}
    </View>
  );
}

/**
 * A setting as the settings rows draw one: its name and what it means at the start, its control at
 * the end, and the control under them when the card is too narrow for both.
 */
function SettingRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Row className="min-h-[52px] flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <View className="min-w-[140px] flex-1 basis-0 gap-0.5">
        <Text variant="body-regular" className="text-text-primary">
          {title}
        </Text>
        {hint ? (
          <Text variant="body-2-regular" className="text-text-secondary">
            {hint}
          </Text>
        ) : null}
      </View>
      {children}
    </Row>
  );
}

/**
 * Telegram's logo. Its paper plane is cut out of the circle, so a white disc a little smaller than
 * the circle sits under it, and the plane reads white on any surface.
 */
function TelegramLogo({ size }: { size: 20 | 40 }) {
  return (
    <View className={`items-center justify-center ${size === 40 ? 'h-10 w-10' : 'h-5 w-5'}`}>
      <View className={`absolute rounded-full bg-white ${size === 40 ? 'h-8 w-8' : 'h-4 w-4'}`} />
      {/* A view of its own, so the glyph stacks above the disc on the web as well. */}
      <View>
        <RiTelegramFill width={size} height={size} fill={TELEGRAM_BLUE} />
      </View>
    </View>
  );
}

/** What the bot is, beside the logo, before there is one. */
function Intro({ name, t }: { name: string; t: T }) {
  return (
    <Row first className="flex-row items-start gap-3">
      <TelegramLogo size={40} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="body-semibold" className="text-text-primary">
          {t(`${K}.intro`, { name })}
        </Text>
        <Text variant="body-2-regular" className="text-text-secondary">
          {t(`${K}.description`, { name })}
        </Text>
      </View>
    </Row>
  );
}

/** One numbered step of making a bot. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <View className="flex-row items-start gap-3">
      <View className="h-6 w-6 items-center justify-center rounded-full bg-background-tertiary-default">
        <Text variant="caption-1-semibold" className="text-text-primary">
          {n}
        </Text>
      </View>
      <View className="min-w-0 flex-1 gap-2 pt-0.5">{children}</View>
    </View>
  );
}

/** Pasting a @BotFather token: the gemie gets its own bot. */
function ConnectBot({ gemieId, name }: { gemieId: string; name: string }) {
  const { t } = useTranslation();
  const { connect } = useGemieTelegramBotMutations(gemieId);
  const [token, setToken] = useState('');
  const [ownerPays, setOwnerPays] = useState(true);

  const submit = async () => {
    try {
      await connect.mutateAsync({ token: token.trim(), ownerPaysAgentTurns: ownerPays });
      setToken('');
      toast.success(t(`${K}.connected`, { name }));
    } catch (error) {
      toast.error(t(`${K}.connectFailed`, { reason: errorMessage(error, t(`${K}.tryAgain`)) }));
    }
  };

  return (
    <>
      <Row className="gap-3">
        <Step n={1}>
          <Text variant="body-2-regular" className="text-text-primary">
            {t(`${K}.step1`)}
          </Text>
          <View className="flex-row">
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              trailingIcon={RiExternalLinkLine}
              onPress={() => void Linking.openURL(BOTFATHER_URL)}
            >
              {t(`${K}.openBotFather`)}
            </Button>
          </View>
        </Step>
        <Step n={2}>
          <Text variant="body-2-regular" className="text-text-primary">
            {t(`${K}.step2`)}
          </Text>
        </Step>
        <Step n={3}>
          <Text variant="body-2-regular" className="text-text-primary">
            {t(`${K}.step3`, { name })}
          </Text>
        </Step>
      </Row>
      <AgentCreatorField label={t(`${K}.token`)}>
        <TextFieldInput
          label={t(`${K}.tokenInput`)}
          size="sm"
          placeholder={t(`${K}.tokenPlaceholder`)}
          value={token}
          onChangeText={setToken}
          secureTextEntry
          revealable
          autoCapitalize="none"
          autoCorrect={false}
        />
      </AgentCreatorField>
      <SettingRow title={t(`${K}.paysTitle`)} hint={t(`${K}.paysHint`, { name })}>
        <Switch
          accessibilityLabel={t(`${K}.pays`, { name })}
          checked={ownerPays}
          onCheckedChange={setOwnerPays}
        />
      </SettingRow>
      <Row>
        <Button
          className="w-full"
          loading={connect.isPending}
          disabled={connect.isPending || token.trim().length < 10}
          onPress={submit}
        >
          {t(`${K}.connect`)}
        </Button>
      </Row>
    </>
  );
}

/** The bot as Telegram shows it: the gemie's picture, its @username and whether it is live. */
function BotCard({
  bot,
  name,
  username,
  look,
  t,
}: {
  bot: GemieTelegramBot;
  name: string;
  username: string | null;
  look: Look;
  t: T;
}) {
  const state = !bot.live ? 'unknown' : bot.live.webhook;
  return (
    <Row first className="gap-3">
      <View className="flex-row items-center gap-3">
        <View>
          <AgentAvatar character={readAgentCharacter(look.character, look.color)} size={48} />
          <View className="absolute -bottom-1 -end-1 rounded-full bg-background-secondary-default p-px">
            <TelegramLogo size={20} />
          </View>
        </View>
        <View className="min-w-0 flex-1">
          <Text variant="body-semibold" className="text-text-primary" numberOfLines={1}>
            {username ? `@${username}` : bot.name}
          </Text>
          <Text variant="body-2-regular" className="text-text-secondary" numberOfLines={1}>
            {t(`${K}.answered`, { count: bot.totalMessages, name })}
          </Text>
        </View>
        <View>
          <Badge
            size="label-small"
            variant="subtle"
            color={STATUS_COLOR[state]}
            content={t(`${K}.status.${state}`)}
          />
        </View>
      </View>
      {state === 'ok' ? null : (
        <Admonition type={state === 'failing' ? 'error' : 'info'} size="sm">
          {[t(`${K}.state.${state}`), bot.live?.webhookError].filter(Boolean).join('\n')}
        </Admonition>
      )}
    </Row>
  );
}

/** The bot the gemie has: how Telegram sees it, its settings, and removing it. */
function ConnectedBot({
  gemieId,
  name,
  bot,
  look,
}: {
  gemieId: string;
  name: string;
  bot: GemieTelegramBot;
  look: Look;
}) {
  const { t } = useTranslation();
  const { update, remove, link, unlink } = useGemieTelegramBotMutations(gemieId);
  const queryClient = useQueryClient();
  const username = bot.live?.username ?? bot.username;

  const handleLink = async () => {
    try {
      const { url } = await link.mutateAsync();
      await Linking.openURL(url);
      toast.success(t(`${K}.linkOpened`, { name }));
    } catch (error) {
      toast.error(t(`${K}.linkFailed`, { reason: errorMessage(error, t(`${K}.tryAgain`)) }));
    }
  };

  const handleUnlink = async () => {
    try {
      await unlink.mutateAsync();
      toast.success(t(`${K}.unlinked`, { name }));
    } catch (error) {
      toast.error(t(`${K}.linkFailed`, { reason: errorMessage(error, t(`${K}.tryAgain`)) }));
    }
  };

  const save = async (patch: Parameters<typeof update.mutateAsync>[0]) => {
    try {
      await update.mutateAsync(patch);
    } catch (error) {
      toast.error(t(`${K}.saveFailed`, { reason: errorMessage(error, t(`${K}.tryAgain`)) }));
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: t(`${K}.removeTitle`),
      description: t(`${K}.removeDescription`, { name, username: username ?? '' }),
      confirmLabel: t(`${K}.remove`),
      cancelLabel: t(`${K}.cancel`),
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync();
      toast.success(t(`${K}.removed`));
    } catch {
      toast.error(t(`${K}.removeFailed`));
    }
  };

  return (
    <>
      <BotCard bot={bot} name={name} username={username} look={look} t={t} />
      {/* The bot follows the gemie by itself; only a failure is said, with the one manual control. */}
      {bot.profileSyncError ? (
        <Row className="gap-2">
          <Admonition type="error" size="sm">
            {[t(`${K}.syncFailed`, { name }), bot.profileSyncError].join('\n')}
          </Admonition>
          <View className="flex-row">
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              leadingIcon={RiRefreshLine}
              loading={update.isPending && update.variables?.retryProfileSync === true}
              disabled={update.isPending}
              onPress={() => save({ retryProfileSync: true })}
            >
              {t(`${K}.retrySync`)}
            </Button>
          </View>
        </Row>
      ) : null}
      <Row className="flex-row flex-wrap gap-2">
        {username ? (
          <>
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              leadingIcon={RiExternalLinkLine}
              onPress={() => void Linking.openURL(`https://t.me/${username}`)}
            >
              {t(`${K}.open`)}
            </Button>
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              leadingIcon={RiGroupLine}
              onPress={() => void Linking.openURL(`https://t.me/${username}?startgroup=gemie`)}
            >
              {t(`${K}.addToGroup`)}
            </Button>
          </>
        ) : null}
      </Row>
      <AgentCreatorField label={t(`${K}.groups`)}>
        <EditorSelect
          label={t(`${K}.groupsLabel`, { name })}
          value={bot.groupReplies}
          disabled={update.isPending}
          items={[
            { value: 'mentions', label: t(`${K}.groupReplies.mentions`) },
            { value: 'never', label: t(`${K}.groupReplies.never`) },
          ]}
          onChange={(groupReplies) =>
            save({ groupReplies: groupReplies as GemieTelegramBot['groupReplies'] })
          }
        />
      </AgentCreatorField>
      {bot.groupReplies === 'mentions' && bot.live && !bot.live.canReadAllGroupMessages ? (
        <View className="pe-3 pb-3">
          <Admonition type="info" size="sm">
            {t(`${K}.privacy`, { username: username ?? '' })}
          </Admonition>
        </View>
      ) : null}
      {bot.callerPays ? (
        <SettingRow
          title={t(`${K}.personTitle`)}
          hint={t(bot.personLinked ? `${K}.personHintLinked` : `${K}.personHint`, { name })}
        >
          {bot.personLinked ? (
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              loading={unlink.isPending}
              disabled={unlink.isPending}
              onPress={handleUnlink}
            >
              {t(`${K}.unlinkMine`)}
            </Button>
          ) : (
            <Button
              size="sm"
              leadingIcon={RiExternalLinkLine}
              loading={link.isPending}
              disabled={link.isPending}
              onPress={async () => {
                await handleLink();
                // Linking finishes in Telegram: read the bot again when the person comes back.
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.agents.telegramBot(gemieId),
                });
              }}
            >
              {t(`${K}.linkMine`)}
            </Button>
          )}
        </SettingRow>
      ) : null}
      {bot.callerPays ? (
        <SettingRow title={t(`${K}.paysTitle`)} hint={t(`${K}.paysHint`, { name })}>
          <Switch
            accessibilityLabel={t(`${K}.pays`, { name })}
            checked={bot.ownerPaysAgentTurns}
            disabled={update.isPending}
            onCheckedChange={(ownerPaysAgentTurns) => save({ ownerPaysAgentTurns })}
          />
        </SettingRow>
      ) : null}
      <SettingRow title={t(`${K}.removeRow`)} hint={t(`${K}.removeHint`, { name })}>
        <Button
          size="sm"
          appearance="outline"
          tone="danger"
          disabled={remove.isPending}
          onPress={handleRemove}
        >
          {t(`${K}.remove`)}
        </Button>
      </SettingRow>
    </>
  );
}

/**
 * The gemie's own Telegram bot (ADR 0037), a card of the editor apart from its connected
 * accounts: those are a person's own accounts; this is the gemie's.
 */
export function AgentTelegramBotSection({
  agentId,
  name,
  look,
}: {
  agentId: string;
  name: string;
  /** The gemie's character and colour, drawn beside the bot as the bot shows it. */
  look: Look;
}) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useGemieTelegramBot(agentId);
  const bot = !isPending && !isError && data?.available ? data.bot : null;

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      {bot ? (
        <ConnectedBot gemieId={agentId} name={name} bot={bot} look={look} />
      ) : (
        <>
          <Intro name={name} t={t} />
          {isPending ? (
            <View className="border-t border-border">
              <SettingsSkeletonRows control="none" rows={2} />
            </View>
          ) : isError || !data ? (
            <Row>
              <Text variant="body-2-regular" className="text-text-secondary">
                {t(`${K}.loadFailed`)}
              </Text>
            </Row>
          ) : !data.available ? (
            <Row>
              <Text variant="body-2-regular" className="text-text-secondary">
                {t(`${K}.unavailable`)}
              </Text>
            </Row>
          ) : (
            <ConnectBot gemieId={agentId} name={name} />
          )}
        </>
      )}
    </AgentCreatorSection>
  );
}
