import { agentDisplayName } from '@/features/agents/model/identity';
import { useAnswerShare } from '@/features/agents/runtime/use-agent-detail-actions';
import { useSetAgentStatus } from '@/features/agents/runtime/use-agent-thread-actions';
import { useDeleteAgent } from '@/features/agents/runtime/use-agents';
import { useOpenAgentEditor } from '@/features/chat/runtime/use-open-agent-editor';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import type { Agent } from '@/shared/contracts/agents';
import type { Space } from '@/shared/contracts/spaces';
import { useTranslation } from '@/shared/i18n/use-translation';
import { agentChatRoute, agentDetailsRoute } from '@/shared/routing/agent-address';
import { MoreTrigger } from '@/shell/sidebar-menus';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { usePathname, useRouter } from 'expo-router';
import React from 'react';

/** The radio value for "in no space"; space ids are never empty. */
const NONE = '';

/** What a gemie row's menu does; one set for the whole sidebar, so every row's menu stays memoised. */
export interface GemieRowHandlers {
  openProfile: (agent: Agent) => void;
  edit: (agent: Agent) => void;
  openComputer: (agent: Agent) => void;
  share: (agent: Agent) => void;
  /** Paused is `idle`: the API cancels what it is running and it takes no hires until resumed. */
  setPaused: (agent: Agent, paused: boolean) => void;
  askDelete: (agent: Agent) => void;
  /** `null` takes the gemie out of its space. */
  move: (agent: Agent, spaceId: string | null) => void;
}

/** Whether a path is one of this gemie's screens: its thread, its page or its editor. */
export function isGemiePath(pathname: string, agent: Agent): boolean {
  const thread = agentChatRoute(agent);
  return thread !== null && (pathname === thread || pathname.startsWith(`${thread}/`));
}

/**
 * The handlers behind every gemie row's menu. Each one is what the gemie's own page already does
 * (`use-agent-detail-actions.ts`, `agent-detail.tsx`): no action here exists only in the sidebar.
 */
export function useGemieRowHandlers(
  move: (agent: Agent, spaceId: string | null) => void,
): GemieRowHandlers {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const openAgentEditor = useOpenAgentEditor();
  const answerShare = useAnswerShare();
  const setStatus = useSetAgentStatus();
  const deleteAgent = useDeleteAgent();

  // Read inside `askDelete` without making it change on every navigation.
  const pathnameRef = React.useRef(pathname);
  pathnameRef.current = pathname;

  const openProfile = React.useCallback(
    (agent: Agent) => {
      const page = agentDetailsRoute(agent);
      if (page !== null) router.push(page);
    },
    [router],
  );

  const edit = React.useCallback((agent: Agent) => openAgentEditor(agent._id), [openAgentEditor]);

  const openComputer = React.useCallback(
    (agent: Agent) =>
      router.push({ pathname: '/(app)/agents/computer/[id]', params: { id: agent._id } }),
    [router],
  );

  const share = React.useCallback((agent: Agent) => void answerShare(agent), [answerShare]);

  const { mutateAsync: writeStatus } = setStatus;
  const setPaused = React.useCallback(
    async (agent: Agent, paused: boolean) => {
      try {
        await writeStatus({ agentId: agent._id, status: paused ? 'idle' : 'active' });
      } catch {
        toast.error(t('agents.statusUpdateFailed'));
      }
    },
    [writeStatus, t],
  );

  const { mutateAsync: removeAgent } = deleteAgent;
  const askDelete = React.useCallback(
    async (agent: Agent) => {
      const name = agentDisplayName(agent);
      const ok = await confirm({
        title: t('agents.deleteTitle', { name }),
        description: t('agents.deleteDescription', { name }),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await removeAgent(agent);
      } catch {
        toast.error(t('agents.deleteFailed'));
        return;
      }
      // Leave its screens and close its editor: they would show a gemie that is gone.
      const ui = useUIStore.getState();
      if (ui.rightPanel === 'editor' && ui.editedAgentId === agent._id) ui.setRightPanel(null);
      if (isGemiePath(pathnameRef.current, agent)) router.replace('/(app)');
      toast.success(t('agents.deleted', { name }));
    },
    [removeAgent, router, t],
  );

  return React.useMemo(
    () => ({ openProfile, edit, openComputer, share, setPaused, askDelete, move }),
    [openProfile, edit, openComputer, share, setPaused, askDelete, move],
  );
}

/**
 * A gemie row's ⋯ menu: its page, edit it, its computer, share it, move it to a space, pause or
 * resume it, delete it. Only what applies to this gemie is offered: editing, pausing and deleting
 * are its owner's; a gemie connected from a computer (`external`) has no editor, computer or
 * schedule here; one with no handle has no page to open or share.
 */
export const GemieRowActions = React.memo(function GemieRowActions({
  agent,
  isOwner,
  spaces,
  handlers,
}: {
  agent: Agent;
  isOwner: boolean;
  spaces: readonly Space[];
  handlers: GemieRowHandlers;
}) {
  const { t } = useTranslation();
  const name = agentDisplayName(agent);
  const hasPage = agentDetailsRoute(agent) !== null;
  const external = Boolean(agent.external);
  const hasComputer = !external && (agent.capabilityGrants ?? []).includes('computer');
  const canPause = isOwner && !external && agent.status !== 'offline';
  const paused = agent.status === 'idle';
  return (
    <DropdownMenu>
      <MoreTrigger label={t('agents.options', { name })} />
      <DropdownMenuContent minWidth={200}>
        {hasPage ? (
          <DropdownMenuItem onPress={() => handlers.openProfile(agent)}>
            {t('agents.viewProfile')}
          </DropdownMenuItem>
        ) : null}
        {isOwner && !external ? (
          <DropdownMenuItem onPress={() => handlers.edit(agent)}>
            {t('agents.edit')}
          </DropdownMenuItem>
        ) : null}
        {hasComputer ? (
          <DropdownMenuItem onPress={() => handlers.openComputer(agent)}>
            {t('agents.computer.open')}
          </DropdownMenuItem>
        ) : null}
        {hasPage ? (
          <DropdownMenuItem onPress={() => handlers.share(agent)}>
            {t('agents.share')}
          </DropdownMenuItem>
        ) : null}
        {spaces.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('spaces.moveToSpace')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent side="right" align="start">
              <DropdownMenuRadioGroup
                value={agent.spaceId ?? NONE}
                onValueChange={(value) => handlers.move(agent, value || null)}
              >
                <DropdownMenuRadioItem value={NONE}>{t('spaces.noSpace')}</DropdownMenuRadioItem>
                {spaces.map((space) => (
                  <DropdownMenuRadioItem key={space.id} value={space.id}>
                    {space.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {canPause ? (
          <DropdownMenuItem onPress={() => handlers.setPaused(agent, !paused)}>
            {t(paused ? 'agents.resume' : 'agents.pause')}
          </DropdownMenuItem>
        ) : null}
        {isOwner ? <DropdownMenuSeparator /> : null}
        {isOwner ? (
          <DropdownMenuItem tone="danger" onPress={() => handlers.askDelete(agent)}>
            {t('agents.delete')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
