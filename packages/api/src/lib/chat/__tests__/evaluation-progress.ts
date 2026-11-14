/** Synthetic evaluation telemetry only. A partial record never establishes acceptance. */
export function emitEvaluationProgress(
  suite: 'agent-reaction-participation-evaluation' | 'group-participation-evaluation',
  record: {
    label: string;
    iteration: number;
    passed: boolean;
    latencyMs: number;
    errorCategory?: string;
  },
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
) {
  if (
    !/^[a-z0-9-]{1,120}$/.test(record.label) ||
    !Number.isInteger(record.iteration) ||
    record.iteration < 1 ||
    record.iteration > 50 ||
    typeof record.passed !== 'boolean' ||
    !Number.isFinite(record.latencyMs) ||
    record.latencyMs < 0 ||
    record.latencyMs > 3_600_000
  )
    throw new Error('Invalid synthetic evaluation progress');
  const errorCategory =
    record.errorCategory === undefined
      ? undefined
      : [
            'TimeoutError',
            'AbortError',
            'ZodError',
            'AI_NoObjectGeneratedError',
            'AI_APICallError',
            'AI_TypeValidationError',
            'unclassified',
          ].includes(record.errorCategory)
        ? record.errorCategory
        : 'unclassified';
  // Pick fields explicitly: never spread tool output, prompts, headers or provider exceptions.
  write(
    `${JSON.stringify({
      kind: 'evaluation-case-progress',
      suite,
      label: record.label,
      iteration: record.iteration,
      passed: record.passed,
      latencyMs: record.latencyMs,
      ...(errorCategory === undefined ? {} : { errorCategory }),
    })}\n`,
  );
}
