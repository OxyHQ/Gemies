# Reglas del repo para agentes

Reglas que rompen en silencio, con su porqué. `AGENTS.md` lleva el resumen
comprobable; aquí está el texto completo. Antes de tocar un área lee su doc
(índice en [`index.mdx`](./index.mdx)).

- **Tres papeles (ADR 0010):** Kaana = API de inferencia (solo modelos; las
  credenciales de proveedor viven allí). Oxy = plataforma + Oxy Console (TODAS
  las claves de API: Alia, Kaana, Mention). Alia = asistente con API de producto
  **permanente** (`/alia/chat` y `/v1/*`, un solo handler) que usan sus propias
  superficies (app, CLI), otras apps Oxy y terceros vía SDK.
- **Inferencia: `Gemies -> Kaana`**, también cuando habla el gemie Alia:
  `@kaana.ai/sdk` contra `https://kaana.ai/v1`, con el transporte compartido de
  `lib/kaana/transport.ts` y la identidad workload de Oxy de audiencia `kaana.ai`.
  Oxy no recibe el contenido de la inferencia. Kaana todavía le pide autorización
  y liquidación sin contenido: esa dependencia temporal no demuestra que la
  migración de facturación de Kaana ADR 0010 esté implementada. Nunca claves de
  proveedor, claves de Kaana ni firma de grants en Gemies — ADR 0001, enmienda
  2026-11-13. Las claves externas conservan su propio payer y autoridad.
- **Alia no emite ni acepta claves propias.** `alia_sk_*` está retirado: la API
  lo rechaza (`credential_retired`) y sus tablas no existen. La clave de Oxy
  Console usa el contrato app-only de core4.4 publicado/adoptado con scopes
  explícitos; aceptación positiva Console pendiente — `machine-chat-contract.md`.
- **La gente elige niveles de potencia, no modelos (ADR 0014; ADR 0012):** Alia no tiene
  modelos propios. En la UI el usuario elige un nivel de potencia de Oxy —
  `auto` (por defecto), `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra` —
  y Kaana escoge el modelo disponible dentro de la política autorizada; nunca una lista de modelos por nombre.
  Por API, un `model` exacto `publisher/model` del catálogo de Kaana (o
  `local/...`) sigue valiendo para agentes fijados y llamadas de fondo. Sin
  perfiles `route:*` ni alias propios. Cero ids de modelo en código o env y
  cero listas curadas: destacados, por defecto, utilitario y voz se calculan —
  `model-abstraction.mdx`.
- **Nombres de modelo y publisher sí se muestran.** El operador que lo sirve
  (Groq, Cerebras, OpenRouter…) y los ids de deployment siguen ocultos en la
  superficie de producto (respuestas, errores, UI, analítica).
- **Apps de Oxy = primera parte.** Alia llega a las apps del usuario (Inbox…)
  sin paso de «conectar/autorizar». Un fallo de autoridad llega al modelo como
  `oxy_app_unavailable`, jamás como el motivo crudo de Oxy — `lib/tools/oxy-services.ts`.
- **Apps propias sin scopes/consent/niveles (ADR0022, Oxy ADR0049).** `oxy_*`
  usa la cuenta efectiva del requester, nunca la del dueño por sustitución;
  `self_*` sólo la cuenta bot con operador verificado. Tareas e hijos conservan
  el task id de Oxy del requester original, no su bearer. Servicios propios sólo
  workload; claves/OAuth externos conservan su autoridad limitada.
- **Dónde abre un agente lo dice Oxy (ADR 0021).** `canReachAgent` exige `surfaceApplicationId`,
  la app de la aserción `X-Oxy-App-Assertion` verificada en `lib/app-surface.ts` y nada más; un
  agente confinado no abre sin ella. Una respuesta de Oxy ilegible nunca es «en cualquier sitio».
- **Toda tarea tiene actor; Alia por defecto.** Sin `actorSelection` es
  `{ mode: 'fixed', agentId: ALIA_GEMIE_ID }`: nunca exijas otro gemie para una tarea. Un gemie con
  `task_authority = 'standing'` (Alia) la corre con autoridad permanente de Oxy en la cola
  `alia-tasks` — `proactive-intelligence.md`.
- **Alia es un gemie (ADR 0034).** Una fila `agents` (`ALIA_GEMIE_ID`); lo que la distingue es
  configuración: `memory_store = 'nilo'`, `reach = 'person'`, `mailbox = false`,
  `task_authority = 'standing'` y sin grant `computer`. Decide por esos atributos, nunca por su id
  ni por un `agentId` nulo. El único sitio que habla el lane `{ type: 'alia' }` de Oxy es
  `lib/gemie-oxy-actor.ts` (y el cliente de Oxy en `tools/oxy-services.ts`); el wire público aún
  escribe a Alia como sin `agentId` (`publicAgentId`).
- **La conversación es del SDK (ADR 0018).** El hilo, sus tarjetas, el panel de pensamiento, el
  compositor con su selector de nivel y la llamada de voz los dibuja `GemieChatContent`
  (`packages/sdk`), el mismo que monta el bottom sheet. La app solo pone lo suyo (sidebar,
  right panel, layout, rutas, callbacks de host) por props y slots; no copies un componente de
  conversación a `packages/app`. `one-thread.test.tsx` lo comprueba.
- **Memoria por actor.** Un turno de agente nunca recibe la memoria de Alia ni
  sus herramientas (`saveUserMemory`…); el agente usa `agent_memory_documents`.
- **Un fallo de inferencia es un error tipado** (`failTurn`), antes o después de
  emitir texto; jamás un mensaje de relleno con `finish_reason: "stop"` —
  `chat-runtime.mdx`.
- **Runtime: Bun** para la API y el control de GemiesOS (imagen
  `oven/bun`, CMD `bun ...`); `packages/integrations` y la imagen workspace
  siguen en Node. Todo one-shot que arranca la imagen de la API nombra `bun`
  (`MIGRATION_RUNTIME`, comando post-rollout, canary): un `bun`
  contra una imagen Node muere — `src/__tests__/dockerfileRuntime.test.ts`.
- **Upgrades WebSocket: un solo enrutador** (`lib/websocket-upgrades.ts`). Socket.IO sirve su ruta con
  `destroyUpgrade: false`; voz, el relay de agentes externos y cualquier ruta nueva son un `WebSocketRoute`; lo demás
  es 404. Nunca otro `server.on('upgrade')`: en Bun, engine.io cerraba al segundo todo socket ajeno.
  `test:bun-runtime` lo prueba en el runtime real.
- `Relay` es un nombre retirado; el único origen de Kaana es `https://kaana.ai`.
- **Shows** (podcasts en Syra): la ruta acuña un ticket de ingesta de un solo
  uso y el worker lo canjea; jamás un token de servicio. `title`/`topic` son
  overrides opcionales y por eso admiten NULL; `topic` se envía entero —
  `shows.mdx`.
- **Ninguna pantalla espera detrás de un spinner ni de un «Loading...»** (`instant-loading.md`):
  lo que se espera se dibuja con el esqueleto de Bloom, con la forma del contenido
  (`src/shared/ui/skeletons`, `ThreadSkeleton` del SDK). El spinner es solo para acciones en
  curso; `__tests__/no-loading-screens.test.ts` lo hace cumplir.
- Actores: `actors.mdx`. Agentes y su ordenador: `agents.md`. Tareas y
  avisos: `proactive-intelligence.md`. Memoria: `memory-system.md`.
  Chat/SSE: `chat-runtime.mdx`. Despliegue: `deployment.md`.
  Migración: `migration/`.
