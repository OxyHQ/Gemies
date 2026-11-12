import { Image } from '@/shared/ui/image';

/** The Gemies app icon (three gemies on green), the same image as the favicon and the PWA icon. */
const GEMIES_ICON = require('../../../assets/images/gemies-icon.png');

/** The Gemies mark: the app icon, at the size the caller needs. */
export function GemiesMark({ size = 28 }: { size?: number }) {
  return (
    <Image
      source={GEMIES_ICON}
      accessible={false}
      contentFit="contain"
      style={{ width: size, height: size }}
    />
  );
}

/** The three gemies (clover, frog and paperclip) on transparent, for the welcome intro. */
const GEMIES_WELCOME_ART = require('../../../assets/images/gemies-welcome.png');

/** The welcome art: the Gemies trio, large, where the intro of a new person begins. */
export function GemiesWelcomeArt({ size }: { size: number }) {
  return (
    <Image
      source={GEMIES_WELCOME_ART}
      accessible={false}
      contentFit="contain"
      style={{ width: size, height: size }}
    />
  );
}
