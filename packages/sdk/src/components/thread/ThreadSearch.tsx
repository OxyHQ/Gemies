import type { ThreadSearchHit } from '../../runtime/thread/thread-history';
import type { GemieThreadAddress } from '../../runtime/routes';
import { useThreadSearch } from '../../runtime/use-thread-search';
import { useLabels } from '../../lib/labels';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { ListItem } from '@oxy.so/bloom/list';
import { Search } from '@oxy.so/bloom/search';
import { Muted } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';

/**
 * Searching what was said in this thread, across every conversation in it.
 *
 * Not the app-wide palette on ⌘K, and the difference is the point: that one
 * finds a chat, this one finds a SENTENCE, and it looks past the stretch on
 * screen into every one before it. `GET /conversations/:id/…` could not serve
 * this — it would stop at the current conversation, which is the one thing the
 * reader can already see.
 *
 * Each result carries the cursor that opens the thread around it. A result you
 * can read and not reach is a wall, so `onJump` is not an extra: it is what the
 * hit is for.
 *
 * Bloom's `Search` for the field and a `ListItem` per hit, on a `Card` floating
 * over the top of the thread in its 768 column: the card is the surface, so
 * nothing here paints one of its own.
 */

interface ThreadSearchProps {
  /** The thread searched: by its gemie's handle, or by the gemie's id. */
  thread: GemieThreadAddress;
  /** Open the thread around this message. */
  onJump: (hit: ThreadSearchHit) => void;
  onClose: () => void;
}

/** The day a hit was written, in the reader's own locale and timezone. */
function hitDay(createdAt: string, locale: string): string {
  return new Date(createdAt).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const ThreadSearch = ({ thread, onJump, onClose }: ThreadSearchProps) => {
  const { t, locale } = useLabels();
  const [query, setQuery] = useState('');
  const { value: hits, isFetching, status } = useThreadSearch(thread, query);
  const isError = status === 'error';

  /**
   * Told apart deliberately: nothing typed is not a search that found nothing.
   * One is an invitation and the other is an answer, and saying "no results"
   * over an empty field answers a question nobody asked.
   */
  const asked = query.trim().length > 0;
  const found = hits ?? [];

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <View style={styles.column}>
        <Card elevation="m">
          <CardBody>
            <View style={styles.searchRow}>
              <View style={styles.search}>
                <Search
                  label={t('chat.searchThreadPlaceholder')}
                  value={query}
                  onChangeText={setQuery}
                  onClearText={() => setQuery('')}
                  autoFocus
                  returnKeyType="search"
                />
              </View>
              <Button
                size="md"
                appearance="plain"
                tone="neutral"
                iconOnly
                leadingIcon={RiCloseLine}
                accessibilityLabel={t('common.close')}
                onPress={onClose}
              />
            </View>

            {!asked ? (
              <View style={styles.hint}>
                <Muted>{t('chat.searchThreadHint')}</Muted>
              </View>
            ) : isError ? (
              <View style={styles.hint}>
                <Muted>{t('chat.searchThreadFailed')}</Muted>
              </View>
            ) : found.length === 0 ? (
              <View style={styles.hint}>
                <Muted>
                  {isFetching ? t('chat.searchThreadSearching') : t('chat.searchThreadEmpty')}
                </Muted>
              </View>
            ) : (
              <ScrollView
                // A height in px, not a percentage of a parent that has none:
                // measured in Chromium, the list otherwise sized itself to its
                // content and spilled the results over the thread behind it.
                style={styles.results}
                keyboardShouldPersistTaps="handled"
              >
                {found.map((hit) => (
                  <ListItem
                    // The cursor, never `messageId`: a message the server wrote
                    // has no client id, and `null` is not a key.
                    key={hit.cursor}
                    title={hit.snippet}
                    supporting={`${t(
                      hit.role === 'user' ? 'chat.searchThreadYou' : 'chat.searchThreadAgent',
                    )} · ${hitDay(hit.createdAt, locale)}`}
                    onPress={() => onJump(hit)}
                  />
                ))}
              </ScrollView>
            )}
          </CardBody>
        </Card>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    insetInline: 0,
    top: 0,
    zIndex: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  column: { width: '100%', maxWidth: 768, alignSelf: 'center' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  search: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  hint: { paddingHorizontal: 4, paddingVertical: 16 },
  results: { marginTop: 8, maxHeight: 384 },
});
