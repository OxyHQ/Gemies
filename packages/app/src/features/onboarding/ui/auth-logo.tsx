import { View, StyleSheet } from 'react-native';
import { GemiesMark } from '@/shared/ui/gemies-mark';

/** The Gemies mark, centred above an auth-style page's content. */
export function AuthLogo() {
  return (
    <View style={styles.container}>
      <GemiesMark size={64} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center' },
});
