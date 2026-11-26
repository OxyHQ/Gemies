import { useState } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { Chip } from '@oxy.so/bloom/chip';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { EmptyState } from '@/shared/ui/empty-state';
import { ListRowsSkeleton } from '@/shared/ui/skeletons';
import { Muted } from '@oxy.so/bloom/typography';
import { AgentDetailSection } from '@/features/agents/ui/detail/agent-detail-section';
import { BrowserLiveView } from '@/features/agents/ui/computer/browser-live-view';
import { ComputerActivity } from '@/features/agents/ui/computer/computer-activity';
import { WorkspaceFiles } from '@/features/agents/ui/computer/workspace-files';
import {
  useAgentComputer,
  useAppActive,
  useBrowserScreenshot,
  useComputerActions,
  useComputerReceipts,
  useWorkspaceFiles,
} from '@/features/agents/runtime/use-agent-computer';
import { errorMessage } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useIsLargeScreen } from '@/shared/platform/use-is-large-screen';
import { useScreenOnShow } from '@/shared/platform/use-screen-on-show';

/**
 * The agent's computer, as the person it works for sees it: its browser live
 * (and theirs to take over for a login), its `/workspace`, and what it
 * recently ran. Only ever the caller's own computer with this agent.
 */
export function AgentComputer({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const isLargeScreen = useIsLargeScreen();
  const onShow = useScreenOnShow();
  const appActive = useAppActive();
  const live = onShow && appActive;
  const [path, setPath] = useState('/workspace');
  const [actionError, setActionError] = useState<string | null>(null);

  const computer = useAgentComputer(agentId, live);
  const browserOpen = computer.data?.browser.state === 'open';
  const screenshot = useBrowserScreenshot(agentId, live && browserOpen);
  const receipts = useComputerReceipts(agentId, live);
  const running = computer.data?.computer.state === 'running';
  const files = useWorkspaceFiles(agentId, path, Boolean(running));
  const actions = useComputerActions(agentId);

  const busy =
    actions.input.isPending ||
    actions.control.isPending ||
    actions.navigate.isPending ||
    actions.open.isPending;
  const report = (error: unknown) =>
    setActionError(t('agents.computer.browser.actionFailed', { reason: errorMessage(error) }));
  const run =
    <T,>(
      mutate: (
        value: T,
        options: { onError: (error: unknown) => void; onSuccess: () => void },
      ) => void,
    ) =>
    (value: T) => {
      setActionError(null);
      mutate(value, { onError: report, onSuccess: () => setActionError(null) });
    };

  if (computer.isPending) {
    return (
      <Skeleton.Region style={styles.loading}>
        <Skeleton.Box width="100%" height={220} borderRadius={12} />
        <ListRowsSkeleton rows={3} lines={1} />
      </Skeleton.Region>
    );
  }

  if (computer.isError || !computer.data) {
    const status = (computer.error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <EmptyState
        title={status === 404 ? t('agents.computer.unavailable') : t('agents.computer.loadFailed')}
      />
    );
  }

  const { browser, granted } = computer.data;
  const state = computer.data.computer.state;

  return (
    <ScrollView style={styles.fill} showsVerticalScrollIndicator={false} testID="agent-computer">
      <View style={[styles.page, isLargeScreen && styles.widePage]}>
        <View style={styles.stack}>
          <Muted>{t('agents.computer.subtitle')}</Muted>
          <View style={styles.row}>
            <Chip size="lg">{t(`agents.computer.state.${state}`)}</Chip>
          </View>
          {!granted ? <Muted>{t('agents.computer.notGranted')}</Muted> : null}
        </View>

        <AgentDetailSection title={t('agents.computer.browser.title')}>
          <BrowserLiveView
            browser={browser}
            screenshot={screenshot.data}
            screenshotFailed={screenshot.isError}
            busy={busy}
            error={actionError}
            onInput={run(actions.input.mutate)}
            onControl={run(actions.control.mutate)}
            onNavigate={run(actions.navigate.mutate)}
            onOpen={run(actions.open.mutate)}
          />
        </AgentDetailSection>

        <AgentDetailSection title={t('agents.computer.files.title')}>
          <WorkspaceFiles
            running={Boolean(running)}
            path={path}
            listing={files.data}
            loading={files.isFetching}
            starting={actions.start.isPending}
            onOpenDirectory={setPath}
            onStart={() => actions.start.mutate()}
          />
        </AgentDetailSection>

        <AgentDetailSection title={t('agents.computer.activity.title')}>
          <ComputerActivity receipts={receipts.data} />
        </AgentDetailSection>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 16, padding: 16 },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  page: { width: '100%', gap: 24, padding: 16 },
  widePage: { maxWidth: 960 },
  stack: { gap: 8 },
  row: { flexDirection: 'row' },
});
