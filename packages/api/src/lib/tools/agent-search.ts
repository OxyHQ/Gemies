/**
 * Agent Search Tool
 * Finds gemies to write to (`sendMessage`, ADR 0041): the person's own — the gemies they made and
 * the agents they connected, found by name — and the published, active agents of the directory.
 *
 * Only agents that open where the person is: an agent Oxy confines to an app is
 * not offered outside it (ADR 0021), and one whose answer Oxy could not give is
 * left out rather than offered.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { searchActiveAgents } from '../../db/agents/agentRepository.js';
import { agentOpensOn } from '../agent-availability.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { gemiesMatching, listOwnGemies } from './own-gemies.js';

const MAX_RESULTS = 10;

/**
 * @param oxyUserId the person the turn is for: their own gemies are searched first
 * @param surfaceApplicationId the app the person is in (`lib/app-surface.ts`), or `null`
 */
export const createSearchAgentsTool = (oxyUserId: string, surfaceApplicationId: string | null) =>
  tool({
    description:
      "Find gemies and agents by name or by what they do: the person's own gemies and the agents they connected (a coding agent such as Claude Code on their computer) first, then specialist agents of the directory (tagline, category, tags). Write to one with `sendMessage`. If none fits, handle the task yourself.",

    inputSchema: z.object({
      query: z
        .string()
        .describe('Search query describing what kind of agent or task you need help with'),
    }),

    execute: async ({ query }) => {
      try {
        const [own, found] = await Promise.all([
          listOwnGemies(oxyUserId).then((gemies) => gemiesMatching(gemies, query)),
          searchActiveAgents(getDb(), query, MAX_RESULTS),
        ]);
        const opens = await Promise.all(
          found.map((agent) => agentOpensOn(agent, surfaceApplicationId)),
        );
        const ownIds = new Set(own.map((gemie) => gemie.id));
        const directory = found.filter(
          (agent, index) => opens[index] === 'reachable' && !ownIds.has(agent.id),
        );
        const agents = [
          ...own.map((gemie) => ({
            id: gemie.id,
            name: gemie.name,
            handle: gemie.handle,
            tagline: gemie.tagline,
            theirs: true,
            ...(gemie.external ? { external: true } : {}),
          })),
          ...directory,
        ].slice(0, MAX_RESULTS);

        // The query is model output derived from the user's prompt.
        log.general.info({ resultCount: agents.length }, 'Agent search completed');

        return { agents, count: agents.length };
      } catch (error: unknown) {
        log.general.error({ err: error }, 'Agent search failed');
        return { agents: [], count: 0, error: getErrorMessage(error) };
      }
    },
  });
