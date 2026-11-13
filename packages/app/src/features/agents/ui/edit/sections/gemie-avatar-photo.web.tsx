import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { useCallback } from 'react';
import { GEMIE_PHOTO_SIZE, useGemieAvatarHost } from './gemie-avatar-photo-host';

// Web facade: this file deliberately imports NOTHING from `@shopify/react-native-skia`, not even a
// lazy `import()` — Metro would still emit it as a chunk and `scripts/check-web-bundle.mjs` would
// rightly fail the export. The web reads the avatar's SVG through a canvas instead.

/** Draw an SVG on a white square and answer it as a base64 JPEG. */
async function svgToJpeg(svg: SVGElement): Promise<string | null> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new XMLSerializer().serializeToString(svg),
  )}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = GEMIE_PHOTO_SIZE;
  canvas.height = GEMIE_PHOTO_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, GEMIE_PHOTO_SIZE, GEMIE_PHOTO_SIZE);
  context.drawImage(image, 0, 0, GEMIE_PHOTO_SIZE, GEMIE_PHOTO_SIZE);
  return canvas.toDataURL('image/jpeg', 0.9).split(',')[1] ?? null;
}

/**
 * The gemie's own picture for its Telegram bot (ADR 0037), read back as a JPEG from the avatar's
 * SVG. `capture` answers `null` when it cannot be read.
 */
export function useGemieAvatarPhoto(look: { character: AvatarCharacter; color: string | null }) {
  const { host, element } = useGemieAvatarHost(look);

  const capture = useCallback(async (): Promise<string | null> => {
    try {
      const svg = (host.current as unknown as HTMLElement | null)?.querySelector('svg');
      return svg ? await svgToJpeg(svg) : null;
    } catch {
      return null;
    }
  }, [host]);

  return { element, capture };
}
