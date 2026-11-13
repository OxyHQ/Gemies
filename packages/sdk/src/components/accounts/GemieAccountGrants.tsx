import { Button } from '@oxy.so/bloom/button';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { englishCopy, type Translate } from '../../lib/copy';
import {
  useConnectedAccountMutations,
  useConnectedAccounts,
} from '../../runtime/connected-accounts';
import { GrantSwitchRow } from '../connectors/GrantSwitchRow';
import { K, PlatformMark, accountName, statusText } from './account-parts';

export interface GemieAccountGrantsProps {
  /** The gemie whose grants these are (Alia's id for her locked editor). */
  gemieId: string;
  /** The gemie's name, as the copy says it. */
  name: string;
  /** Opens Settings › Connected accounts, where accounts are connected and who answers is chosen. */
  onManage: () => void;
  /** The host's translator, keyed as `gemie.accounts.*`; English when absent. */
  t?: Translate;
}

/**
 * The person's connected WhatsApp and Telegram accounts this gemie may use, one switch each (ADR
 * 0035 as amended), for its editor: the same grant the Settings panel writes, seen from the gemie,
 * the way its connectors are granted beside it (`GrantSwitchRow`). Connecting an account, and
 * choosing which gemie answers it on its own, are Settings', a tap away.
 */
export function GemieAccountGrants({
  gemieId,
  name,
  onManage,
  t = englishCopy,
}: GemieAccountGrantsProps) {
  const { data, isPending, isError, isFetching, refetch } = useConnectedAccounts();
  const { grant } = useConnectedAccountMutations();

  if (isPending) {
    return (
      <Skeleton.Region>
        <View className="gap-3 py-2.5">
          <Skeleton.Box width={220} height={14} />
          <Skeleton.Box width={160} height={14} />
        </View>
      </Skeleton.Region>
    );
  }

  if (isError && data === undefined) {
    return (
      <View className="items-start gap-2 py-2.5 pe-2.5">
        <Text variant="body-2-regular" className="text-text-secondary">
          {t(`${K}.loadFailed`)}
        </Text>
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
    );
  }

  // Only an account that has been connected can be used; one waiting for its scan is Settings'.
  const accounts = (data?.accounts ?? []).filter((account) => account.status !== 'qr-pending');

  const setGranted = async (accountId: string, granted: boolean) => {
    try {
      await grant.mutateAsync({ accountId, gemieId, granted });
    } catch {
      toast.error(t(`${K}.saveFailed`));
    }
  };

  return (
    <View>
      <View className="py-2.5 pe-2.5">
        <Text variant="body-2-regular" className="text-text-secondary">
          {accounts.length === 0 ? t(`${K}.grants.empty`) : t(`${K}.grants.description`, { name })}
        </Text>
      </View>
      {accounts.map((account) => {
        const label = accountName(account);
        const answers = account.answeringGemieId === gemieId;
        return (
          <GrantSwitchRow
            key={account._id}
            leading={<PlatformMark platform={account.platform} />}
            label={label}
            detail={
              answers
                ? t(`${K}.answersOnItsOwn`)
                : account.status === 'connected'
                  ? null
                  : statusText(account, t)
            }
            checked={account.gemieIds.includes(gemieId)}
            disabled={grant.isPending}
            accessibilityLabel={t(`${K}.grantLabel`, { gemie: name, account: label })}
            onCheckedChange={(granted) => void setGranted(account._id, granted)}
          />
        );
      })}
      <View className="flex-row border-t border-border py-2.5 pe-2.5">
        <Button size="sm" appearance="outline" tone="neutral" onPress={onManage}>
          {t(`${K}.grants.manage`)}
        </Button>
      </View>
    </View>
  );
}
