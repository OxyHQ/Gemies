import { readAgentCharacter } from '@gemies/sdk';
import { AgentAvatar, type AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { type ComponentRef, useCallback, useRef } from 'react';
import { Platform, View } from 'react-native';

/** Telegram shows a bot's photo at up to 640px, and takes a static one only as a JPEG. */
const SIZE = 640;

/** Draw an SVG on a white square and answer it as a base64 JPEG (web). */
async function svgToJpeg(svg: SVGElement): Promise<string | null> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new XMLSerializer().serializeToString(svg),
  )}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, SIZE, SIZE);
  context.drawImage(image, 0, 0, SIZE, SIZE);
  return canvas.toDataURL('image/jpeg', 0.9).split(',')[1] ?? null;
}

/**
 * The gemie's own picture for its Telegram bot (ADR 0037): its character, in its colour, drawn off
 * screen by the same renderer as everywhere else and read back as a JPEG when the bot is set up.
 * `capture` answers `null` when it cannot be read (the bot then keeps its own picture, and the
 * editor says so).
 */
export function useGemieAvatarPhoto(look: { character: AvatarCharacter; color: string | null }) {
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
        size={SIZE}
        portrait
        paused
      />
    </View>
  );

  const capture = useCallback(async (): Promise<string | null> => {
    try {
      if (Platform.OS === 'web') {
        const svg = (host.current as unknown as HTMLElement | null)?.querySelector('svg');
        return svg ? await svgToJpeg(svg) : null;
      }
      const { ImageFormat, makeImageFromView } = await import('@shopify/react-native-skia');
      // Skia reads any native view; its parameter type predates function components.
      const image = await makeImageFromView(
        host as unknown as Parameters<typeof makeImageFromView>[0],
      );
      return image?.encodeToBase64(ImageFormat.JPEG, 90) ?? null;
    } catch {
      return null;
    }
  }, []);

  return { element, capture };
}
