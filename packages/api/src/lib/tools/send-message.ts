/**
 * `sendMessage` — a gemie writes to another gemie (ADR 0041), as a person writes to someone.
 *
 * The message goes into the conversation the two gemies have for this person (opened the first
 * time) and the tool returns at once: nothing here waits for an answer. The other gemie answers in
 * its own turn, and its answer reaches the gemie that wrote as a turn of its own, in this same chat
 * with the person, where it writes again or tells the person what it found (`lib/chat/gemies`).
 *
 * ## Reach is the ordinary rule
 *
 * A gemie may write to exactly the gemies the person could open themselves (`canReachAgent`, with
 * the app they are in), narrowed by the writer's `agent` grant when it names instances, and, for a
 * member of a space, cut to its peers and Alia (ADR 0028): being a member is the permission.
 *
 * ## The recipient's gates apply to what the turn carries
 *
 * The recipient never receives the turn's attachments, but the writer can put their content in the
 * message, so the recipient's feature gates are checked, and spent, against them before anything is
 * sent — exactly as if the person had opened the recipient with them (ADR 0020 §6).
 */

import { randomUUID } from 'node:crypto';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { getDb } from '../../db/index.js';
import { canReachAgent } from '../agent-account.js';
import {
  checkGatedParts,
  gatedPartsFor,
  spendGatedParts,
  type GatedPart,
} from '../agent-features.js';
import { agentPromptName, attachAgentIdentity, type HydratedAgent } from '../agent-identity.js';
import { gemieInfo, sendGemieMessage } from '../chat/gemies/send.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { gemiesNamed, listOwnGemies, type OwnGemie } from './own-gemies.js';

export const SEND_MESSAGE_TOOL = 'sendMessage';

/**
 * The next message of a chain, from the gemie that wrote first, as its conversation stores it
 * (`lib/chat/gemies/engine.ts`): once per turn, and only while the chain has room.
 */
export type GemieChainDelivery = (
  text: string,
) => Promise<
  { readonly conversationId: string; readonly chainId: string } | { readonly error: string }
>;

/**
 * Where a message goes. From the person's chat (`startsIn`, that chat's id) it starts a chain the
 * writer continues in that chat; from a continuing turn (`continues`) it is the next message of the
 * chain that turn belongs to, to the one gemie it talks to.
 */
export type MessageDelivery =
  | { readonly startsIn: string }
  | { readonly continues: GemieChainDelivery };

export interface SendMessageOptions {
  readonly person: {
    readonly oxyUserId: string;
    readonly accessToken?: string;
    readonly isDirectSession: boolean;
    readonly taskId?: string;
    /** The app the person is in, by its verified app assertion (ADR 0021), or `null`. */
    readonly surfaceApplicationId: string | null;
  };
  /** The gemie whose turn this is: the one that writes. */
  readonly from: HydratedAgent;
  readonly delivery: MessageDelivery;
  /** When the writer may reach only named gemies (an instanced `agent` grant, a space): those ids. */
  readonly allowedAgentIds?: readonly string[];
  /** The turn's attachments: the recipient's gates apply to them. */
  readonly attachments?: readonly GatedPart[];
}

/** The person's gemies this one may write to: their own, external agents included. */
async function writableGemies(options: SendMessageOptions): Promise<OwnGemie[]> {
  return (await listOwnGemies(options.person.oxyUserId)).filter(
    (gemie) =>
      gemie.id !== options.from._id &&
      (options.allowedAgentIds === undefined || options.allowedAgentIds.includes(gemie.id)),
  );
}

/** The person's gemies, named in the description so the model knows whom it can write to. */
function ownGemiesLine(gemies: readonly OwnGemie[]): string {
  if (gemies.length === 0) return '';
  return `\n\nThe person's own gemies and connected agents you can write to:\n${gemies
    .map(
      (gemie) =>
        `- ${gemie.id} — ${gemie.name}${gemie.handle ? ` (@${gemie.handle})` : ''}${
          gemie.external ? " [an agent on the person's computer]" : ''
        }: ${gemie.tagline}`,
    )
    .join('\n')}`;
}

/**
 * The gemie `to` names: an id as it is, else one of the person's own gemies by @handle or name.
 * A name that fits several is refused with their names, never guessed.
 */
async function resolveRecipient(
  to: string,
  options: SendMessageOptions,
): Promise<{ id: string } | { error: string }> {
  if ((await findAgentById(getDb(), to)) !== null) return { id: to };
  const named = gemiesNamed(await writableGemies(options), to);
  if (named.length === 1) return { id: named[0]!.id };
  if (named.length > 1) {
    return {
      error: `Several gemies are called that: ${named.map((gemie) => `${gemie.name} (${gemie.id})`).join(', ')}. Ask the person which one.`,
    };
  }
  return { error: 'Gemie not found' };
}

/** Why the recipient's gate refuses what the turn carries, in words the writer acts on; or null. */
async function gateRefusal(
  recipient: HydratedAgent,
  options: SendMessageOptions,
): Promise<string | null> {
  const gated = gatedPartsFor(recipient, options.attachments ?? []);
  if (gated.length === 0) return null;
  const person = {
    accountId: options.person.oxyUserId,
    // The person's own bearer only: without one no lane can be authorized.
    accessToken: options.person.isDirectSession ? options.person.accessToken : undefined,
    taskId: options.person.taskId,
    runId: randomUUID(),
  };
  const refused =
    (await checkGatedParts(recipient, person, gated)) ??
    (await spendGatedParts(recipient, person, gated));
  if (refused === null) return null;
  log.general.info(
    { agentId: recipient._id, feature: refused.feature, code: refused.code },
    'A message to a gemie was refused by its feature gate',
  );
  return refused.code === 'feature_entitlement_required'
    ? `That gemie needs an upgrade in its app before it can work with the person's ${refused.feature.slice('attachments.'.length)}. Tell the person; do not pass the attachment's content to it another way.`
    : 'The app that unlocks that gemie’s attachments could not be asked. Try again later.';
}

export async function buildSendMessageTool(options: SendMessageOptions): Promise<ToolSet> {
  if (options.allowedAgentIds !== undefined && options.allowedAgentIds.length === 0) return {};
  const { delivery } = options;
  const own =
    'continues' in delivery
      ? ''
      : await writableGemies(options).then(ownGemiesLine, (error: unknown) => {
          log.general.warn(
            { err: error },
            "Could not list the person's own gemies for sendMessage",
          );
          return '';
        });
  const from = {
    agent: options.from,
    info: gemieInfo(options.from, agentPromptName(options.from)),
  };

  return {
    [SEND_MESSAGE_TOOL]: tool({
      description:
        'continues' in delivery
          ? 'Write to the gemie you are talking to again, in your conversation with it. Its answer reaches you afterwards. Write once per turn, with everything it needs.'
          : "Talk to the person's other gemies and to the agents they connected (a coding agent such as Claude Code or Codex on their computer), and to public gemies: write to one in your conversation with it, as a person writes to someone. When the person asks you to talk to, ask or tell another gemie or agent, this is how. It does not answer here: when it answers, you read its answer and continue — write to it again, or tell the person what you found. It cannot see this chat, so put everything it needs in `text`. After writing, tell the person briefly whom you wrote to and why; do not wait or guess its answer. " +
            'Find others with `searchAgents` (for example Sindi for anything about housing).' +
            own,
      inputSchema: z.object({
        to: z
          .string()
          .min(1)
          .describe(
            'The gemie to write to: its id, its @handle, or its name as the person says it',
          ),
        text: z
          .string()
          .min(1)
          .describe('The message, with everything the gemie needs to answer it'),
      }),
      execute: async ({ to, text }) => {
        try {
          const resolved = await resolveRecipient(to, options);
          if ('error' in resolved) return { error: resolved.error };
          const { id } = resolved;
          if (
            id === options.from._id ||
            (options.allowedAgentIds !== undefined && !options.allowedAgentIds.includes(id))
          ) {
            return { error: 'That is not a gemie you can write to' };
          }
          const found = await findAgentById(getDb(), id);
          if (
            found === null ||
            (await canReachAgent(found, {
              oxyUserId: options.person.oxyUserId,
              accessToken: options.person.accessToken,
              surfaceApplicationId: options.person.surfaceApplicationId,
            })) !== 'reachable'
          ) {
            return { error: 'Gemie not found' };
          }
          const recipient = await attachAgentIdentity(found);
          const refused = await gateRefusal(recipient, options);
          if (refused !== null) return { error: refused };
          const info = gemieInfo(recipient, agentPromptName(recipient));
          const sent =
            'continues' in delivery
              ? await delivery.continues(text)
              : await sendGemieMessage({
                  userId: options.person.oxyUserId,
                  from,
                  to: { agent: recipient, info },
                  text,
                  originConversationId: delivery.startsIn,
                  accessToken: options.person.accessToken,
                  surfaceApplicationId: options.person.surfaceApplicationId,
                });
          if ('error' in sent) return { error: sent.error };
          return {
            status: 'sent',
            conversationId: sent.conversationId,
            // The chain its events carry, so the person's chat follows this exchange and no other.
            chainId: sent.chainId,
            from: from.info,
            to: info,
          };
        } catch (error: unknown) {
          log.general.error({ err: error, to }, 'sendMessage failed');
          return { error: getErrorMessage(error) };
        }
      },
    }),
  };
}
