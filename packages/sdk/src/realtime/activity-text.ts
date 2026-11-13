import { useLabels } from '../lib/labels';
import { type ActorActivityEntry, useConversationActivity } from './activity';

/** The words for what the busiest actor is doing, or `null` when nobody is doing anything. */
export function useConversationActivityText(
  conversationId: string | null | undefined,
): string | null {
  const activity = useConversationActivity(conversationId);
  const labels = useLabels();
  return activityText(activity, labels.activity);
}

const RANK: Record<ActorActivityEntry['state'], number> = { thinking: 1, writing: 2, tool: 3 };

/** The busiest entry, said once: "Pepe is typing…" (one), "Pepe is typing…" for the first of several. */
export function activityText(
  activity: readonly ActorActivityEntry[],
  say: (name: string | null, state: ActorActivityEntry['state']) => string,
): string | null {
  let top: ActorActivityEntry | undefined;
  for (const entry of activity) if (!top || RANK[entry.state] > RANK[top.state]) top = entry;
  return top ? say(top.name, top.state) : null;
}
