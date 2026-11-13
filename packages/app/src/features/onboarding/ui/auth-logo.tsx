import { View } from 'react-native';
import { GemiesMark } from '@/shared/ui/gemies-mark';

/** The Gemies mark, centred above an auth-style page's content. */
export function AuthLogo() {
  return (
    <View className="items-center">
      <GemiesMark size={64} />
    </View>
  );
}
