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
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
  const styles = useStyles();
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
    for (const connection of connections.value ?? []) {
      if (connection.registryId) {
        counts.set(connection.registryId, (counts.get(connection.registryId) ?? 0) + 1);
      }
    }
    return counts;
  }, [connections.value]);

  const { entries, total, categories } = store;
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
      const connection = await actions.connect.run(entry.id);
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
    <View style={styles.store}>
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
      <View style={styles.filters}>
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

      {store.isLoading ? (
        <StoreSkeleton />
      ) : store.isError && entries.length === 0 ? (
        <View style={styles.failure}>
          <Text variant="body-2-regular" style={styles.muted}>
            {t(`${K}.store.loadFailed`)}
          </Text>
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            onPress={() => void store.refresh()}
          >
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
            <Text variant="body-2-regular" style={styles.emptyText}>
              {q ? t(`${K}.store.noResults`, { query: q }) : t(`${K}.store.empty`)}
            </Text>
          ) : null}
          {store.hasMore ? (
            <View style={styles.more}>
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                loading={store.isLoadingMore}
                onPress={() => void store.more()}
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
        style={styles.customTile}
      >
        <View style={styles.customIcon}>
          <RiAddLine width={20} height={20} />
        </View>
        <View style={styles.customText}>
          <Text variant="body-2-semibold">{t(`${K}.custom.title`)}</Text>
          <Text variant="body-2-regular" style={styles.muted}>
            {t(`${K}.custom.description`)}
          </Text>
        </View>
      </Pressable>

      <CustomServerDialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        onAdd={async (input) => {
          await actions.addCustom.run(input);
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
  const styles = useStyles();
  return (
    <View style={styles.section}>
      {title ? <Text variant="headline-semibold">{title}</Text> : null}
      <View style={styles.grid}>{children}</View>
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
  const styles = useStyles();
  return (
    <View style={styles.entry}>
      <View style={styles.entryHeader}>
        <ConnectorLogo name={entry.name} logoUrl={entry.logoUrl} size={40} />
        <View style={styles.entryText}>
          <Text variant="body-2-semibold" numberOfLines={1}>
            {entry.name}
          </Text>
          <View style={styles.badges}>
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
            <Text variant="body-2-regular" style={styles.muted} numberOfLines={1}>
              {accounts > 0
                ? t(`${K}.store.connectedCount`, { count: accounts })
                : t(`${K}.category.${entry.category}`)}
            </Text>
          </View>
        </View>
      </View>
      <Text variant="body-2-regular" style={styles.muted} numberOfLines={2}>
        {entry.description}
      </Text>
      <View style={styles.entryActions}>
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
  const styles = useStyles();
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
      <View style={styles.form}>
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
              <View style={styles.form}>
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
  const styles = useStyles();
  return (
    <Skeleton.Region>
      <View style={styles.grid}>
        {[0, 1, 2, 3].map((index) => (
          <View key={index} style={styles.entry}>
            <View style={styles.entryHeader}>
              <Skeleton.Box width={40} height={40} borderRadius={9} />
              <View style={styles.loadingText}>
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

const useStyles = createTokenStyles((t) => ({
  store: { gap: 16 },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  failure: { alignItems: 'flex-start', gap: 8, paddingVertical: 16 },
  muted: { color: t.mutedForeground },
  emptyText: { paddingVertical: 16, color: t.mutedForeground },
  more: { alignItems: 'center' },
  customTile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: t.border,
    padding: 16,
  },
  customIcon: {
    height: 40,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: t.popover,
  },
  customText: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 2 },
  section: { gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  entry: {
    minWidth: 260,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 260,
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    padding: 16,
  },
  entryHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  entryText: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 4 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  entryActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  form: { gap: 12 },
  loadingText: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 6 },
}));
