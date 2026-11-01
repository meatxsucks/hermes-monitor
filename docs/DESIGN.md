# hermes-monitor — ADR / Diseño de arquitectura

Estado: propuesto (sin implementar)
Fecha: 2026-10-31
Autor: agente architect (sesión Claude Code), para Matías Cruz

## 1. Contexto

Matías corre "Orión", un asistente personal 24/7 sobre **Hermes Agent** (NousResearch) con un
modelo local **Qwen3.6-35B-A3B** servido por `llama-server` (systemd `llm.service`, puerto 8081,
RTX 3060 Ti 8GB). Hermes gestiona dos canales de mensajería activos, Telegram y WhatsApp Cloud
API (webhook en el puerto 8090, expuesto a internet vía Tailscale Funnel fijo
`https://matias-pc.tail11b502.ts.net`), bajo el servicio `hermes-gateway.service`.

Problema real que motiva este proyecto (verificado en esta sesión):

- Latencias de minutos sin visibilidad de si Orión está pensando, colgado o caído. Se observó en
  `~/.hermes/logs/gateway.log` una respuesta real que tardó `time=424.1s` (~7 min) y el propio
  contexto del pedido menciona un caso de 12 min.
- Fallos intermitentes de WhatsApp: el log de estado (`hermes gateway status`) reportó ahora mismo
  `⚠ whatsapp: WhatsApp enabled but not paired`, y el `phone_id` cambió entre reinicios del
  gateway en el propio log (`971537482717711` → `1396640636870829`), consistente con el
  "número que se desregistra" que describe Matías.
- Sin visibilidad de tok/s del modelo local, VRAM/temperatura de GPU, ni CPU/RAM del PC, salvo
  corriendo comandos a mano.
- Dependencia alta de "ir a diagnosticar" reactivamente en vez de tener una vista continua.

Verificado en el entorno real (esta sesión, 2026-10-31):

- `hermes dashboard` existe y es real: `hermes dashboard --host 127.0.0.1 --port 9119`, expone
  `/api/status`, construido con FastAPI 0.133.1 / Uvicorn 0.41.0 / Starlette 1.3.1 ya instalados
  en el entorno interno de Hermes. Gestiona config, API keys y sesiones — **no se debe exponer
  nunca a internet** (ni siquiera sin `--insecure`, que ya es un no-op desde el hardening de junio
  2026: un bind no-loopback exige auth igual).
- `hermes gateway status` ya da un resumen de salud legible (service activo, pairing de WhatsApp).
- `hermes monitoring status` existe pero el export OTLP está **deshabilitado** y el SDK OTel
  **no está instalado** (`hermes-agent[otlp]` es un extra opcional no instalado). Es decir, hoy
  no hay telemetría estructurada saliendo de Hermes — solo logs de texto y comandos de estado.
- `hermes status --full --deep` es informativo (config, API keys, auth providers) pero **no**
  da métricas de runtime del gateway ni del modelo — no sirve como fuente de métricas en vivo,
  solo como snapshot de configuración/salud de arranque.
- `llama-server` en 8081 responde `GET /health` → `{"status":"ok"}`, pero `GET /metrics` devuelve
  `501 not_supported_error: Start it with --metrics`. Hoy el `ExecStart` de `llm.service`
  (`/home/matias/.config/systemd/user/llm.service`) **no** incluye `--metrics`, así que no hay
  tok/s ni conteo de tokens expuesto por Prometheus-format todavía.
- `nvidia-smi --query-gpu=...` funciona y da memoria/temperatura/utilización en una sola línea
  parseable.
- Los logs relevantes existen y tienen el formato esperado: `~/.hermes/logs/gateway.log` (líneas
  `INFO gateway.run: response ready: ... time=Xs api_calls=N`), `agent.log` (turnos, llamadas a
  modelo, memory trims), `errors.log` (warnings/errores). Rotan: ya existen `agent.log.1` y
  `errors.log.1` junto a los activos — cualquier tailer tiene que tolerar rotación.
- Hermes corre con su **propio toolchain de Python embebido**
  (`~/.hermes/tools/python-3.14.7+.../bin/python3`) y un venv interno en
  `~/.hermes/installs/<hash>/environments/<hash>/venv/` — no es un venv de proyecto simple
  activable ni pensado para que código externo importe sus módulos. Acoplar hermes-monitor a los
  internals de ese venv sería frágil (puede recrearse en cada `hermes update`) y, al ser
  hermes-monitor un repo público, no es buena idea depender de paquetes/versiones internas de un
  producto de terceros que no son API pública.
- El usuario ya tiene Tailscale activo (tailnet con 11 dispositivos, iPhone incluido) y un dominio
  Funnel fijo que **ya usa para otra cosa** (el webhook de WhatsApp) — ese Funnel no debe
  reutilizarse para el monitor.

## 2. Decisión

Construir **hermes-monitor** como un servicio independiente, en **Python propio** (entorno
virtual propio del repo, sin depender del venv interno de Hermes), que:

1. Reutiliza Hermes **como fuente de datos vía su CLI y sus logs**, nunca importando sus módulos
   internos ni su venv. Concretamente:
   - `hermes gateway status` (parseado) para el resumen de salud del gateway/pairing.
   - `hermes monitoring status` para saber si OTLP está activo (hoy no) y degradar con gracia.
   - `tail -F` sobre `~/.hermes/logs/gateway.log` y `agent.log` para eventos en vivo, con manejo
     de rotación (reabrir el handle si el inode cambia, igual que hace `tail -F`).
   - `GET http://127.0.0.1:9119/api/status` del dashboard oficial si está corriendo, como fuente
     adicional opcional (no obligatoria: el dashboard no se deja encendido 24/7 hoy).
2. **No reimplementa** gestión de config/API keys/sesiones — eso ya lo cubre el dashboard oficial
   de Hermes. hermes-monitor es puramente de observabilidad: salud, métricas, eventos. Si Matías
   quiere tocar config, lo sigue haciendo desde `hermes dashboard`.
3. Expone sus propios endpoints (REST + WebSocket) en un backend FastAPI liviano, bindeado
   **solo a loopback o a la IP de Tailscale**, nunca a `0.0.0.0` hacia internet y nunca por Funnel.
4. Tiene un frontend SPA simple sin build pesado, pensado primero para iPhone Safari, con
   WebSocket para tiempo real y fallback a polling REST.
5. Persiste un histórico corto en SQLite (ej. últimas 24-72h) para poder ver tendencias (tok/s,
   temperatura, latencia por mensaje) sin depender de que el proceso esté vivo todo el tiempo.
6. Se publica como repo público (`meatxsucks/hermes-monitor`) con la config/credenciales
   completamente separadas del código y fuera del repo.

### Por qué esta opción y no otras

| Opción | Trade-off | Veredicto |
|---|---|---|
| **A. Extender el dashboard oficial de Hermes** (plugin propio sobre `/api/plugins/...`, que ya existe como mecanismo — se ve en `gui.log`: `Mounted plugin API routes: /api/plugins/hermes-achievements/`) | Reutiliza auth y server ya corriendo; pero acopla hermes-monitor al ciclo de vida/versión de Hermes (un `hermes update` puede romper el plugin), y mezclaría código de un repo público con internals de un producto de terceros cuya API de plugins no está documentada como estable. Además el dashboard no queda levantado 24/7 hoy. | Descartada como base, pero se reutiliza su REST `/api/status` como fuente *opcional* de datos cuando esté arriba. |
| **B. Servicio independiente en Python propio (elegida)** | Requiere su propio proceso/servicio systemd y su propio puerto, algo más para mantener. A cambio: cero acoplamiento a internals de Hermes, puede vivir en un repo público sin exponer nada de la instalación real de Matías, y sigue funcionando aunque Hermes esté caído (que es justo el caso que más le importa diagnosticar). | **Recomendada.** Es observabilidad externa: tiene que sobrevivir a que el sistema observado falle. |
| **C. Exportar todo a Prometheus/Grafana (stack estándar)** | Es lo "correcto" en un mundo de infra grande: Grafana ya resuelve históricos, alertas, paneles. Pero es sobre-ingeniería para un PC personal: otro servicio pesado, sin optimizar para iPhone/PWA, y Matías pidió explícitamente una app propia "bien detallada" con control end-to-end, no un dashboard genérico. | Descartada para v1; se deja la puerta abierta (el backend ya puede exponer `/metrics` en formato Prometheus más adelante si algún día quiere sumar Grafana, sin rehacer la recolección). |

La opción B es la que minimiza acoplamiento y maximiza la propiedad de diseño pedida ("control
end-to-end"), y es coherente con que el repo va a ser público: no debe convivir código con los
internals de un producto de terceros ni con nada que dependa de rutas específicas de la
instalación de Hermes de Matías más allá de las que son parte de su contrato público (CLI, logs
documentados, puertos configurados por el propio usuario).

## 3. Fuentes de datos concretas

| Dato | Fuente exacta | Notas |
|---|---|---|
| Estado del gateway (up/down, pairing WhatsApp/Telegram) | `hermes gateway status` (parseo de texto) + `systemctl --user is-active hermes-gateway.service` | `hermes gateway status` ya imprime `⚠ whatsapp: ... not paired` — parsear esa línea es más robusto que adivinar por logs. |
| Eventos de gateway en vivo (mensajes entrantes/salientes, tiempos de respuesta, reinicios) | `tail -F ~/.hermes/logs/gateway.log` | Formato real observado: `INFO gateway.run: response ready: platform=whatsapp_cloud chat=... session=... time=424.1s api_calls=2 response=1121 chars`. Extraer `platform`, `time`, sin loguear `chat`/contenido en la UI (ver sección de seguridad). |
| Errores/warnings (Telegram network fallback, fallos de voz, etc.) | `tail -F ~/.hermes/logs/errors.log` | Ya contiene warnings reales de red de Telegram y memoria. |
| Turnos del agente / llamadas a modelo | `tail -F ~/.hermes/logs/agent.log` | Contiene líneas de `mem_trim` (RSS) y accesos HTTP al webhook — útil para correlacionar carga. |
| Rotación de logs | Detectar cambio de inode (`os.stat().st_ino`) al hacer tail; ya existen `agent.log.1`, `errors.log.1` confirmando que rota. | Implementar tail resiliente a rotación desde el día 1, no como parche. |
| Telemetría OTLP de Hermes | `hermes monitoring status` | Hoy deshabilitada y sin SDK instalado — tratar como fuente **opcional futura**, no bloquear v1 en esto. |
| Config/estado completo de Hermes | `hermes status --full --deep` | Snapshot de arranque (API keys configuradas, modelo activo) — usar como info estática de una tarjeta "config", refrescar con poca frecuencia (no es tiempo real). |
| Dashboard oficial (si está corriendo) | `GET http://127.0.0.1:9119/api/status` | Opcional: si el proceso no está arriba, degradar sin error duro. |
| Modelo local: health | `GET http://127.0.0.1:8081/health` | Ya confirmado `{"status":"ok"}`. |
| Modelo local: métricas (tok/s, prompt/gen tokens) | `GET http://127.0.0.1:8081/metrics` (formato Prometheus) | **Hoy devuelve 501** porque falta `--metrics` en `llm.service`. Requiere agregar `--metrics` al `ExecStart` de `/home/matias/.config/systemd/user/llm.service` (cambio de infra fuera del repo, a documentar como prerequisito, no a tocar por este proyecto sin permiso explícito). Mientras tanto, degradar la tarjeta a "métricas no disponibles, activar --metrics" en vez de romper. |
| GPU (VRAM, temp, util) | `nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu,utilization.gpu --format=csv,noheader,nounits` | Confirmado funcionando; parsear CSV, poll cada 2-5s. |
| CPU/RAM del PC | `/proc/stat` (CPU %), `/proc/meminfo` (RAM) | Evitar subprocess por poll; leer `/proc` directo es más barato y estándar en Python. |
| Servicios relacionados | `systemctl --user show -p ActiveState,SubState,MainPID <service>` para `hermes-gateway.service`, `llm.service`, `orion-despierto.service`, `orion-cara.service`, `orion-supermemory.service` | Todos confirmados activos ahora; listar su estado da una vista "mapa de servicios" completa. |
| Supermemory | `GET http://127.0.0.1:6767/...` | El puerto responde (404 en `/health`, pero el proceso contesta) — revisar qué endpoint real expone antes de implementar; no asumir `/health`. |

## 4. Arquitectura del backend

- **Lenguaje/runtime:** Python 3.12+, **venv propio del repo** (`hermes-monitor/backend/.venv`,
  no compartido con Hermes). Framework: **FastAPI + Uvicorn** (mismo stack que ya usa el
  dashboard oficial, así que Matías no suma una tecnología nueva a su stack mental, pero el venv
  y las versiones son independientes — no hay riesgo de que un `hermes update` rompa
  hermes-monitor ni viceversa).
- **Recolección:**
  - *Polling* liviano (cada 2-5s configurable) para: GPU (`nvidia-smi`), CPU/RAM (`/proc`),
    `/health` de llama-server, `/metrics` de llama-server cuando esté disponible, estado de
    servicios systemd, `hermes gateway status`.
  - *Tail en vivo* (asyncio, no subprocess de `tail`) para `gateway.log`, `agent.log`,
    `errors.log`: un pequeño file-tailer propio que sigue el archivo por offset, detecta
    truncation/rotation por inode, y parsea solo las líneas relevantes a eventos estructurados
    (no reenvía líneas crudas con contenido de usuario — ver seguridad).
  - Cada fuente es un "collector" independiente con su propio intervalo y manejo de fallos: si
    `nvidia-smi` falla o `llama-server` está caído, ese collector reporta `status: down` sin tumbar
    el resto (esto es clave porque el caso de uso explícito es "diagnosticar cuando algo está
    caído").
- **Exposición:**
  - `GET /api/snapshot` — REST, estado actual consolidado de todas las fuentes (para carga inicial
    de la SPA y para testing/curl manual).
  - `GET /api/history?metric=...&since=...` — REST, histórico corto desde SQLite.
  - `WS /ws/live` — WebSocket que empuja actualizaciones incrementales (métricas + eventos de
    log) a los clientes conectados. Fallback: si el WS se cae, el frontend vuelve a polling de
    `/api/snapshot` cada pocos segundos hasta reconectar.
  - `GET /api/healthz` — self-check del propio hermes-monitor (para que el usuario pueda
    distinguir "Orión caído" de "hermes-monitor caído").
- **Persistencia:** SQLite (archivo único, ej. `backend/data/history.db`, fuera de git vía
  `.gitignore`), con una tabla de series temporales simple (`timestamp, metric, value`) y una
  tabla de eventos (`timestamp, source, level, summary`). Retención corta configurable (ej. 72h)
  con purga periódica — no es un sistema de métricas de largo plazo, es para ver "qué pasó en las
  últimas horas" durante un diagnóstico.
- **Proceso:** un `systemd --user` service propio (`hermes-monitor.service`), análogo a los que ya
  usa Matías, documentado en el repo pero **no instalado automáticamente** (el repo es público;
  cada quien decide cómo correrlo). El unit file de ejemplo va en `docs/`, no se escribe directo
  en `~/.config/systemd/user/` sin permiso explícito.

## 5. Frontend

- SPA liviana, sin framework pesado si se puede evitar overhead en Safari móvil — candidatos:
  Svelte (Matías ya tiene experiencia con SvelteKit en `mentor-cosmico-app`) o vanilla JS +
  pequeña librería de reactividad. Recomendación: **Svelte (sin Kit, build con Vite)** — curva de
  aprendizaje ya conocida por el usuario, bundle final pequeño, bueno para PWA.
- PWA opcional en fase posterior (manifest + service worker) para poder "agregar a inicio" en el
  iPhone y tener un ícono como app nativa — no bloqueante para v1.
- Pantallas/tarjetas (todas en una sola vista con scroll, pensado para pantalla de iPhone, no un
  dashboard de múltiples páginas):
  1. **Estado Hermes** — gateway activo/caído, pairing de WhatsApp/Telegram, último reinicio.
  2. **Modelo local** — health, tok/s (cuando `--metrics` esté activo), contexto usado, degradado
     a "sin métricas, activar --metrics en llm.service" si no está disponible.
  3. **PC** — CPU %, RAM usada/total, GPU (VRAM usada/total, temp, util %).
  4. **Feed de eventos en vivo** — lista cronológica inversa de eventos parseados de los logs
     (mensaje recibido/respondido con latencia, warnings, reinicios de webhook), con color por
     severidad.
  5. **Salud de canales** — WhatsApp (pairing, phone_id activo, último webhook recibido) y
     Telegram (última conexión exitosa, fallbacks de red).
  6. **Mapa de servicios** — lista de los `systemctl --user` relevantes con su estado.
- Reconexión de WebSocket con backoff exponencial visible en la UI ("reconectando...") en vez de
  fallar en silencio — es justamente el síntoma que Matías ya sufre con Hermes (no saber si algo
  está colgado).

## 6. Seguridad (repo público)

- El repo contiene **solo código**. Ninguna ruta, IP, hostname de Tailscale, token o nombre de
  servicio real de la instalación de Matías va hardcodeado — todo sale de variables de entorno /
  archivo de config no versionado.
- `.env.example` con claves documentadas y **valores vacíos o placeholder**, nunca reales (ej.
  `HERMES_LOG_DIR=/home/USER/.hermes/logs`, no la ruta real con el username expuesto si se quiere
  evitar hasta eso — aunque el username ya es público en otros repos del usuario, mejor pecar de
  cuidadoso).
- `.gitignore` cubre: `.env`, `backend/data/*.db`, cualquier archivo bajo `config/local.*`.
- La UI y los logs internos de hermes-monitor **nunca muestran contenido de mensajes** (texto de
  chats de Telegram/WhatsApp) — solo metadata: plataforma, timestamps, duración, conteos de
  caracteres/tokens, IDs de chat truncados o hasheados si se quieren mostrar como referencia (ej.
  `56942...605` → mostrar `56942***605` o un hash corto). El parser de `gateway.log` debe
  extraer explícitamente solo los campos permitidos (platform, time, api_calls, response length)
  y descartar el resto de la línea, no loguear la línea cruda en ningún log propio persistente.
  Esto hay que aplicarlo también a `chat=` (identificador de usuario/número) que sí aparece en el
  log de Hermes.
- Ningún endpoint de hermes-monitor debe reexponer `/api/status` del dashboard oficial tal cual si
  ese payload llegara a incluir algo sensible (hay que revisarlo cuando se implemente, no asumir
  que es seguro reenviarlo sin filtrar).
- Sin autenticación de usuarios en v1 (se asume que el único canal de acceso es la tailnet
  privada), pero el backend **nunca** debe bindear a `0.0.0.0` por defecto — default a `127.0.0.1`
  y requerir que el usuario especifique explícitamente la IP de Tailscale si quiere acceso desde
  el iPhone. Documentar esto en bold en el README como advertencia explícita de que nunca debe
  pasar por el Funnel que ya usa WhatsApp.
- Si en una fase futura se agrega autenticación (ej. token simple), ese token vive en `.env`, no
  en el repo.

## 7. Acceso desde el iPhone

- Único camino soportado: **Tailscale**. El backend bindea a la IP de la interfaz Tailscale del PC
  (`tailscale ip -4`) además de loopback, nunca a `0.0.0.0`.
- El iPhone, ya en la misma tailnet, accede directo a `http://<tailscale-ip-del-pc>:<puerto>` (o
  `https://` si se configura HTTPS de Tailscale — opcional, fase futura).
- **Nunca** usar Tailscale Funnel para este servicio: el Funnel fijo que existe hoy
  (`matias-pc.tail11b502.ts.net`) está dedicado al webhook de WhatsApp Cloud API, que por
  requisito de Meta debe ser público; hermes-monitor no tiene ese requisito y exponerlo a
  internet sería el único vector de riesgo evitable en todo este diseño.

## 8. Plan de testing

- **Tail de logs con rotación:** simular rotación (renombrar `gateway.log` a `.1` y crear uno
  nuevo mientras el tailer corre) y verificar que sigue sin perder/duplicar eventos y sin crashear.
- **Modelo local apagado:** parar `llm.service` (en un entorno de test, no en el real sin avisar)
  y verificar que la tarjeta de modelo degrada a "caído" sin tumbar el resto del snapshot.
- **Hermes gateway caído:** simular `hermes-gateway.service` inactivo y verificar que
  hermes-monitor sigue sirviendo el resto de las métricas (PC, GPU) y marca el gateway como
  caído — este es el caso de uso principal pedido por Matías.
- **Reconexión de WebSocket:** matar la conexión del lado servidor y verificar que el cliente
  reintenta con backoff y la UI lo refleja, sin requerir recargar la página.
- **`nvidia-smi` no disponible** (ej. driver no cargado, o se corre en otra máquina sin GPU NVIDIA
  para probar): el collector de GPU debe degradar, no romper el resto.
- **`/metrics` de llama-server no disponible** (caso actual real, confirmado en esta sesión): la
  tarjeta debe mostrar un estado explícito de "métricas no habilitadas" con instrucción de cómo
  activarlas, no un error genérico.
- **Carga del histórico con SQLite vacío/corrupto:** arrancar sin DB previa (crear schema) y con
  un archivo corrupto (debe recrear o fallar con mensaje claro, no crashear el proceso).
- Tests automatizados: unitarios para cada parser de log (dado un `gateway.log` de fixture con
  líneas reales como las vistas en esta sesión, verificar la extracción correcta de campos) y
  tests de integración del backend con los collectors mockeados (sin depender de que la máquina
  de CI tenga GPU NVIDIA ni Hermes instalado).

## 9. Estructura de carpetas propuesta

```
hermes-monitor/
├── DESIGN.md
├── README.md
├── LICENSE
├── .gitignore
├── .env.example
├── backend/
│   ├── pyproject.toml
│   ├── app/
│   │   ├── main.py              # FastAPI app, WS + REST
│   │   ├── collectors/
│   │   │   ├── gpu.py
│   │   │   ├── system.py        # /proc CPU/RAM
│   │   │   ├── llama_server.py  # /health, /metrics
│   │   │   ├── hermes_cli.py    # wrappers a `hermes gateway status`, etc.
│   │   │   └── log_tail.py      # tailer resiliente a rotación + parsers
│   │   ├── storage/
│   │   │   └── sqlite_store.py
│   │   └── models.py            # schemas Pydantic de snapshot/eventos
│   └── tests/
│       ├── fixtures/             # líneas de log de ejemplo (sin datos reales de Matías)
│       └── test_*.py
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.svelte
│       ├── lib/components/       # tarjetas: HermesStatus, ModelStatus, SystemStatus, EventFeed, ChannelHealth, ServiceMap
│       └── lib/ws-client.ts
├── docs/
│   ├── adr/                      # ADRs futuros (este DESIGN.md se puede mover acá como ADR-0001)
│   ├── systemd/hermes-monitor.service.example
│   └── screenshots/
└── .github/
    └── workflows/
        └── ci.yml                # lint + tests backend/frontend
```

## 10. Riesgos y deuda técnica reconocidos

- **Parsers de log frágiles por diseño:** dependen del formato de texto de los logs de Hermes
  (ej. `response ready: ... time=Xs`), que no es una API estable — un `hermes update` futuro puede
  cambiar el formato y romper el parser silenciosamente. Mitigación: tests con fixtures y un modo
  "degradado" que muestre el evento crudo (sin campos sensibles) si el parser no matchea, en vez
  de descartarlo sin avisar.
- **`--metrics` de llama-server es un prerequisito externo al repo:** hermes-monitor no puede dar
  tok/s reales hasta que se edite `llm.service` fuera de este proyecto. Esto se documenta como
  requisito de instalación, no se resuelve tocando ese archivo desde acá sin permiso explícito.
- **SQLite con un único proceso:** suficiente para un usuario, uso personal; no diseñado para
  múltiples escritores concurrentes. No es un problema esperado en este caso de uso.
- **Sin autenticación en v1:** la seguridad depende enteramente de que el bind esté correctamente
  limitado a Tailscale/loopback. Un error de configuración (bind a `0.0.0.0`) expondría métricas
  operativas (no secretos, pero sí metadata de uso) a quien esté en la misma red. Se documenta
  explícitamente en el README como el riesgo principal a vigilar.
- **Acoplamiento de versión de Python/Svelte del repo público vs. el resto del stack del
  usuario:** al no compartir venv con Hermes, hay dos entornos Python que mantener en la misma
  máquina. Trade-off aceptado a cambio de independencia.

## 11. Fases para implementación

Pensadas para delegar a agentes `build` por separado, cada una con alcance acotado y verificable
sin depender de que las otras estén terminadas (salvo donde se indica).

### Fase 1 — Backend: recolectores + API (sin frontend)
- Implementar collectors (`gpu.py`, `system.py`, `llama_server.py`, `hermes_cli.py`,
  `log_tail.py`) cada uno testeable de forma aislada con mocks/fixtures.
- Implementar `sqlite_store.py` con schema de métricas y eventos + purga por retención.
- Exponer `GET /api/snapshot`, `GET /api/history`, `GET /api/healthz`, `WS /ws/live`.
- Tests unitarios de parsers con fixtures de log (sin datos reales).
- Entregable verificable: `curl http://127.0.0.1:<puerto>/api/snapshot` devuelve JSON coherente
  con el estado real de la máquina, y degrada con gracia si una fuente falla.

### Fase 2 — Frontend SPA
- Setup Vite + Svelte, componentes de las 6 tarjetas descritas en la sección 5.
- Cliente WebSocket con reconexión/backoff y fallback a polling REST.
- Responsive mobile-first, probado en viewport de iPhone (Safari).
- Depende de que Fase 1 tenga al menos `/api/snapshot` y `/ws/live` estables (puede empezar en
  paralelo contra fixtures/mocks del backend).

### Fase 3 — Documentación, README, licencia, empaquetado para repo público
- README con instrucciones de instalación, `.env.example`, advertencia de seguridad (bind
  Tailscale-only, nunca Funnel), capturas de pantalla.
- `LICENSE` (a confirmar con Matías cuál: MIT/Apache-2.0 son lo usual para este tipo de tooling).
- `docs/systemd/hermes-monitor.service.example` documentado, no instalado.
- Checklist pre-publicación: grep del repo completo buscando IPs, tokens, hostnames reales antes
  de hacer el primer push público.

### Fase 4 — CI y testing de integración
- `.github/workflows/ci.yml`: lint + tests de backend (pytest) y frontend (vitest/svelte-check)
  en cada push/PR, sin depender de hardware real (GPU, Hermes instalado) — todo mockeado.
- Tests de los escenarios de la sección 8 (modelo caído, gateway caído, rotación de log,
  reconexión WS) como parte de la suite automatizada donde sea mockeable; los que requieren
  hardware real (ej. apagar `llm.service` de verdad) quedan documentados como checklist manual.
