import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { useCallback } from 'react';
import { useGemieAvatarHost } from './gemie-avatar-photo-host';

/**
 * The gemie's own picture for its Telegram bot (ADR 0037), read back as a JPEG when the bot is set
 * up. Native: Skia reads the off-screen view. The web reads the SVG instead
 * (`gemie-avatar-photo.web.tsx`), so Skia never reaches the web bundle. `capture` answers `null`
 * when it cannot be read (the bot then keeps its own picture, and the editor says so).
 */
export function useGemieAvatarPhoto(look: { character: AvatarCharacter; color: string | null }) {
  const { host, element } = useGemieAvatarHost(look);

  const capture = useCallback(async (): Promise<string | null> => {
    try {
      const { ImageFormat, makeImageFromView } = await import('@shopify/react-native-skia');
      // Skia reads any native view; its parameter type predates function components.
      const image = await makeImageFromView(
        host as unknown as Parameters<typeof makeImageFromView>[0],
      );
      return image?.encodeToBase64(ImageFormat.JPEG, 90) ?? null;
    } catch {
      return null;
    }
  }, [host]);

  return { element, capture };
}
