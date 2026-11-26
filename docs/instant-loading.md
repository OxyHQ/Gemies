# Carga instantánea

Ninguna pantalla de Alia espera detrás de un spinner ni de un «Loading...». Lo que una pantalla
espera tiene forma (filas, una cabecera, un hilo) y se dibuja con el esqueleto de Bloom, así que
la pantalla ocupa su sitio desde el primer fotograma y nada se mueve cuando llegan los datos.

## Reglas

1. **Un esqueleto con la forma del contenido**, nunca un spinner ni un texto de espera. Los
   esqueletos son compartidos: `src/shared/ui/skeletons` (filas de lista, filas de ajustes, detalle,
   estado de tarjeta de acceso, tarjetas, líneas) y `ThreadSkeleton` del SDK (un hilo de
   conversación). Se componen con `@oxy.so/bloom/skeleton`; no se copian por pantalla.
2. **El spinner es para acciones**: un paso que se está ejecutando, una llamada que conecta, un
   mensaje que se está contestando. Nunca para una pantalla ni para una lista. Las excepciones
   están enumeradas, con su motivo, en `__tests__/no-loading-screens.test.ts`; una nueva es una
   afirmación de que la espera es una acción y se dice allí.
3. **La pantalla se pinta antes de saber qué es.** Un hilo de agente (`/@handle`) dibuja el chat con
   el agente que el sidebar ya conoce y el esqueleto del hilo (`ConversationScreen loading`); el
   compositor solo espera para enviar.
4. **Nada de textos de carga**: no existen claves `*.loading` ni cadenas «Loading»/«Cargando» sobre
   pantallas. El esqueleto se anuncia a los lectores de pantalla con la etiqueta localizada de
   Bloom.
5. **Los datos de una pantalla son una lectura que sirve lo que ya hay**, nunca un `fetch` desde
   un `useEffect` a un `useState`: una respuesta de bloom-data en el almacén de la cuenta (lo que
   el sidebar dibuja: `useMyAgents`, `useSpaces` y lo del SDK) o una consulta de React Query (el
   resto, en memoria). Las dos sirven lo que ya hay (esta sesión o el disco de la cuenta) y lo
   refrescan detrás. Una consulta que dibuja una pantalla no lleva `gcTime: 0`, que la tiraría al
   desmontarse, y una pantalla que espera dibuja su esqueleto, nunca `null`.

## Por qué es rápido de verdad

- **Los datos de la cuenta viven en su almacén de bloom-data**, que abre el `OxyProvider` de
  `@oxy.so/services` 15 (un fichero SQLite por cuenta en un dispositivo, una base IndexedDB en la
  web): lo que ve primero quien vuelve se pinta desde el disco al abrir y se refresca detrás.
  - **Del SDK** (`@gemies/sdk` 10, que los persiste él con las cotas que tenía la caché de la app):
    las conversaciones del sidebar, sus colecciones (carpetas, proyectos, fijadas, favoritas), el
    perfil de un agente, el hilo de un agente (`gemieThread`, lo que abre `/@handle` al instante)
    y los últimos mensajes de las conversaciones recientes (las 20 escritas más recientemente, de
    cada una sus últimos 40 mensajes terminados, como mucho 150 KB, solo texto y nunca un turno que
    se está emitiendo o que el servidor aún no guardó).
  - **De la app** (`src/shared/api/account-data.ts`): los agentes de la persona (`myAgents`) y sus
    espacios (`spaces`), que dibuja el sidebar. Son respuestas de bloom-data persistidas en el
    almacén de la cuenta; quien los cambia (un evento en tiempo real, una edición, un mensaje
    enviado) escribe o los marca obsoletos ahí mismo.
  - Otra cuenta del dispositivo nunca los lee (cada cuenta tiene su almacén: Alia, Mention y
    Commons comparten UID en Android, así que la clave es la cuenta, no la app), un cambio de
    cuenta abre el almacén de la siguiente antes de publicarla y cerrar sesión lo borra. No se
    persisten la facturación ni nada firmado.
- **La forma de lo persistido tiene versión**: `persist: { version: PERSISTED_DATA_VERSION }`
  (`src/shared/api/persisted-data-version.ts`). El almacén tira las filas de un tipo cuando cambia
  su versión. Si cambia un tipo de lo persistido, `__tests__/persisted-data-version.test.ts` falla
  hasta que se sube la versión: un olvido es un test rojo, no una pantalla rota. Lo del SDK lo
  versiona el SDK.
- **Todo lo demás es React Query y vive en memoria**: el cliente es de la app
  (`src/shared/api/query-client.ts`, montado encima del `OxyProvider`), y un cambio de cuenta
  cancela y reinicia todas sus consultas y olvida las escrituras que esperaban la red
  (`useAccountLifecycle`): ninguna se repite como la cuenta siguiente. El catálogo de agentes, la
  ficha de un agente y las skills se piden de nuevo en cada arranque.
- **Prefetch por intención**: pasar el ratón o pulsar una fila del sidebar lee su conversación
  (`usePrefetchConversation`) y, en un agente con el que ya se habló, su hilo
  (`usePrefetchAgentThread`). `GET /agents/thread/:username` CREA el hilo la primera vez, así que
  nunca se pide por adelantado de un agente sin conversación.
- **Resultados previos a la vista** (`placeholderData: keepPreviousData`) al cambiar de búsqueda o
  categoría en el catálogo de skills.
- **Facturación, créditos y derechos** se piden de nuevo en cada montaje (`staleTime: 0`) y nunca
  se escriben a disco (un estado de pago no se muestra de la semana pasada), pero la última
  respuesta de esta sesión se dibuja mientras tanto, en vez de un esqueleto en cada visita.
- **Conectores, Seguridad y Estilo de escritura** se leen en memoria: los conectores son del SDK
  (`useConnections`, en el almacén de la cuenta), los leen el compositor de cada chat y Ajustes y
  se piden una vez; Seguridad y Estilo de escritura son consultas (`queryKeys.audit`,
  `.writingStyle`).
- **Lo que se abre a demanda va en su propio trozo**: `preloadable()` y `usePreloadWhenIdle()`
  (`src/shared/platform/preloadable.ts`). El editor de agentes (con el creador de Bloom, ~400 KB)
  se carga al abrirlo y se descarga antes, cuando la página está ociosa con sesión.

## Comprobación

`__tests__/no-loading-screens.test.ts` lee el código y falla ante un `ActivityIndicator`, un
`<Loading text=…>`, una clave `*.loading`, una cadena «Loading» en los idiomas o un import de
`Loading` fuera de la lista de acciones. `__tests__/screens-draw-from-cache.test.ts` falla ante un
`useEffect` que pide datos, un `gcTime: 0` o un `return null` mientras carga, salvo las excepciones
que enumera con su motivo.
