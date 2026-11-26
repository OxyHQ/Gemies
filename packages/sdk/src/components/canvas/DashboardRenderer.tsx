import { Muted, Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { ChartRenderer } from './ChartRenderer';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TableRenderer } from './TableRenderer';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export type DashboardWidget =
  | { kind: 'stat'; label: string; value: string; delta?: string }
  | {
      kind: 'chart';
      title?: string;
      chartType: 'bar' | 'line' | 'pie';
      labels: string[];
      datasets: { label: string; values: number[] }[];
    }
  | { kind: 'table'; title?: string; headers: string[]; rows: string[][] }
  | { kind: 'text'; title?: string; content: string };

interface DashboardRendererProps {
  data: { widgets?: DashboardWidget[] };
}

/** A dashboard: its stats in a row, then its charts, tables and notes, each drawn by its own renderer. */
export function DashboardRenderer({ data }: DashboardRendererProps) {
  const styles = useStyles();
  const widgets = Array.isArray(data.widgets) ? data.widgets : [];
  const stats = widgets.filter(
    (w): w is Extract<DashboardWidget, { kind: 'stat' }> => w.kind === 'stat',
  );
  const rest = widgets.filter((w) => w.kind !== 'stat');
  return (
    <View style={styles.dashboard}>
      {stats.length > 0 && (
        <View style={styles.stats}>
          {stats.map((stat, i) => (
            <View key={i} style={styles.stat}>
              <Muted>{stat.label}</Muted>
              <Text variant="headline-semibold">{stat.value}</Text>
              {stat.delta ? <Muted>{stat.delta}</Muted> : null}
            </View>
          ))}
        </View>
      )}
      {rest.map((widget, i) => {
        switch (widget.kind) {
          case 'chart':
            return <ChartRenderer key={i} data={widget} title={widget.title} />;
          case 'table':
            return (
              <View key={i} style={styles.widget}>
                {widget.title ? <Text variant="body-semibold">{widget.title}</Text> : null}
                <TableRenderer data={widget} title={widget.title} />
              </View>
            );
          case 'text':
            return (
              <View key={i} style={styles.widget}>
                {widget.title ? <Text variant="body-semibold">{widget.title}</Text> : null}
                <MarkdownRenderer data={{ content: widget.content }} />
              </View>
            );
          default:
            return null;
        }
      })}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  dashboard: { gap: 12 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stat: {
    minWidth: 144,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    gap: 4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.popover,
    padding: 12,
  },
  widget: { gap: 8 },
}));
