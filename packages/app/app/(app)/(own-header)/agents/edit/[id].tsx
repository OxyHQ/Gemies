import { EditorScreenFrame } from '@/features/agents/ui/edit/editor-screen-frame';
import { AgentEditorSurface } from '@/features/agents/ui/edit/lazy-agent-editor';
import { useLocalSearchParams, useRouter } from 'expo-router';

/**
 * `/agents/edit/<id>` — the editor as a screen, for a phone, of a gemie with no handle to address
 * it by: Alia, whose Oxy account (and so her handle) does not exist yet (ADR 0034), opening with her
 * identity locked and the person's own accounts to manage (ADR 0035). A gemie with a handle opens
 * at `/@handle/edit`; this is the same editor (`AgentEditorLoader`).
 */
export default function EditAgentByIdScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toList = () => router.replace('/(app)/agents');

  return (
    <EditorScreenFrame>
      <AgentEditorSurface
        agentId={id}
        onClose={() => (router.canGoBack() ? router.back() : toList())}
        onBackToList={toList}
      />
    </EditorScreenFrame>
  );
}
