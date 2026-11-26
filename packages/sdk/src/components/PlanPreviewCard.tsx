import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { RiListCheck3 } from '@oxy.so/bloom/icons/RiListCheck3';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { planPreviewEnter } from '../animations';
import { useLabels } from '../lib/labels';
import type { PlanStep } from '../types';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface PlanPreviewCardProps {
  steps: PlanStep[];
}

/**
 * The plan the agent shows before it works. It is only shown: the agent does not wait on it, and
 * nobody is asked to approve it.
 */
export function PlanPreviewCard({ steps }: PlanPreviewCardProps) {
  const styles = useStyles();
  const labels = useLabels();
  const { colors } = useTheme();

  return (
    <Animated.View entering={planPreviewEnter} style={styles.card}>
      <Card appearance="outline">
        <CardHeader>
          <View style={styles.titleRow}>
            <RiListCheck3 width={16} height={16} fill={colors.icon} />
            <CardTitle>{labels.planTitle}</CardTitle>
          </View>
        </CardHeader>
        <CardBody>
          {steps.map((step, index) => (
            <Item
              // A plan has no ids and its steps never reorder: the position is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              density="compact"
              leading={<Text style={styles.stepNumber}>{index + 1}</Text>}
              title={step.action}
              subtitle={step.description || undefined}
            />
          ))}
        </CardBody>
      </Card>
    </Animated.View>
  );
}

const useStyles = createTokenStyles((t) => ({
  card: { marginVertical: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepNumber: {
    width: 20,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: 700,
    color: t.mutedForeground,
    lineHeight: 16,
  },
}));
