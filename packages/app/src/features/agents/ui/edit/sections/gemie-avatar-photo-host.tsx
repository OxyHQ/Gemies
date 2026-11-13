import { readAgentCharacter } from '@gemies/sdk';
import { AgentAvatar, type AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { type ComponentRef, useRef } from 'react';
import { View } from 'react-native';

/** Telegram shows a bot's photo at up to 640px, and takes a static one only as a JPEG. */
export const GEMIE_PHOTO_SIZE = 640;

/**
 * The gemie's character, in its colour, drawn off screen by the same renderer as everywhere else,
 * for `useGemieAvatarPhoto` to read back. Each platform reads it its own way
 * (`gemie-avatar-photo.tsx`, `gemie-avatar-photo.web.tsx`).
 */
export function useGemieAvatarHost(look: { character: AvatarCharacter; color: string | null }) {
  const host = useRef<ComponentRef<typeof View>>(null);
  const element = (
    <View
      ref={host}
      collapsable={false}
      pointerEvents="none"
      aria-hidden
      className="absolute -left-[10000px] top-0 h-[640px] w-[640px] bg-white"
    >
      <AgentAvatar
        character={readAgentCharacter(look.character, look.color)}
        size={GEMIE_PHOTO_SIZE}
        portrait
        paused
      />
    </View>
  );
  return { host, element };
}
