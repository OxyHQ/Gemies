import { Image } from '@/shared/ui/image';

/**
 * The first frame of the Gemies welcome animation (clover, frog and paperclip, on transparent).
 * The web draws the animation itself (`gemies-welcome-art.web.tsx`); here, until the native app
 * ships, the still frame.
 */
const GEMIES_WELCOME_FRAME = require('../../../assets/images/gemies-welcome.webp');

/** The welcome art, square, at the size the intro gives it. */
export function GemiesWelcomeArt({ size }: { size: number }) {
  return (
    <Image
      source={GEMIES_WELCOME_FRAME}
      accessible={false}
      contentFit="contain"
      style={{ width: size, height: size }}
    />
  );
}
