import {
  createEmfPublisherIfDeployed,
  type EmfPublisher,
  type MetricDefinition,
} from '@oxy.so/telemetry/metrics';

/**
 * Gemies' operational metrics, published to CloudWatch (`Gemies/Api`) through the shared Oxy EMF
 * publisher (`@oxy.so/telemetry/metrics`), like oxy-api and Mention.
 *
 * This was a hand-rolled Prometheus registry behind `GET /internal/metrics` that nothing scraped, so
 * every counter reset on each deploy and no history existed. EMF is aggregated in memory and written
 * once a minute to stdout, which the task's `awslogs` driver already ships: history with no agent,
 * sidecar or scraper. It is `null` off ECS (a laptop, CI, a test), where nothing is recorded.
 *
 * Every metric is ONE billed CloudWatch metric (dimension `Service` only) unless its definition names
 * a closed label set in `dimensionSets`; every other label is a free property of the log line, grouped
 * in Logs Insights.
 */
export const operationalMetrics: EmfPublisher | null = createEmfPublisherIfDeployed({
  namespace: 'Gemies/Api',
  service: 'alia',
});

export const LEGACY_STORAGE_READS: MetricDefinition = {
  name: 'LegacyStorageReads',
  unit: 'Count',
  kind: 'sum',
};

export const OXY_FILES_FALLBACK_WRITES: MetricDefinition = {
  name: 'OxyFilesFallbackWrites',
  unit: 'Count',
  kind: 'sum',
};

/** One read served from Alia's own bucket instead of Oxy Files. The durable count is `legacy_storage_reads`. */
export function legacyStorageReadRecorded(kind: string): void {
  operationalMetrics?.record(LEGACY_STORAGE_READS, 1, { Kind: kind });
}

/** A private-content write Oxy did not take, stored in the legacy bucket instead. */
export function privateContentFallbackRecorded(kind: string, reason: string): void {
  operationalMetrics?.record(OXY_FILES_FALLBACK_WRITES, 1, { Kind: kind, Reason: reason });
}

/** Flush the last interval and stop the timer, for graceful shutdown. */
export function stopOperationalMetrics(): void {
  operationalMetrics?.stop();
}
