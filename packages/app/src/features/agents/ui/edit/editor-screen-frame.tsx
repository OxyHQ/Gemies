import { AiChatContainer } from '@oxy.so/bloom/ai-chat';
import type { ReactNode } from 'react';

/**
 * The agent editor as a screen (`/@pepe/edit`, `/agents/edit/<id>`): the shell's surface, with the
 * editor's own header (undo, title, close) as the only one. `header` replaces the container's
 * shared bar, which Bloom draws when it is absent, so an empty one is "no bar here".
 *
 * The screen draws this itself because its route is in `(own-header)`: the layout lets those
 * through bare (`app/(app)/_layout.tsx`).
 */
export function EditorScreenFrame({ children }: { children: ReactNode }) {
  return <AiChatContainer header={<></>}>{children}</AiChatContainer>;
}
