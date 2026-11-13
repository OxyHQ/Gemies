import {
  type GemieTelegramBot,
  type TelegramBotProfileResult,
  useGemieTelegramBot,
  useGemieTelegramBotMutations,
} from '@/features/agents/runtime/use-gemie-telegram-bot';
import { EditorSelect } from '@/features/agents/ui/edit/sections/editor-select';
import { useGemieAvatarPhoto } from '@/features/agents/ui/edit/sections/gemie-avatar-photo';
import { errorMessage } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Button } from '@oxy.so/bloom/button';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { Linking, View } from 'react-native';

/** This section's own strings. */
const K = 'agents.editor.telegramBot';

type T = ReturnType<typeof useTranslation>['t'];

/** Say which parts of the gemie's profile Telegram did not take, when any. */
function reportProfile(profile: TelegramBotProfileResult | undefined, t: T) {
  if (!profile) return;
  const missed = (['name', 'description', 'photo'] as const).filter((part) => !profile[part]);
  if (missed.length > 0) {
    toast.error(
      t(`${K}.profilePartial`, { parts: missed.map((part) => t(`${K}.part.${part}`)).join(', ') }),
    );
  }
}

/** Pasting a @BotFather token: the gemie gets its own bot. */
function ConnectBot({
  gemieId,
  name,
  capturePhoto,
}: {
  gemieId: string;
  name: string;
  capturePhoto: () => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const { connect } = useGemieTelegramBotMutations(gemieId);
  const [token, setToken] = useState('');
  const [ownerPays, setOwnerPays] = useState(true);

  const submit = async () => {
    try {
      const { profile } = await connect.mutateAsync({
        token: token.trim(),
        ownerPaysAgentTurns: ownerPays,
        photoJpegBase64: await capturePhoto(),
      });
      setToken('');
      toast.success(t(`${K}.connected`, { name }));
      reportProfile(profile, t);
    } catch (error) {
      toast.error(t(`${K}.connectFailed`, { reason: errorMessage(error, t(`${K}.tryAgain`)) }));
    }
  };

  return (
    <>
      <AgentCreatorField label={t(`${K}.howTo`)} divider={false} multiline>
        <View className="gap-1">
          <Text variant="body-2-regular">{t(`${K}.step1`)}</Text>
          <Text variant="body-2-regular">{t(`${K}.step2`, { name })}</Text>
        </View>
      </AgentCreatorField>
      <AgentCreatorField label={t(`${K}.token`)}>
        <TextFieldInput
          label={t(`${K}.token`)}
          placeholder={t(`${K}.tokenPlaceholder`)}
          value={token}
          onChangeText={setToken}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </AgentCreatorField>
      <AgentCreatorField label={t(`${K}.pays`, { name })}>
        <Switch
          accessibilityLabel={t(`${K}.pays`, { name })}
          checked={ownerPays}
          onCheckedChange={setOwnerPays}
        />
      </AgentCreatorField>
      <View className="flex-row">
        <Button
          size="sm"
          loading={connect.isPending}
          disabled={connect.isPending || token.trim().length < 10}
          onPress={submit}
        >
          {t(`${K}.connect`)}
        </Button>
      </View>
    </>
  );
}

/** The bot the gemie has: how Telegram sees it, its settings, and removing it. */
function ConnectedBot({
  gemieId,
  name,
  bot,
  capturePhoto,
}: {
  gemieId: string;
  name: string;
  bot: GemieTelegramBot;
  capturePhoto: () => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const { update, remove } = useGemieTelegramBotMutations(gemieId);
  const username = bot.live?.username ?? bot.username;
  const state = !bot.live ? 'unknown' : bot.live.webhook;

  const save = async (patch: Parameters<typeof update.mutateAsync>[0]) => {
    try {
      const { profile } = await update.mutateAsync(patch);
      if (patch.syncProfile) {
        toast.success(t(`${K}.synced`, { name }));
        reportProfile(profile, t);
      }
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
      <AgentCreatorField label={t(`${K}.bot`)} divider={false}>
        <View className="gap-1">
          <Text variant="body-2-semibold">{username ? `@${username}` : bot.name}</Text>
          <Text variant="body-2-regular">{t(`${K}.state.${state}`)}</Text>
          {bot.live?.webhookError ? (
            <Text variant="body-2-regular" className="text-text-secondary">
              {bot.live.webhookError}
            </Text>
          ) : null}
          <Text variant="body-2-regular" className="text-text-secondary">
            {t(`${K}.answered`, { count: bot.totalMessages, name })}
          </Text>
        </View>
      </AgentCreatorField>
      {username ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            onPress={() => void Linking.openURL(`https://t.me/${username}`)}
          >
            {t(`${K}.open`)}
          </Button>
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            onPress={() => void Linking.openURL(`https://t.me/${username}?startgroup=gemie`)}
          >
            {t(`${K}.addToGroup`)}
          </Button>
        </View>
      ) : null}
      <EditorSelect
        label={t(`${K}.groups`)}
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
      {bot.groupReplies === 'mentions' && bot.live && !bot.live.canReadAllGroupMessages ? (
        <Text variant="body-2-regular" className="text-text-secondary">
          {t(`${K}.privacy`, { username: username ?? '' })}
        </Text>
      ) : null}
      {bot.callerPays ? (
        <AgentCreatorField label={t(`${K}.pays`, { name })}>
          <Switch
            accessibilityLabel={t(`${K}.pays`, { name })}
            checked={bot.ownerPaysAgentTurns}
            disabled={update.isPending}
            onCheckedChange={(ownerPaysAgentTurns) => save({ ownerPaysAgentTurns })}
          />
        </AgentCreatorField>
      ) : null}
      <Text variant="body-2-regular" className="text-text-secondary">
        {t(`${K}.conversations`, { name })}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          size="sm"
          appearance="outline"
          tone="neutral"
          loading={update.isPending && update.variables?.syncProfile === true}
          disabled={update.isPending}
          onPress={async () => save({ syncProfile: true, photoJpegBase64: await capturePhoto() })}
        >
          {t(`${K}.sync`, { name })}
        </Button>
        <Button
          size="sm"
          appearance="outline"
          tone="danger"
          disabled={remove.isPending}
          onPress={handleRemove}
        >
          {t(`${K}.remove`)}
        </Button>
      </View>
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
  /** The gemie's character and colour, drawn as the bot's picture. */
  look: { character: AvatarCharacter; color: string | null };
}) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useGemieTelegramBot(agentId);
  const photo = useGemieAvatarPhoto(look);

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      <Text variant="body-2-regular" className="text-text-secondary">
        {t(`${K}.description`, { name })}
      </Text>
      {isPending ? (
        <SettingsSkeletonRows control="none" rows={2} />
      ) : isError || !data ? (
        <Text variant="body-2-regular">{t(`${K}.loadFailed`)}</Text>
      ) : !data.available ? (
        <Text variant="body-2-regular">{t(`${K}.unavailable`)}</Text>
      ) : data.bot ? (
        <ConnectedBot gemieId={agentId} name={name} bot={data.bot} capturePhoto={photo.capture} />
      ) : (
        <ConnectBot gemieId={agentId} name={name} capturePhoto={photo.capture} />
      )}
      {photo.element}
    </AgentCreatorSection>
  );
}
