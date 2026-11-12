import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { OxyServer } from '@oxy.so/core/server';
import {
  GEMIES_APPLICATION_ID,
  GEMIES_SERVICE_AUDIENCE,
  createGemieTransportForOxyService,
} from '@gemies/server';

/** This process's one Oxy client: Alia's integrations workload (oxy ADR 0026/0049). */
export const oxy = new OxyServer({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  applicationId: GEMIES_APPLICATION_ID,
  serviceIdentity: 'when-anonymous',
  expectedAudience: GEMIES_SERVICE_AUDIENCE,
  workloadCredentials: createAwsWorkloadCredentialProvider(),
});
let apiTransport: ReturnType<typeof createGemieTransportForOxyService> | undefined;
export function aliaApiFetch(input: string, init?: RequestInit): Promise<Response> {
  apiTransport ??= createGemieTransportForOxyService(oxy, {
    baseURL: process.env.API_BASE_URL || 'http://localhost:4150',
  });
  return apiTransport.fetch(input, init);
}
