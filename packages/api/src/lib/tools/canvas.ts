import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'crypto';

/**
 * The canvas: content drawn for the person rather than written in the reply.
 *
 * `deck` and `dashboard` are whole artifacts a surface opens on their own (Astro opens
 * every report, deck and dashboard in a tab of its own, with comments and exports). Their
 * shapes, and those of a chart and a table, are validated here so a surface never receives
 * one it cannot draw: a chart with fewer values than labels, a table row with fewer cells
 * than headers. A model that sends a malformed one is told what was wrong and calls again.
 */
export const CANVAS_TYPES = [
  'chart',
  'table',
  'code',
  'form',
  'image',
  'markdown',
  'artifact',
  'deck',
  'dashboard',
] as const;

const chartShape = z.object({
  chartType: z.enum(['bar', 'line', 'pie']),
  labels: z.array(z.string()).min(1).max(200),
  datasets: z
    .array(z.object({ label: z.string(), values: z.array(z.number()) }))
    .min(1)
    .max(12),
});

/** A value per label: a chart pads a short series with zeros, which reads as real data. */
function oneValuePerLabel(chart: z.infer<typeof chartShape>, ctx: z.RefinementCtx) {
  chart.datasets.forEach((dataset, index) => {
    if (dataset.values.length !== chart.labels.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['datasets', index, 'values'],
        message: `needs ${chart.labels.length} values, one per label; it has ${dataset.values.length}`,
      });
    }
  });
}

const tableShape = z.object({
  headers: z.array(z.string()).min(1),
  rows: z.array(z.array(z.string())).max(500),
});

/** A cell per header: a table draws whatever a row holds, so a short or long row misaligns it. */
function oneCellPerHeader(table: z.infer<typeof tableShape>, ctx: z.RefinementCtx) {
  table.rows.forEach((row, index) => {
    if (row.length !== table.headers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', index],
        message: `needs ${table.headers.length} cells, one per header; it has ${row.length}`,
      });
    }
  });
}

const chartData = chartShape.superRefine(oneValuePerLabel);
const tableData = tableShape.superRefine(oneCellPerHeader);

const deckData = z.object({
  slides: z
    .array(
      z.object({
        title: z.string().min(1),
        subtitle: z.string().optional(),
        bullets: z.array(z.string()).max(12).optional(),
        body: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1)
    .max(60),
});

const dashboardData = z.object({
  widgets: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('stat'),
          label: z.string(),
          value: z.string(),
          delta: z.string().optional(),
        }),
        chartShape
          .extend({ kind: z.literal('chart'), title: z.string().optional() })
          .superRefine(oneValuePerLabel),
        tableShape
          .extend({ kind: z.literal('table'), title: z.string().optional() })
          .superRefine(oneCellPerHeader),
        z.object({ kind: z.literal('text'), title: z.string().optional(), content: z.string() }),
      ]),
    )
    .min(1)
    .max(40),
});

const SHAPES: Partial<Record<(typeof CANVAS_TYPES)[number], z.ZodType>> = {
  chart: chartData,
  table: tableData,
  deck: deckData,
  dashboard: dashboardData,
};

/** The canvas tool's name, as the pipeline grants it and a turn's tool calls carry it. */
export const CANVAS_TOOL = 'canvas';

export const canvasTool = tool({
  description:
    'Show rich content the person can open and export: a report (markdown), slide deck, dashboard, chart, table, code, form or image. Not for a simple text answer. To revise one, call again with the same title and type.',
  inputSchema: z.object({
    type: z.enum(CANVAS_TYPES),
    title: z.string(),
    data: z
      .any()
      .describe(
        'chart: { chartType: "bar"|"line"|"pie", labels, datasets: [{ label, values }] }, one value per label. table: { headers, rows }, one cell per header. code: { language, code }. form: { fields }. image: { url, alt? }. markdown: { content }. artifact: { content, language? }. deck: { slides: [{ title, subtitle?, bullets?, body?, notes? }] }. dashboard: { widgets: [{ kind: "stat", label, value, delta? } | { kind: "chart", title?, chartType, labels, datasets (one value per label) } | { kind: "table", title?, headers, rows (one cell per header) } | { kind: "text", title?, content }] }',
      ),
  }),
  execute: async ({ type, title, data }) => {
    const shape = SHAPES[type];
    if (shape) {
      const parsed = shape.safeParse(data);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          error: `The ${type} was not drawn: ${issue ? `${issue.path.join('.') || 'data'}: ${issue.message}` : 'its data is invalid'}. Send it again in the shape the tool describes.`,
        };
      }
      data = parsed.data;
    }
    return {
      id: randomUUID(),
      type,
      title,
      data,
      message: 'Canvas component created',
    };
  },
});
