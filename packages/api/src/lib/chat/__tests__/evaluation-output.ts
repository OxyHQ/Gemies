/** Read and filter while the child is active. Partial progress never replaces the final summary. */
export async function readEvaluationOutput(
  stream: ReadableStream<Uint8Array>,
  suite: { kind: string; expectedSamples: number },
  repetitions: number,
  emit: (value: Record<string, unknown>) => void,
) {
  const decoder = new TextDecoder();
  let pending = '',
    total = 0,
    summaryFound = false,
    suitePassed = false;
  const seen = new Set();
  const progressKeys = new Set([
    'kind',
    'suite',
    'label',
    'iteration',
    'passed',
    'latencyMs',
    'errorCategory',
  ]);
  const errors = new Set([
    'TimeoutError',
    'AbortError',
    'ZodError',
    'AI_NoObjectGeneratedError',
    'AI_APICallError',
    'AI_TypeValidationError',
    'unclassified',
  ]);
  const summaryKeys = new Set([
    'kind',
    'repetitions',
    'acceptanceRepetitions',
    'samples',
    'passed',
    'failed',
    'modelReferences',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'completedModelRuns',
    'nativeFailedRuns',
    'selectorFailedScenarios',
    'toolModelSteps',
    'toolInferenceAttempts',
    'selectorInvocations',
    'balanceMutations',
    'nativePersistence',
    'records',
  ]);
  const consume = (line: string) => {
    const clean = line.trim();
    if (!clean.startsWith('{')) return;
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(clean);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      value = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (value.kind === 'evaluation-case-progress') {
      if (
        Object.keys(value).some((key) => !progressKeys.has(key)) ||
        value.suite !== suite.kind ||
        typeof value.label !== 'string' ||
        !/^[a-z0-9-]{1,120}$/.test(value.label) ||
        typeof value.passed !== 'boolean' ||
        typeof value.iteration !== 'number' ||
        !Number.isInteger(value.iteration) ||
        value.iteration < 1 ||
        value.iteration > repetitions ||
        typeof value.latencyMs !== 'number' ||
        !Number.isFinite(value.latencyMs) ||
        value.latencyMs < 0 ||
        value.latencyMs > 3600000 ||
        (value.errorCategory !== undefined &&
          (typeof value.errorCategory !== 'string' || !errors.has(value.errorCategory)))
      )
        throw new Error('Invalid evaluation progress');
      const key = `${value.label}:${value.iteration}`;
      if (seen.has(key) || seen.size >= suite.expectedSamples)
        throw new Error('Duplicate or excess evaluation progress');
      seen.add(key);
      emit(value);
      return;
    }
    if (value.kind !== suite.kind) return;
    if (
      summaryFound ||
      Object.keys(value).some((key) => !summaryKeys.has(key)) ||
      value.balanceMutations !== false
    )
      throw new Error('Invalid evaluation summary');
    summaryFound = true;
    suitePassed = value.samples === suite.expectedSamples && value.failed === 0;
    emit(value);
  };
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > 16 * 1024 * 1024) throw new Error('Evaluation output exceeds bound');
    pending += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length > 1024 * 1024) throw new Error('Evaluation line exceeds bound');
      consume(line);
    }
    if (pending.length > 1024 * 1024) throw new Error('Evaluation line exceeds bound');
  }
  pending += decoder.decode();
  if (pending) consume(pending);
  return { summaryFound, suitePassed, progressCount: seen.size };
}

/** Drain stderr without retaining or publishing exceptions, provider output or headers. */
export async function drainEvaluationErrors(stream: ReadableStream<Uint8Array>) {
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > 16 * 1024 * 1024) throw new Error('Evaluation stderr exceeds bound');
  }
}
