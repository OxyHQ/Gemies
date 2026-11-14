/**
 * The Oxy app catalogues Alia can run tools from: the registry read, the
 * compile of each capability into a validated tool, the 60 s cache and the
 * last valid catalogue of each app (kept while its registration does not parse). Pure
 * discovery; nothing here authorizes or calls an app (`oxy-invocation.ts`).
 */
import { createHash } from 'node:crypto';
import {
  capabilityCatalogBindingSchema,
  canonicalCapabilityJson,
  type CapabilityCatalogBinding,
  type AppCapabilityCatalog,
  type CatalogTool,
  type ResourceRef,
} from '@oxy.so/contracts';
import { jsonSchema, type Schema } from 'ai';
import { jsonObjectSchemaToZod } from '@oxy.so/mcp';
import {
  type CatalogActorType,
  catalogToolAllowsActor,
  parseRegistryCatalog,
} from './oxy-catalog-actors.js';
import { log } from '../logger.js';
import { oxy } from '../oxy.js';
import { TTLCache } from '../ttl-cache.js';
import { OxyAuthorityUnavailableError } from './oxy-call-context.js';

export function agency() {
  return oxy.agency;
}

/**
 * `@oxy.so/mcp` builds its validators with its own Zod major, so only the shape
 * Alia uses is named here.
 */
interface InputValidator {
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false; error: ValidationFailure };
}
interface ValidationFailure {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}

export interface CompiledTool {
  catalog: AppCapabilityCatalog;
  definition: CatalogTool;
  /**
   * The capability's input schema, EXACTLY as the app publishes it in the Oxy
   * registry, and the one thing the model is shown for this tool.
   *
   * It used to be a Zod rebuild of the schema (`jsonSchemaToZod`) that the AI
   * SDK turned back into JSON Schema. The rebuild dropped what it did not model
   * — `minimum`/`maximum`, `maxLength`, `pattern`, `format`,
   * `additionalProperties: false` (it became `passthrough`) — so the model was
   * told `limit` was any number and extra keys were fine, sent `limit: 500` to
   * Noted's `searchNotes`, and the app answered 400
   * `capability_input_schema_mismatch`. The app validates with
   * `jsonObjectSchemaToZod`; so does {@link CompiledTool.validator}, so a call
   * the app would refuse never leaves Alia.
   */
  inputSchema: Schema<Record<string, unknown>>;
  /** The app's own validator (`@oxy.so/mcp` `jsonObjectSchemaToZod`) over the same schema. */
  validator: InputValidator;
  catalogBinding: CapabilityCatalogBinding;
  internalCatalogBinding?: CapabilityCatalogBinding;
}
export interface CatalogDef {
  catalog: AppCapabilityCatalog;
  displayName: string;
  compiledTools: CompiledTool[];
}
export interface BoundTool {
  compiled: CompiledTool;
  resource: ResourceRef;
  suffix: string | null;
  /** Bound to the agent's own bot account rather than to the person's. */
  self?: boolean;
}

export const defsCache = new TTLCache<CatalogDef[]>({ ttlMs: 60_000, maxSize: 1 });
export const DEFS_KEY = 'catalogs';

export function appDisplayName(appId: string): string {
  return appId.length === 0 ? appId : `${appId.charAt(0).toUpperCase()}${appId.slice(1)}`;
}

/**
 * The last catalogue of each app that compiled, by app id.
 *
 * A registration that stops parsing (a newer contract, a bad publish) is not
 * the app leaving the registry: its last valid catalogue keeps serving until
 * the registration parses again, so a transient break never drops the app's
 * tools for a whole cache window. An app the registry no longer lists goes.
 */
const lastValidDefs = new Map<string, CatalogDef>();

async function loadCatalogDefs(): Promise<CatalogDef[]> {
  // Every app uses canonical authority discovery; only the reviewed Mention
  // binding selects MCP for the subsequent product invocation.
  const registrations = await agency()
    .serviceCatalogs()
    .catch(() => {
      throw new OxyAuthorityUnavailableError('Oxy catalogue authority unavailable');
    });
  const defs: CatalogDef[] = [];
  const listed = new Set<string>();
  const unreadable = new Set<string>();
  for (const registration of registrations) {
    const appId = registryAppId(registration);
    if (appId) listed.add(appId);
    try {
      const def = compileRegistration(registration);
      lastValidDefs.set(def.catalog.appId, def);
      defs.push(def);
    } catch (error: unknown) {
      // One app's catalogue that this Alia cannot read costs at most that
      // app's tools, never every other app's — and not even those while its
      // last valid catalogue is known.
      if (appId) unreadable.add(appId);
      log.general.error(
        { err: error, appId, keepingLastValid: appId ? lastValidDefs.has(appId) : false },
        'An Oxy capability catalogue does not parse',
      );
    }
  }
  for (const appId of unreadable) {
    const previous = lastValidDefs.get(appId);
    if (previous && !defs.some((def) => def.catalog.appId === appId)) defs.push(previous);
  }
  for (const appId of lastValidDefs.keys()) {
    if (!listed.has(appId)) lastValidDefs.delete(appId);
  }
  return defs;
}

type Registration = Awaited<ReturnType<ReturnType<typeof agency>['serviceCatalogs']>>[number];

function registryAppId(registration: { catalog?: unknown }): string | undefined {
  const catalog = registration.catalog;
  return typeof catalog === 'object' &&
    catalog !== null &&
    typeof (catalog as { appId?: unknown }).appId === 'string'
    ? (catalog as { appId: string }).appId
    : undefined;
}

function compileTool(
  catalog: AppCapabilityCatalog,
  definition: CatalogTool,
  catalogBinding: CapabilityCatalogBinding,
): CompiledTool {
  const validator: InputValidator = jsonObjectSchemaToZod(definition.inputSchema);
  return {
    catalog,
    definition,
    validator,
    inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema, {
      validate: (value) => {
        const parsed = validator.safeParse(value);
        return parsed.success
          ? { success: true, value: parsed.data as Record<string, unknown> }
          : { success: false, error: new Error(describeIssues(parsed.error)) };
      },
    }),
    catalogBinding,
    ...(catalog.internalTransport === 'mcp' ? { internalCatalogBinding: catalogBinding } : {}),
  };
}

/** What was wrong with a call's input, by argument, for the model to correct. */
function describeIssues(error: ValidationFailure): string {
  return error.issues
    .slice(0, 6)
    .map(
      (issue) =>
        `${issue.path.length ? issue.path.map(String).join('.') : 'input'}: ${issue.message}`,
    )
    .join('; ');
}

function compileRegistration(registration: Registration): CatalogDef {
  const catalog = parseRegistryCatalog(registration.catalog);
  const catalogBinding = capabilityCatalogBindingSchema.parse({
    registrationId: registration.id,
    version: registration.version,
    digest: registration.digest,
  });
  if (
    catalogBinding.version !== catalog.version ||
    catalogBinding.digest !==
      createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex')
  ) {
    throw new Error('Registry catalogue content mismatch');
  }
  return {
    catalog,
    displayName: appDisplayName(catalog.appId),
    compiledTools: catalog.tools
      .filter((definition) => definition.exposure.includes('internal'))
      .flatMap((definition) => {
        try {
          return [compileTool(catalog, definition, catalogBinding)];
        } catch (error: unknown) {
          // A schema the app's own validator cannot read is a tool nobody can
          // call correctly; it costs that tool, not the app's others.
          log.general.error(
            { err: error, appId: catalog.appId, tool: definition.name },
            'Skipping an Oxy capability tool whose input schema does not compile',
          );
          return [];
        }
      }),
  };
}

/**
 * Only the tools Oxy will authorize for `actorType` (catalogue `actors`). A
 * tool the actor can never run is not offered at all — Oxy would refuse it
 * with `tool_not_available_to_actor`, which the model can do nothing about.
 */
export function defsFor(defs: readonly CatalogDef[], actorType: CatalogActorType): CatalogDef[] {
  return defs.map((service) => ({
    ...service,
    compiledTools: service.compiledTools.filter((compiled) =>
      catalogToolAllowsActor(compiled.definition, actorType),
    ),
  }));
}

export function getCatalogDefs(): Promise<CatalogDef[]> {
  return defsCache.getOrLoad(DEFS_KEY, loadCatalogDefs);
}
