import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';
import type { ReactNode } from 'react';
import { View } from 'react-native';

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
  return (
    <View
      className={`flex-row items-center gap-2.5 py-2.5 pe-2.5 ${first ? '' : 'border-t border-border'}`}
    >
      {leading}
      <View className="flex-1 gap-0.5">
        <Text variant="body-2-regular" numberOfLines={1}>
          {label}
        </Text>
        {detail ? (
          <Text variant="body-2-regular" className="text-text-secondary" numberOfLines={1}>
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
