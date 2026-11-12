import { Image } from '@/shared/ui/image';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

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

/** The mark and the name, for the signed-out page. */
export function GemiesLogo({ size = 28 }: { size?: number }) {
  return (
    <View className="flex-row items-center gap-2" accessibilityRole="header">
      <GemiesMark size={size} />
      <Text className="font-semibold text-foreground" style={{ fontSize: size * 0.8 }}>
        Gemies
      </Text>
    </View>
  );
}
