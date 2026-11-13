/**
 * How a person files their conversations — folders, projects, pins, favourites — reaching every
 * surface of theirs as one durable `collections` frame carrying the whole snapshot
 * (`docs/realtime.mdx`). A snapshot rather than a diff: it is small, and a client that applies it
 * twice, or late, still shows exactly what the server holds.
 */

import { getDb } from '../../db/index.js';
import { readCollections, type CollectionsSnapshot } from '../../db/chat/collectionRepository.js';
import { log } from '../logger.js';
import { publishAccountEvent } from './publish.js';

/** Read the person's collections, publish them, and hand them back for the response. */
export async function publishCollections(oxyUserId: string): Promise<CollectionsSnapshot> {
  const snapshot = await readCollections(getDb(), oxyUserId);
  void publishAccountEvent(oxyUserId, 'collections', snapshot).catch((err: unknown) =>
    log.chat.warn({ err }, 'Could not publish collections'),
  );
  return snapshot;
}
