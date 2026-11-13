import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@oxy.so/bloom/accordion';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiLockUnlockLine } from '@oxy.so/bloom/icons/RiLockUnlockLine';
import { RiShieldCheckFill } from '@oxy.so/bloom/icons/RiShieldCheckFill';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { RiUserCommunityLine } from '@oxy.so/bloom/icons/RiUserCommunityLine';
import { Search } from '@oxy.so/bloom/search';
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
import { TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { englishCopy, type Translate } from '../../lib/copy';
import {
  CONNECTOR_SORTS,
  type ConnectorCategory,
  type ConnectorEntry,
  type ConnectorSort,
  type ConnectorTrust,
  useConnections,
  useConnectorActions,
  useConnectorStore,
  connectorReturnTo,
  signInErrorKey,
  useWebSignInReturn,
} from '../../runtime/connectors';
import { ConnectorLogo } from './ConnectorLogo';

/** This component's own strings. */
const K = 'gemie.connectors';

/** How long typing settles before the store is searched. */
const SEARCH_DEBOUNCE_MS = 250;

export interface GemieConnectorsStoreProps {
  /**
   * The native app's URL scheme (`gemies`, `alia`): a provider's sign-in returns to the store at
   * `<scheme>://connectors`, and on the web to the store's page (`connectorReturnTo`).
   */
  nativeScheme: string;
  /** The host's translator; English without one. */
  t?: Translate;
  /** Told when an account was connected here (a native sign-in finishes in place). */
  onConnected?: () => void;
}

const TRUST_ICON = {
  official: RiShieldCheckFill,
  verified: RiShieldCheckLine,
  community: RiUserCommunityLine,
} as const;
const TRUST_COLOR = { official: 'primary', verified: 'info', community: 'default' } as const;

/** The filters a person can turn on, each a chip. */
const FILTERS = ['official', 'verified', 'noSignIn'] as const;
type StoreFilter = (typeof FILTERS)[number];

/** The value of `text` once it stopped changing for `ms`. */
function useSettled(text: string, ms: number): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), ms);
    return () => clearTimeout(timer);
  }, [text, ms]);
  return settled;
}

/**
 * The connectors store: every remote MCP server this deployment can connect — the providers'
 * servers Gemies curates and the hundreds synced from the official MCP Registry — searched,
 * filtered by category, badge and sign-in, sorted and paged by the API. Each shows its real logo,
 * its badge (official, verified, community), what it does and a Connect button; connecting again
 * adds another account. A person can also add their own MCP server by URL. What the person
 * connected is managed in Settings (`GemieConnectedConnectors`), not here.
 */
export function GemieConnectorsStore({
  nativeScheme,
  t = englishCopy,
  onConnected,
}: GemieConnectorsStoreProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | null>(null);
  const [filters, setFilters] = useState<ReadonlySet<StoreFilter>>(new Set());
  const [sort, setSort] = useState<ConnectorSort>('featured');
  const [pending, setPending] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const q = useSettled(query.trim(), SEARCH_DEBOUNCE_MS);

  const trust = (['official', 'verified'] as const).filter((badge) => filters.has(badge));
  const store = useConnectorStore({
    q,
    category: category ?? undefined,
    trust: trust as ConnectorTrust[],
    noSignIn: filters.has('noSignIn'),
    sort,
  });
  const connections = useConnections();
  const actions = useConnectorActions({ returnTo: connectorReturnTo(nativeScheme) });
  useWebSignInReturn((outcome) => {
    if (outcome.ok) {
      toast.success(t(`${K}.signIn.connected`, { name: outcome.connection.displayName }));
    } else {
      toast.error(t(signInErrorKey(outcome.error)));
    }
  });

  const accountsOf = useMemo(() => {
    const counts = new Map<string, number>();
    for (const connection of connections.data ?? []) {
      if (connection.registryId) {
        counts.set(connection.registryId, (counts.get(connection.registryId) ?? 0) + 1);
      }
    }
    return counts;
  }, [connections.data]);

  const pages = store.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.servers);
  const total = pages[0]?.total ?? 0;
  const categories = pages[0]?.categories ?? [];
  const browsing = !q && category === null && filters.size === 0 && sort === 'featured';
  const featured = browsing ? entries.filter((entry) => entry.featured) : [];
  const rest = browsing ? entries.filter((entry) => !entry.featured) : entries;

  const toggle = (filter: StoreFilter) =>
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });

  const connect = async (entry: ConnectorEntry) => {
    setPending(entry.id);
    try {
      const connection = await actions.connect.mutateAsync(entry.id);
      if (connection) {
        toast.success(t(`${K}.signIn.connected`, { name: entry.name }));
        onConnected?.();
      }
    } catch {
      toast.error(t(`${K}.signIn.failed`, { name: entry.name }));
    } finally {
      setPending(null);
    }
  };

  const card = (entry: ConnectorEntry) => (
    <StoreCard
      key={entry.id}
      entry={entry}
      accounts={accountsOf.get(entry.id) ?? 0}
      pending={pending === entry.id}
      onConnect={connect}
      t={t}
    />
  );

  return (
    <View className="gap-4">
      <Search
        label={t(`${K}.store.search`)}
        value={query}
        onChangeText={setQuery}
        onClearText={() => setQuery('')}
      />
      {categories.length > 1 || category !== null ? (
        <ChipRow role="radiogroup" accessibilityLabel={t(`${K}.store.categories`)}>
          <Chip
            size="sm"
            role="radio"
            selected={category === null}
            onPress={() => setCategory(null)}
          >
            {t(`${K}.store.all`)}
          </Chip>
          {categories.map(({ id, count }) => (
            <Chip
              key={id}
              size="sm"
              role="radio"
              selected={category === id}
              onPress={() => setCategory(category === id ? null : id)}
            >
              {`${t(`${K}.category.${id}`)} ${count}`}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <ChipRow role="group" accessibilityLabel={t(`${K}.store.filters`)}>
          {FILTERS.map((filter) => (
            <Chip
              key={filter}
              size="sm"
              role="checkbox"
              selected={filters.has(filter)}
              onPress={() => toggle(filter)}
            >
              {t(`${K}.store.filter.${filter}`)}
            </Chip>
          ))}
        </ChipRow>
        <SortSelect value={sort} onChange={setSort} t={t} />
      </View>

      {store.isPending ? (
        <StoreSkeleton />
      ) : store.isError && entries.length === 0 ? (
        <View className="items-start gap-2 py-4">
          <Text variant="body-2-regular" className="text-text-secondary">
            {t(`${K}.store.loadFailed`)}
          </Text>
          <Button size="sm" appearance="outline" tone="neutral" onPress={() => store.refetch()}>
            {t(`${K}.store.retry`)}
          </Button>
        </View>
      ) : (
        <>
          {featured.length > 0 ? (
            <StoreGroup title={t(`${K}.store.featured`)}>{featured.map(card)}</StoreGroup>
          ) : null}
          {rest.length > 0 ? (
            <StoreGroup
              title={
                browsing
                  ? t(`${K}.store.allCount`, { count: total })
                  : t(`${K}.store.results`, { count: total })
              }
            >
              {rest.map(card)}
            </StoreGroup>
          ) : null}
          {entries.length === 0 ? (
            <Text variant="body-2-regular" className="py-4 text-text-secondary">
              {q ? t(`${K}.store.noResults`, { query: q }) : t(`${K}.store.empty`)}
            </Text>
          ) : null}
          {store.hasNextPage ? (
            <View className="items-center">
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                loading={store.isFetchingNextPage}
                onPress={() => void store.fetchNextPage()}
              >
                {t(`${K}.store.more`, { count: total - entries.length })}
              </Button>
            </View>
          ) : null}
        </>
      )}

      <Pressable
        accessibilityRole="button"
        onPress={() => setCustomOpen(true)}
        className="flex-row items-center gap-3 rounded-2xl border border-dashed border-border p-4"
      >
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-background-tertiary-default">
          <RiAddLine width={20} height={20} />
        </View>
        <View className="flex-1 gap-0.5">
          <Text variant="body-2-semibold">{t(`${K}.custom.title`)}</Text>
          <Text variant="body-2-regular" className="text-text-secondary">
            {t(`${K}.custom.description`)}
          </Text>
        </View>
      </Pressable>

      <CustomServerDialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        onAdd={async (input) => {
          await actions.addCustom.mutateAsync(input);
          toast.success(t(`${K}.signIn.connected`, { name: input.name }));
          onConnected?.();
        }}
        t={t}
      />
    </View>
  );
}

function SortSelect({
  value,
  onChange,
  t,
}: {
  value: ConnectorSort;
  onChange: (sort: ConnectorSort) => void;
  t: Translate;
}) {
  const label = t(`${K}.store.sort`);
  const items = CONNECTOR_SORTS.map((sort) => ({
    id: sort,
    label: t(`${K}.store.sortBy.${sort}`),
  }));
  return (
    <Select size="sm" value={value} onValueChange={(next) => onChange(next as ConnectorSort)}>
      <SelectTrigger label={label}>
        <SelectValue placeholder={label} />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        label={label}
        items={items}
        width={220}
        valueExtractor={(item) => item.id}
        renderItem={(item) => (
          <SelectItem value={item.id} label={item.label}>
            <SelectItemText>{item.label}</SelectItemText>
          </SelectItem>
        )}
      />
    </Select>
  );
}

function StoreGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      {title ? <Text variant="headline-semibold">{title}</Text> : null}
      <View className="flex-row flex-wrap gap-3">{children}</View>
    </View>
  );
}

function StoreCard({
  entry,
  accounts,
  pending,
  onConnect,
  t,
}: {
  entry: ConnectorEntry;
  accounts: number;
  pending: boolean;
  onConnect: (entry: ConnectorEntry) => void;
  t: Translate;
}) {
  return (
    <View className="min-w-[260px] flex-1 basis-[260px] gap-3 rounded-2xl border border-border p-4">
      <View className="flex-row items-center gap-3">
        <ConnectorLogo name={entry.name} logoUrl={entry.logoUrl} size={40} />
        <View className="flex-1 gap-1">
          <Text variant="body-2-semibold" numberOfLines={1}>
            {entry.name}
          </Text>
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Badge
              size="label-small"
              variant="subtle"
              color={TRUST_COLOR[entry.trust]}
              icon={TRUST_ICON[entry.trust]}
              content={t(`${K}.trust.${entry.trust}`)}
            />
            {entry.signIn === 'none' ? (
              <Badge
                size="label-small"
                variant="subtle"
                color="success"
                icon={RiLockUnlockLine}
                content={t(`${K}.store.filter.noSignIn`)}
              />
            ) : null}
            <Text variant="body-2-regular" className="text-text-secondary" numberOfLines={1}>
              {accounts > 0
                ? t(`${K}.store.connectedCount`, { count: accounts })
                : t(`${K}.category.${entry.category}`)}
            </Text>
          </View>
        </View>
      </View>
      <Text variant="body-2-regular" className="text-text-secondary" numberOfLines={2}>
        {entry.description}
      </Text>
      <View className="flex-row items-center gap-2">
        <Button
          size="sm"
          appearance={accounts > 0 ? 'outline' : 'solid'}
          tone={accounts > 0 ? 'neutral' : 'accent'}
          loading={pending}
          onPress={() => onConnect(entry)}
        >
          {accounts > 0 ? t(`${K}.store.connectAnother`) : t(`${K}.store.connect`)}
        </Button>
        {entry.docsUrl ? (
          <Button
            size="sm"
            appearance="plain"
            tone="neutral"
            onPress={() => void WebBrowser.openBrowserAsync(entry.docsUrl as string)}
          >
            {t(`${K}.store.docs`)}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function CustomServerDialog({
  open,
  onClose,
  onAdd,
  t,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (input: { name: string; url: string; headers?: Record<string, string> }) => Promise<void>;
  t: Translate;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [advanced, setAdvanced] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  const reset = () => {
    setName('');
    setUrl('');
    setHeaderName('');
    setHeaderValue('');
    setAdvanced(undefined);
    onClose();
  };

  const add = async () => {
    setAdding(true);
    try {
      await onAdd({
        name: name.trim(),
        url: url.trim(),
        ...(headerName.trim() && headerValue
          ? { headers: { [headerName.trim()]: headerValue } }
          : {}),
      });
      reset();
    } catch {
      toast.error(t(`${K}.custom.failed`));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={reset}
      placement={{ base: 'bottom', md: 'center' }}
      maxWidth={420}
      title={t(`${K}.custom.title`)}
      description={t(`${K}.custom.description`)}
      actions={[
        { label: t(`${K}.custom.cancel`), color: 'cancel', disabled: adding },
        {
          label: adding ? t(`${K}.custom.adding`) : t(`${K}.custom.add`),
          onPress: add,
          disabled: adding || !name.trim() || !url.trim().startsWith('https://'),
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-3">
        <View>
          <TextFieldLabel>{t(`${K}.custom.name`)}</TextFieldLabel>
          <TextFieldInput
            label={t(`${K}.custom.name`)}
            placeholder={t(`${K}.custom.namePlaceholder`)}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
          />
        </View>
        <View>
          <TextFieldLabel>{t(`${K}.custom.url`)}</TextFieldLabel>
          <TextFieldInput
            label={t(`${K}.custom.url`)}
            placeholder="https://…/mcp"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
        <Accordion
          type="single"
          value={advanced}
          onValueChange={(next) => setAdvanced(typeof next === 'string' ? next : undefined)}
        >
          <AccordionItem value="advanced">
            <AccordionTrigger>{t(`${K}.custom.advanced`)}</AccordionTrigger>
            <AccordionContent>
              <View className="gap-3">
                <View>
                  <TextFieldLabel>{t(`${K}.custom.headerName`)}</TextFieldLabel>
                  <TextFieldInput
                    label={t(`${K}.custom.headerName`)}
                    placeholder="Authorization"
                    value={headerName}
                    onChangeText={setHeaderName}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <View>
                  <TextFieldLabel>{t(`${K}.custom.headerValue`)}</TextFieldLabel>
                  <TextFieldInput
                    label={t(`${K}.custom.headerValue`)}
                    placeholder="Bearer …"
                    value={headerValue}
                    onChangeText={setHeaderValue}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                  />
                </View>
              </View>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </View>
    </Dialog>
  );
}

/** The store's shape while the catalogue is read: cards, never a spinner. */
function StoreSkeleton() {
  return (
    <Skeleton.Region>
      <View className="flex-row flex-wrap gap-3">
        {[0, 1, 2, 3].map((index) => (
          <View
            key={index}
            className="min-w-[260px] flex-1 basis-[260px] gap-3 rounded-2xl border border-border p-4"
          >
            <View className="flex-row items-center gap-3">
              <Skeleton.Box width={40} height={40} borderRadius={9} />
              <View className="flex-1 gap-1.5">
                <Skeleton.Box width={120} height={14} />
                <Skeleton.Box width={80} height={12} />
              </View>
            </View>
            <Skeleton.Box width={220} height={12} />
            <Skeleton.Box width={88} height={32} borderRadius={16} />
          </View>
        ))}
      </View>
    </Skeleton.Region>
  );
}
