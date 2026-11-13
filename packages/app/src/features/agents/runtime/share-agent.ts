import {
  deliverShareLink,
  type ShareLinkOutcome,
} from '@/features/chat/runtime/conversation-share';
import { agentDisplayName } from '@/features/agents/model/identity';
import type { Agent } from '@/shared/contracts/agents';
import { WEB_ORIGIN } from '@/shared/platform/web-origin';
import { agentDetailsRoute } from '@/shared/routing/agent-address';

/**
 * What "Share" hands over for a gemie: its page on the Gemies domain, its name and who it is.
 *
 * The link pointed at `alia.app`, which is not the product's domain, so every shared gemie was a
 * dead link. And `agent.name` is nullable (Oxy's lookup fails open), which printed "null — …"; the
 * display name never is. A gemie with no handle has no page, so there is nothing to share (`null`).
 */
export function agentShareContent(
  agent: Pick<Agent, '_id' | 'name' | 'handle' | 'tagline'>,
): { url: string; title: string; text: string } | null {
  const page = agentDetailsRoute(agent);
  if (page === null) return null;
  const title = agentDisplayName(agent);
  return {
    url: `${WEB_ORIGIN}${page}`,
    title,
    text: agent.tagline ? `${title} — ${agent.tagline}` : title,
  };
}

/**
 * Share a gemie's page the way this platform shares a link (`deliverShareLink`): the system sheet
 * on a phone and in a browser that has one, the clipboard in a browser that has none. React
 * Native's `Share` alone did nothing at all on a desktop browser without a share sheet.
 * `unavailable` is a gemie with no page to link to.
 */
export async function shareAgent(
  agent: Pick<Agent, '_id' | 'name' | 'handle' | 'tagline'>,
): Promise<ShareLinkOutcome | 'unavailable'> {
  const content = agentShareContent(agent);
  if (content === null) return 'unavailable';
  return deliverShareLink(content.url, content.title, content.text);
}
