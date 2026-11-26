import { AgentListingRow } from '@/features/agents/ui/agent-listing-row';
import { catalogueItems, type CatalogueItem } from '@/features/agents/model/catalogue-items';
import { agentCategoryLabel } from '@/features/agents/model/category';
import { agentIdentityMatches } from '@/features/agents/model/identity';
import { agentChatRoute, agentDetailsRoute } from '@/shared/routing/agent-address';
import { useAgentCatalogue } from '@/features/agents/runtime/use-agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { EmptyState } from '@/shared/ui/empty-state';
import { useWindowBreakpoint } from '@oxy.so/bloom/hooks';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { FlashList } from '@shopify/flash-list';
import { useNewAgentConversation } from '@/features/agents/runtime/use-new-agent-conversation';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, View, StyleSheet } from 'react-native';

/**
 * The agent catalogue. Plain content on the layout's surface: the layout draws
 * the page, its corners, the menu button and the "Agents" crumb, so this page
 * starts at its description and actions.
 */
export default function AgentsScreen() {
  const { t } = useTranslation();
  const { data, isPending: loading, refetch } = useAgentCatalogue();
  const agents = data?.agents ?? [];
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const router = useRouter();
  // Rows sit two to a line where there is room (Bloom's `sm` breakpoint), one on a phone.
  const columns = useWindowBreakpoint() === 'base' ? 1 : 2;

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      const agent = agents.find((entry) => entry._id === agentId);
      const route = agent === undefined ? null : agentDetailsRoute(agent);
      if (route !== null) router.push(route);
    },
    [agents, router],
  );

  const handleChat = useCallback(
    (agentId: string) => {
      const agent = agents.find((entry) => entry._id === agentId);
      if (agent !== undefined) router.push(agentChatRoute(agent));
    },
    [agents, router],
  );

  const handleCreateAgent = useNewAgentConversation();

  const categories = useMemo(() => {
    const cats = new Set(agents.map((a) => a.category));
    return [t('common.all'), ...Array.from(cats)];
  }, [agents, t]);

  const filteredAgents = useMemo(() => {
    let filtered = agents;
    if (selectedCategory && selectedCategory !== t('common.all')) {
      filtered = filtered.filter((agent) => agent.category === selectedCategory);
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (agent) =>
          // Name and handle are Oxy's and may be unresolved; the shared matcher
          // is what keeps every surface agreeing on what an agent is called.
          agentIdentityMatches(agent, query) ||
          agent.tagline.toLowerCase().includes(query) ||
          agent.description.toLowerCase().includes(query) ||
          agent.category.toLowerCase().includes(query) ||
          agent.tags.some((tag) => tag.toLowerCase().includes(query)),
      );
    }
    return filtered;
  }, [agents, searchQuery, selectedCategory, t]);

  // ── Split header into smaller memos to avoid re-rendering everything ──

  /** The description, and the page's two actions beside it. */
  const headerTop = (
    <View style={styles.headerBlock}>
      <Muted>{t('agents.subtitle')}</Muted>
    </View>
  );

  const searchBar = (
    <View style={styles.headerBlock}>
      <Search
        label={t('agents.searchPlaceholder')}
        value={searchQuery}
        onChangeText={setSearchQuery}
        onClearText={() => setSearchQuery('')}
      />
    </View>
  );

  const categoryChips = useMemo(
    () => (
      <View style={styles.categories}>
        <ChipRow role="radiogroup" accessibilityLabel={t('pages.agents.categories')}>
          {categories.map((category) => {
            const isActive =
              selectedCategory === category || (!selectedCategory && category === t('common.all'));
            return (
              <Chip
                key={category}
                size="xl"
                role="radio"
                selected={isActive}
                onPress={() => setSelectedCategory(category === t('common.all') ? null : category)}
              >
                {category === t('common.all') ? category : agentCategoryLabel(category, t)}
              </Chip>
            );
          })}
        </ChipRow>
      </View>
    ),
    [categories, selectedCategory, t],
  );

  /** With nothing typed and no category chosen: Featured, then a preview of every category. */
  const overview = !searchQuery.trim() && !selectedCategory;
  const items = useMemo(
    () =>
      catalogueItems({
        agents: filteredAgents,
        overview,
        columns,
        featuredLabel: t('agents.featured'),
        categoryLabel: (category) => agentCategoryLabel(category, t),
        matchedLabel: (count) =>
          selectedCategory
            ? agentCategoryLabel(selectedCategory, t)
            : `${count} ${count === 1 ? 'agent' : 'agents'}`,
      }),
    [filteredAgents, overview, columns, selectedCategory, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: CatalogueItem }) =>
      item.kind === 'title' ? (
        <View style={styles.sectionTitle}>
          <Text variant="headline-semibold">{item.label}</Text>
          {item.category === undefined ? null : (
            <Button
              size="sm"
              tone="neutral"
              appearance="plain"
              onPress={() => setSelectedCategory(item.category ?? null)}
            >
              {t('agents.viewAll')}
            </Button>
          )}
        </View>
      ) : (
        <View style={styles.cardRow}>
          {item.agents.map((agent) => (
            <View key={agent._id} style={styles.card}>
              <AgentListingRow agent={agent} onPress={handleSelectAgent} onChat={handleChat} />
            </View>
          ))}
          {/* A short last row keeps its agents the width of a column. */}
          {Array.from({ length: columns - item.agents.length }, (_, index) => (
            <View key={`pad-${index}`} style={styles.cardPad} />
          ))}
        </View>
      ),
    [columns, handleSelectAgent, handleChat, t],
  );

  /** Rows shaped like `AgentListingRow`, while the catalogue is on its way. */
  const loadingSkeleton = useMemo(() => {
    if (!loading || agents.length > 0) return null;
    return (
      <View style={styles.loading}>
        {Array.from({ length: 6 }).map((_, i) => (
          <View key={i} style={styles.loadingRow}>
            <Skeleton.Circle size={32} />
            <View style={styles.loadingText}>
              <Skeleton.Box width="45%" height={13} />
              <Skeleton.Box width="80%" height={11} />
            </View>
          </View>
        ))}
      </View>
    );
  }, [loading, agents.length]);

  const listHeader = (
    <View style={styles.listHeader}>
      {headerTop}
      {searchBar}
      {categoryChips}
      {loadingSkeleton}
    </View>
  );

  const listEmpty = useMemo(() => {
    if (loading) return null;
    return (
      <EmptyState
        title={t('agents.noAgents')}
        description={searchQuery ? t('common.tryDifferentSearch') : t('agents.createFirstHint')}
        // Creating an agent is a real screen, so an empty list offers it
        // rather than saying it is "coming soon" (#608, rule 6).
        action={
          searchQuery ? undefined : { label: t('agents.createAgent'), onPress: handleCreateAgent }
        }
      />
    );
  }, [loading, t, searchQuery, handleCreateAgent]);

  // FlashList measures its own content container, so the page gutter (16, the
  // layout breadcrumb's, less the 6 each cell pads) and the bottom breathing
  // room sit around the list and after it rather than in `contentContainerStyle`.
  return (
    <View style={styles.page}>
      <Stack.Screen
        options={{
          headerRight: () => (
            // "Create", as on Skills: the page says what is created; the label for a screen
            // reader still does.
            <Button
              size="md"
              tone="action"
              leadingIcon={RiAddLine}
              onPress={handleCreateAgent}
              accessibilityLabel={t('agents.createAgent')}
            >
              {t('common.create')}
            </Button>
          ),
        }}
      />
      <FlashList
        key={columns}
        data={filteredAgents.length === 0 ? [] : items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={<View style={styles.footer} />}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  headerBlock: { paddingTop: 16 },
  categories: { paddingVertical: 12 },
  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 20,
    paddingBottom: 4,
  },
  cardRow: { flexDirection: 'row' },
  card: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  cardPad: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  loading: { paddingTop: 20 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  loadingText: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 6 },
  listHeader: { paddingHorizontal: 6 },
  page: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', paddingHorizontal: 10 },
  footer: { height: 24 },
});
