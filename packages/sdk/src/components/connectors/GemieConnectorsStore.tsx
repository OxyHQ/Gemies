import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@oxy.so/bloom/accordion';
import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { englishCopy, type Translate } from '../../lib/copy';
import {
  CONNECTOR_CATEGORIES,
  type ConnectorCategory,
  type ConnectorEntry,
  useConnections,
  useConnectorActions,
  useConnectorCatalogue,
  connectorReturnTo,
  signInErrorKey,
  useWebSignInReturn,
} from '../../runtime/connectors';
import { ConnectorLogo } from './ConnectorLogo';

/** This component's own strings. */
const K = 'gemie.connectors';

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

/**
 * The connectors store: every connector this deployment can connect, with its real logo, what it
 * does, its category and a Connect button, and a way to add one's own MCP server by URL. Connecting
 * again adds another account of the same connector. What the person connected is managed in
 * Settings (`GemieConnectedConnectors`), not here.
 */
export function GemieConnectorsStore({
  nativeScheme,
  t = englishCopy,
  onConnected,
}: GemieConnectorsStoreProps) {
  const catalogue = useConnectorCatalogue();
  const connections = useConnections();
  const actions = useConnectorActions({ returnTo: connectorReturnTo(nativeScheme) });
  useWebSignInReturn((outcome) => {
    if (outcome.ok) {
      toast.success(t(`${K}.signIn.connected`, { name: outcome.connection.displayName }));
    } else {
      toast.error(t(signInErrorKey(outcome.error)));
    }
  });
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);

  const accountsOf = useMemo(() => {
    const counts = new Map<string, number>();
    for (const connection of connections.data ?? []) {
      if (connection.registryId) {
        counts.set(connection.registryId, (counts.get(connection.registryId) ?? 0) + 1);
      }
    }
    return counts;
  }, [connections.data]);

  const visible = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (catalogue.data ?? []).filter(
      (entry) =>
        (category === null || entry.category === category) &&
        (!words ||
          entry.name.toLowerCase().includes(words) ||
          entry.description.toLowerCase().includes(words)),
    );
  }, [catalogue.data, query, category]);

  const browsing = !query.trim() && category === null;
  const featured = browsing ? visible.filter((entry) => entry.featured) : [];
  const rest = browsing ? visible.filter((entry) => !entry.featured) : visible;
  const categories = CONNECTOR_CATEGORIES.filter((slug) =>
    (catalogue.data ?? []).some((entry) => entry.category === slug),
  );

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

  return (
    <View className="gap-4">
      <Search
        label={t(`${K}.store.search`)}
        value={query}
        onChangeText={setQuery}
        onClearText={() => setQuery('')}
      />
      {categories.length > 1 ? (
        <ChipRow role="radiogroup" accessibilityLabel={t(`${K}.store.categories`)}>
          <Chip
            size="sm"
            role="radio"
            selected={category === null}
            onPress={() => setCategory(null)}
          >
            {t(`${K}.store.all`)}
          </Chip>
          {categories.map((slug) => (
            <Chip
              key={slug}
              size="sm"
              role="radio"
              selected={category === slug}
              onPress={() => setCategory(category === slug ? null : slug)}
            >
              {t(`${K}.category.${slug}`)}
            </Chip>
          ))}
        </ChipRow>
      ) : null}

      {catalogue.isPending ? (
        <StoreSkeleton />
      ) : catalogue.isError ? (
        <View className="items-start gap-2 py-4">
          <Text variant="body-2-regular" className="text-text-secondary">
            {t(`${K}.store.loadFailed`)}
          </Text>
          <Button size="sm" appearance="outline" tone="neutral" onPress={() => catalogue.refetch()}>
            {t(`${K}.store.retry`)}
          </Button>
        </View>
      ) : (
        <>
          {featured.length > 0 ? (
            <StoreGroup title={t(`${K}.store.featured`)}>
              {featured.map((entry) => (
                <StoreCard
                  key={entry.id}
                  entry={entry}
                  accounts={accountsOf.get(entry.id) ?? 0}
                  pending={pending === entry.id}
                  onConnect={connect}
                  t={t}
                />
              ))}
            </StoreGroup>
          ) : null}
          {rest.length > 0 ? (
            <StoreGroup title={browsing && featured.length > 0 ? t(`${K}.store.all`) : undefined}>
              {rest.map((entry) => (
                <StoreCard
                  key={entry.id}
                  entry={entry}
                  accounts={accountsOf.get(entry.id) ?? 0}
                  pending={pending === entry.id}
                  onConnect={connect}
                  t={t}
                />
              ))}
            </StoreGroup>
          ) : null}
          {visible.length === 0 ? (
            <Text variant="body-2-regular" className="py-4 text-text-secondary">
              {query.trim()
                ? t(`${K}.store.noResults`, { query: query.trim() })
                : t(`${K}.store.empty`)}
            </Text>
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
        <View className="flex-1">
          <Text variant="body-2-semibold" numberOfLines={1}>
            {entry.name}
          </Text>
          <Text variant="body-2-regular" className="text-text-secondary" numberOfLines={1}>
            {accounts > 0
              ? t(`${K}.store.connectedCount`, { count: accounts })
              : t(`${K}.category.${entry.category}`)}
          </Text>
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
        <Button
          size="sm"
          appearance="plain"
          tone="neutral"
          onPress={() => void WebBrowser.openBrowserAsync(entry.docsUrl)}
        >
          {t(`${K}.store.docs`)}
        </Button>
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
