import {
  useAgentMemoryDocument,
  useAgentMemoryFiles,
  useAgentMemoryMutations,
  type AgentMemoryFile,
} from '@/features/agents/runtime/use-agent-memory';
import { errorStatus } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { Admonition } from '@oxy.so/bloom/admonition';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { View } from 'react-native';

/** This section's own strings. */
const K = 'agents.editor.memory';

/** The files an agent keeps, the index first. */
function sortFiles(files: AgentMemoryFile[]): AgentMemoryFile[] {
  return [...files].sort((a, b) =>
    a.path === 'MEMORY.md' ? -1 : b.path === 'MEMORY.md' ? 1 : a.path.localeCompare(b.path),
  );
}

/** The person's unsaved edit and the version of the file (its hash) it was started from. */
interface MemoryEdit {
  draft: string;
  baseHash: string;
}

/**
 * One file: read, edit in place, save with the hash the edit started from, or forget. A clean
 * file follows what the agent holds; an edit is the person's until they save or discard it, so
 * neither a refetch nor a conflicting save ever replaces it. When the file changed under the
 * edit, the newest version is shown beside it: the person saves theirs over it or discards it.
 */
function MemoryFileRow({
  agentId,
  path,
  divider,
  onForget,
}: {
  agentId: string;
  path: string;
  divider: boolean;
  onForget: (path: string) => void;
}) {
  const { t } = useTranslation();
  const { data: document, isPending, refetch } = useAgentMemoryDocument(agentId, path);
  const { save } = useAgentMemoryMutations(agentId);
  const [edit, setEdit] = useState<MemoryEdit | null>(null);

  const dirty = document !== undefined && edit !== null && edit.draft !== document.content;
  // The agent (or another device) wrote to the file after the edit began.
  const conflict = dirty && edit.baseHash !== document.hash;

  const handleChange = (text: string) => {
    if (!document) return;
    // Back to what the file holds: clean again, following the file.
    if (text === document.content) setEdit(null);
    else setEdit((current) => ({ draft: text, baseHash: current?.baseHash ?? document.hash }));
  };

  const handleSave = async () => {
    if (!document || !edit) return;
    try {
      // Without a conflict this is the hash the edit started from; with one, the newest
      // version the person is looking at, so their save lands on top of it knowingly.
      await save.mutateAsync({ path, content: edit.draft, expectedHash: document.hash });
      await refetch();
      setEdit(null);
      toast.success(t('settings.saveSuccess'));
    } catch (error) {
      // 409: the file changed meanwhile. Fetch its newest version; the edit stays and the
      // conflict notice shows both.
      if (errorStatus(error) === 409) {
        await refetch();
        return;
      }
      toast.error(t('settings.saveFailed'));
    }
  };

  return (
    <AgentCreatorField label={path} multiline divider={divider}>
      {isPending || !document ? (
        <SettingsSkeletonRows control="none" rows={2} />
      ) : (
        <View className="gap-2">
          <Textarea
            accessibilityLabel={path}
            size="sm"
            value={edit?.draft ?? document.content}
            onChangeText={handleChange}
            autoResize
            rows={3}
            maxRows={12}
          />
          {conflict ? (
            <Admonition type="warning" size="sm">
              {[t(`${K}.changedMeanwhile`), document.content].join('\n\n')}
            </Admonition>
          ) : null}
          <View className="flex-row justify-end">
            <ButtonGroup size="sm" accessibilityLabel={path}>
              <ButtonGroupItem onPress={handleSave} disabled={!dirty || save.isPending}>
                {conflict ? t(`${K}.saveMineOverIt`) : t('settings.saveButton')}
              </ButtonGroupItem>
              {conflict ? (
                <ButtonGroupItem onPress={() => setEdit(null)} disabled={save.isPending}>
                  {t(`${K}.discardMine`)}
                </ButtonGroupItem>
              ) : null}
              <ButtonGroupItem
                iconOnly
                leadingIcon={RiDeleteBinLine}
                accessibilityLabel={`${t(`${K}.forget`)} ${path}`}
                onPress={() => onForget(path)}
              />
            </ButtonGroup>
          </View>
        </View>
      )}
    </AgentCreatorField>
  );
}

/**
 * What the agent remembers about the person: its own files, not Alia's memory. Editable, and
 * forgettable one file at a time or all at once.
 */
export function AgentMemorySection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: files, isPending } = useAgentMemoryFiles(agentId);
  const { forget } = useAgentMemoryMutations(agentId);

  const handleForget = async (path?: string) => {
    const ok = await confirm({
      title:
        path === undefined
          ? t(`${K}.forgetAllTitle`, { name })
          : t(`${K}.forgetFileTitle`, { path }),
      description: t(`${K}.forgetDescription`, { name }),
      confirmLabel: t(`${K}.forget`),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await forget.mutateAsync(path);
      toast.success(t(`${K}.forgotten`));
    } catch {
      toast.error(t(`${K}.forgetFailed`));
    }
  };

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      {isPending ? (
        <SettingsSkeletonRows control="none" rows={2} />
      ) : !files?.length ? (
        <AgentCreatorField label={t(`${K}.title`)} divider={false}>
          <Text variant="body-2-regular">{t(`${K}.empty`, { name })}</Text>
        </AgentCreatorField>
      ) : (
        <>
          {sortFiles(files).map((file, index) => (
            <MemoryFileRow
              key={file.path}
              agentId={agentId}
              path={file.path}
              divider={index > 0}
              onForget={handleForget}
            />
          ))}
          <AgentCreatorField label={t(`${K}.forgetAll`)}>
            <Button
              size="sm"
              appearance="outline"
              tone="danger"
              leadingIcon={RiDeleteBinLine}
              onPress={() => handleForget()}
            >
              {t(`${K}.forgetAllTitle`, { name })}
            </Button>
          </AgentCreatorField>
        </>
      )}
    </AgentCreatorSection>
  );
}
