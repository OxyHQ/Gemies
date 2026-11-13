import {
  GEMIE_ACCOUNT_PLATFORMS,
  GEMIE_ACCOUNT_STATUSES,
  useGemieAccountMutations,
  useGemieAccountQr,
  useGemieAccounts,
  type GemieAccount,
  type GemieAccountLink,
  type GemieAccountPlatform,
} from '@/features/agents/runtime/use-gemie-accounts';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Button } from '@oxy.so/bloom/button';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useEffect, useState } from 'react';
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
  const connected = data?.connected === true;

  useEffect(() => {
    if (!connected) return;
    toast.success(t(`${K}.linked`, { platform: PLATFORM_LABELS[platform], name }));
    onDone();
  }, [connected, name, onDone, platform, t]);

  return (
    <AgentCreatorField
      label={t(`${K}.scanTitle`, { platform: PLATFORM_LABELS[platform] })}
      multiline
    >
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

/**
 * The WhatsApp and Telegram accounts the person linked to this gemie (ADR 0035). The gemie answers
 * what arrives on them, and only its own turns can read or send through them.
 */
export function AgentAccountsSection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: accounts, isPending, isError } = useGemieAccounts(agentId);
  const { link, remove } = useGemieAccountMutations(agentId);
  const [linking, setLinking] = useState<{
    platform: GemieAccountPlatform;
    link: GemieAccountLink;
  } | null>(null);

  const statusLabel = (account: GemieAccount) =>
    GEMIE_ACCOUNT_STATUSES.includes(account.status)
      ? t(`${K}.status.${account.status}`)
      : account.status;

  const handleLink = async (platform: GemieAccountPlatform) => {
    try {
      setLinking({ platform, link: await link.mutateAsync(platform) });
    } catch {
      toast.error(t(`${K}.linkFailed`, { platform: PLATFORM_LABELS[platform] }));
    }
  };

  const handleCancel = async () => {
    const pending = linking;
    setLinking(null);
    if (pending) await remove.mutateAsync(pending.link.accountId).catch(() => {});
  };

  const handleRemove = async (account: GemieAccount) => {
    const platform = PLATFORM_LABELS[account.platform] ?? account.platform;
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

  // The account being linked shows as its QR code, not as a `connecting` row beside it.
  const listed = (accounts ?? []).filter((account) => account._id !== linking?.link.accountId);

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
          {listed.map((account) => {
            const platform = PLATFORM_LABELS[account.platform] ?? account.platform;
            const identifier = account.phoneNumber || account.displayName || null;
            return (
              <AgentCreatorField key={account._id} label={platform}>
                <View className="flex-row items-center gap-3">
                  <Text variant="body-2-regular" className="text-text-secondary">
                    {[identifier, statusLabel(account)].filter(Boolean).join(' · ')}
                  </Text>
                  <Button
                    size="sm"
                    appearance="outline"
                    tone="danger"
                    accessibilityLabel={t(`${K}.removeNamed`, { platform })}
                    disabled={remove.isPending}
                    onPress={() => handleRemove(account)}
                  >
                    {t(`${K}.remove`)}
                  </Button>
                </View>
              </AgentCreatorField>
            );
          })}
          {linking ? (
            <LinkingAccount
              agentId={agentId}
              name={name}
              platform={linking.platform}
              link={linking.link}
              onDone={() => setLinking(null)}
              onCancel={handleCancel}
            />
          ) : (
            <AgentCreatorField label={t(`${K}.link`)}>
              <View className="flex-row gap-2">
                {GEMIE_ACCOUNT_PLATFORMS.map((platform) => (
                  <Button
                    key={platform}
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    accessibilityLabel={t(`${K}.linkNamed`, {
                      platform: PLATFORM_LABELS[platform],
                    })}
                    loading={link.isPending && link.variables === platform}
                    disabled={link.isPending || isError}
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
