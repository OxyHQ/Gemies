import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { activeAgentFor } from '@/features/agents/model/active-agent';
import { useEditorFollowsAgent } from '@/features/agents/runtime/use-editor-follows-agent';
import { useConversations } from '@gemies/sdk/runtime';
import { resolveProfileColor } from '@oxy.so/bloom/color-presets';
import { BloomColorScope } from '@oxy.so/bloom/theme';
import { usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { View } from 'react-native';

/**
 * The app takes the colour of the agent you are with. On an agent's thread, or a chat that belongs
 * to one, the whole app — sidebar, header, panel and dialogs — is Bloom's theme in that agent's
 * colour: its Oxy account's `User.color`, the same preset its avatar is painted in. Everywhere else
 * the scope is a no-op and the app keeps its preset, because `BloomColorScope` with neither a preset
 * nor a seed inherits its parent (and so does an account colour Bloom does not know).
 *
 * It sits inside the conversation runtime, which is where the conversation list the chat's agent
 * is looked up in comes from.
 */
export function AgentThemeScope({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: agents } = useMyAgents();
  const { data } = useConversations();
  const conversations = useMemo(
    () => data?.pages.flatMap((page) => page.conversations) ?? [],
    [data],
  );
  const agent = useMemo(
    () => activeAgentFor({ pathname, agents: agents ?? [], conversations }),
    [pathname, agents, conversations],
  );
  // A preset key, or the seed of a legacy hex an old account still holds.
  const color = useMemo(() => resolveProfileColor(agent?.color), [agent?.color]);
  // The editor beside the chat edits the agent you are with: another agent's chat, another agent.
  useEditorFollowsAgent(agent?._id);

  return (
    <BloomColorScope colorPreset={color?.colorPreset} seed={color?.seed} asChild>
      <View className="flex-1 web:z-auto">{children}</View>
    </BloomColorScope>
  );
}
