import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export interface GrantSwitchRowProps {
  /** What the row grants, drawn before its name: a connector's logo, a platform's mark. */
  leading?: ReactNode;
  label: string;
  /** A second line: which account it is, or what the grant means here. */
  detail?: string | null;
  checked: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  onCheckedChange: (granted: boolean) => void;
  /** The first row of a list draws no divider above it. */
  first?: boolean;
}

/**
 * One grant of a connected account to a gemie, as a switch: the row every grant list draws, so a
 * connector granted in a gemie's editor and a WhatsApp granted in Settings read and behave the same.
 */
export function GrantSwitchRow({
  leading,
  label,
  detail,
  checked,
  disabled,
  accessibilityLabel,
  onCheckedChange,
  first,
}: GrantSwitchRowProps) {
  const styles = useStyles();
  return (
    <View style={[styles.row, !first && styles.divider]}>
      {leading}
      <View style={styles.text}>
        <Text variant="body-2-regular" numberOfLines={1}>
          {label}
        </Text>
        {detail ? (
          <Text variant="body-2-regular" style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={accessibilityLabel}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  text: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 2 },
  detail: { color: t.mutedForeground },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingInlineEnd: 10,
  },
  divider: { borderTopWidth: 1, borderColor: t.border },
}));
