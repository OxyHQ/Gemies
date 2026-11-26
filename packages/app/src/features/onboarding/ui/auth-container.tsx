import type * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { KeyboardAwareScrollView } from '@/shared/platform/keyboard';

export interface AuthContainerProps {
  children: React.ReactNode;
}

/**
 * The column an auth-style page (sign-in help, invites, app authorization)
 * stands in: centred, 384 wide at most, scrolling above the keyboard.
 *
 * It paints nothing. The app layout's `AiChatContainer` owns the page surface
 * (background and corners), so this is layout only: a keyboard-aware scroller
 * and the centred column inside it.
 */
export function AuthContainer({ children }: AuthContainerProps) {
  return (
    <KeyboardAwareScrollView
      bottomOffset={20}
      style={styles.scroller}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.column}>{children}</View>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  column: { width: '100%', maxWidth: 384, gap: 24, alignSelf: 'center' },
});
