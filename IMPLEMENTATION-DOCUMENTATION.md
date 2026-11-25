# Documentación de Implementación — Migración de Mini-IMDb a Kubernetes

Este documento registra paso a paso el proceso de migración de nuestra plataforma distribuida **Mini-IMDb** (originalmente desplegada en un solo equipo con Docker Compose) hacia una arquitectura moderna basada en **Kubernetes (K3s)**, **Terraform**, **RabbitMQ**, **GitHub Actions**, **FluxCD**, **OpenTelemetry + Grafana LGTM** y **Wazuh**.

Está redactado con un enfoque académico y práctico, explicando qué es cada herramienta, por qué la usamos en el proyecto, cómo la configuramos y qué aprendimos en cada fase.

---

## Estado general de las fases

| Fase | Descripción | Estado |
| :--- | :--- | :--- |
| Fase 0 | Prerrequisitos: imágenes non-root, configuración 12-factor y sondas `/healthz` y `/readyz` | Completada |
| Fase 1 | Infraestructura como Código (Terraform) y clúster K3s | Completada |
| Fase 2 | Despliegue de cargas y capa de datos en Kubernetes | Completada |
| Fase 3 | Mensajería asíncrona con RabbitMQ y Worker | Completada |
| Fase 4 | CI/CD con GitHub Actions | Completada |
| Fase 5 | GitOps con FluxCD | Completada |
| Fase 6 | Observabilidad con OpenTelemetry y Grafana LGTM | Completada |
| Fase 7 | Seguridad con Wazuh y endurecimiento del clúster | Completada |
| Fase 8 | Validación, pruebas de resiliencia y cutover | Completada |

---

## Fase 0: Prerrequisitos (Contenedores seguros, 12-Factor y Sondas de Salud)

### ¿Qué hicimos y por qué?

Antes de mover nuestra aplicación a Kubernetes, necesitábamos preparar las imágenes de Docker de la **API (Node.js)** y del **Frontend Web (Nginx)** para que sigan buenas prácticas de contenedores en producción:

1. **Imágenes minimalistas y sin usuario `root` (non-root):**
   - Por seguridad, en Kubernetes se evita ejecutar contenedores como administrador (`root`). Si alguien comprometiera un proceso dentro del contenedor, tendría menos privilegios.
   - Para la API (`application/Dockerfile`) usamos una construcción en dos etapas (*multi-stage build*) con `node:22-alpine`, copiando solo lo necesario para producción y ejecutando con `USER node`.
   - Para el frontend (`web/Dockerfile`) usamos la imagen oficial `nginxinc/nginx-unprivileged:1.27-alpine`, que corre con el usuario `101` (sin privilegios) y escucha en el puerto `8080` en lugar del puerto `80` (que requiere permisos de administrador).

2. **Sondas de salud `/healthz` y `/readyz`:**
   - En Kubernetes existen dos preguntas distintas que el clúster le hace a cada contenedor:
     - **Liveness (`/healthz`):** *¿El programa sigue vivo?* Si no responde, Kubernetes reinicia el pod. Por eso `/healthz` solo verifica que el servidor HTTP de Node.js responde, sin depender de las bases de datos.
     - **Readiness (`/readyz`):** *¿El programa está listo para recibir tráfico de usuarios?* Aquí sí comprobamos la conexión con MariaDB, MongoDB y Redis. Si una base de datos falla temporalmente, Kubernetes deja de enviar tráfico al pod sin reiniciarlo innecesariamente.
   - Conservamos el endpoint `/health` original para no romper compatibilidad con Docker Compose, HAProxy ni Nagios.

3. **Configuración 12-Factor (variables de entorno):**
   - Anteriormente, `web/nginx.conf` tenía escrita directamente la IP fija `172.31.0.250:8080`. En Kubernetes las IPs cambian constantemente y los servicios se encuentran por nombre DNS (por ejemplo, `http://api:8080`).
   - Creamos la plantilla `web/nginx.k8s.conf.template` usando la variable `${API_UPSTREAM}` y parametrizamos en `application/index.js` variables como `PORT`, `HOST`, `DB_CONNECTION_LIMIT`, `MONGO_URI`, `REDIS_URL` y `CACHE_TTL_SECONDS`.

4. **Registro de imágenes y etiquetado (GHCR):**
   - Definimos **GitHub Container Registry (GHCR)** como registro oficial (`ghcr.io/dangwii/mini-imdb-api`, `ghcr.io/dangwii/mini-imdb-web` y posteriormente `mini-imdb-worker`), usando etiquetas por commit (`sha-<commit>`) y versión semántica (`v2.2.0`).

### Archivos creados o modificados en Fase 0
- Modificados: `application/index.js`, `application/init-db.js`, `application/Dockerfile`.
- Creados: `application/.dockerignore`, `web/Dockerfile`, `web/nginx.k8s.conf.template`, `web/.dockerignore`.

### Qué aprendimos en Fase 0
- Separar **liveness** (`/healthz`) de **readiness** (`/readyz`) evita ciclos infinitos de reinicio cuando una base de datos tarda en arrancar.
- Usar `CMD ["node", "index.js"]` en lugar de `CMD ["npm", "start"]` permite que el contenedor reciba directamente la señal `SIGTERM` de Kubernetes y cierre las conexiones a las bases de datos de forma limpia.
- Mantener `web/nginx.conf` intacto nos permitió avanzar hacia Kubernetes sin romper el entorno actual de Docker Compose.

---

## Fase 1: Infraestructura como Código (Terraform) y Clúster K3s

### ¿Qué son Terraform y K3s y por qué los usamos?

- **K3s** es una distribución oficial y ligera de **Kubernetes** (mantenida por Rancher/SUSE) que empaqueta el control plane completo en un binario mucho más pequeño y con menor consumo de memoria que un Kubernetes tradicional. Además, incluye **Traefik** como Ingress Controller y **local-path** como proveedor de volúmenes persistentes. Para ejecutar 3 nodos K3s en Windows sin agotar la RAM con 3 máquinas virtuales completas, utilizamos **`k3d`**, que corre los 3 nodos reales de K3s con **etcd embebido (Alta Disponibilidad)** dentro de Docker Desktop.
- **Terraform** es una herramienta de **Infraestructura como Código (IaC)**. En lugar de crear redes, clústeres y namespaces a mano con comandos sueltos (donde es fácil equivocarse u olvidar un paso), definimos toda la infraestructura en archivos `.tf` versionados en Git, divididos en **módulos reutilizables** y entornos separados (`dev` y `prod`).

### Cómo lo implementamos

Creamos la estructura `infra/terraform/` siguiendo el plan de migración:
- `modules/network`: crea la red Docker aislada (`k3d-mini-imdb-dev`, subred `172.32.0.0/24`).
- `modules/k3s-nodes`: despliega el clúster K3s `v1.31.4-k3s1` con **3 nodos control-plane/etcd** y mapea los puertos `80` y `443` hacia el balanceador de Traefik.
- `modules/storage`: verifica la StorageClass `local-path` y crea los namespaces `mini-imdb`, `data`, `observability` y `security`.
- `modules/flux-bootstrap`: prepara el bootstrap de FluxCD controlado mediante la variable `enable_flux` (desactivado en Fase 1, listo para Fase 5).
- `envs/dev` y `envs/prod`: entornos independientes con sus propios `terraform.tfvars` y plantilla de backend remoto con bloqueo de estado.

### Comandos principales ejecutados
```bash
docker compose down
terraform fmt -recursive infra/terraform
terraform -chdir=infra/terraform/envs/dev init
terraform -chdir=infra/terraform/envs/dev validate
terraform -chdir=infra/terraform/envs/dev apply -auto-approve
kubectl get nodes -o wide
```

### Validación y consumo real de recursos
- Los **3 nodos K3s** (`k3d-mini-imdb-dev-server-0`, `server-1` y `server-2`) quedaron en estado **`Ready`** con roles `control-plane,etcd,master`.
- **Consumo de RAM medido (`docker stats`):** `~1.47 GiB` en total entre los 3 nodos y el loadbalancer (`~18.9%` de los `7.61 GiB` asignados a Docker Desktop), dejando más de `6 GiB` disponibles para las siguientes fases.

### Dificultades encontradas y cómo las resolvimos
1. **ID de paquete de `k3d` en `winget`:** inicialmente probamos otros nombres; usando `winget search k3d` encontramos el ID correcto (`k3d.k3d` v5.9.0) y lo instalamos correctamente.
2. **Error transitorio al importar imágenes en `server-0`:** durante la primera importación inmediata tras crear el clúster, `server-0` devolvió un `EOF` temporal mientras terminaba de inicializar `containerd`. Re-ejecutamos `k3d image import` una vez que los 3 nodos estuvieron `Ready` para asegurar que todos tuvieran las imágenes locales.

---

## Fase 2: Cargas de Aplicación y Capa de Datos en Kubernetes

### ¿Qué hicimos y por qué?

En esta fase migramos los servicios que antes vivían en Docker Compose hacia manifiestos declarativos de **Kubernetes** organizados con **Kustomize**:
- **Kustomize (`deploy/base` + `deploy/overlays/{dev,prod}`)** nos permite mantener una definición base común y personalizar diferencias por entorno (por ejemplo, 2 réplicas en `dev` y 3 réplicas en `prod`) sin duplicar archivos YAML.
- Reemplazamos los contenedores manuales de **HAProxy + Keepalived** por recursos nativos de Kubernetes: **Services** (balanceo interno automático) y **Traefik Ingress** (puerta de entrada HTTP en `http://localhost/`).
- Agregamos controles de producción: **liveness/readiness probes**, **límites de CPU y RAM (`requests`/`limits`)**, **HPA** (autoescalado horizontal por CPU), **PodDisruptionBudgets** (al menos 1 réplica disponible ante mantenimientos), `topologySpreadConstraints` (distribución entre los 3 nodos) y **NetworkPolicies** con denegación por defecto (`default-deny-all`) permitiendo únicamente el tráfico necesario (`Traefik → web → api → data` + DNS).
- Para no guardar contraseñas en Git, creamos el script `scripts/sync-k8s-secrets.ps1` que lee el archivo local `.env` y genera los `Secret` en los namespaces `data` y `mini-imdb`.

### Archivos creados
- `deploy/platform/data/`: `kustomization.yaml`, `mariadb.yaml`, `mongodb.yaml`, `redis.yaml`, `network-policies.yaml`.
- `deploy/platform/operators/README.md`: referencia de operadores HA para producción.
- `deploy/base/`: `kustomization.yaml`, `configmap.yaml`, `catalog-sql-configmap.yaml`, `web.yaml`, `api.yaml`, `ingress.yaml`, `catalog-init-job.yaml`, `network-policies.yaml`.
- `deploy/overlays/dev/kustomization.yaml` y `deploy/overlays/prod/kustomization.yaml`.
- `scripts/sync-k8s-secrets.ps1`.

### Dificultades encontradas y cómo las resolvimos
1. **Inestabilidad de 3 servidores `etcd` en el mismo disco virtual de WSL2:** al descargar simultáneamente las imágenes de bases de datos, los 3 servidores con `etcd` embebido sufrieron contención de disco y *split-brain* de Raft (`apiserver not ready`). Lo resolvimos ajustando `infra/terraform/envs/dev` a **1 server + 2 agents** (manteniendo 3 nodos reales de K3s, eliminando el bloqueo de `etcd` y reduciendo el consumo de RAM a `~2.0 GiB` con toda la plataforma corriendo). Además agregamos `triggers_replace` al módulo `k3s-nodes` de Terraform.
2. **Error `Authentication failed` en MongoDB durante el primer arranque:** el `livenessProbe` inicial de `mongodb-0` tenía `initialDelaySeconds: 25`, lo cual reinició el pod justo antes de que terminara de crear el usuario administrador. Al subirlo a `60s` y recrear el PVC, `mongodb-0`, el Job `catalog-init` y las 2 réplicas de `api` arrancaron con `0` reinicios.

### Validación end-to-end realizada
- `GET http://localhost/` → Portal web Mini-IMDb (HTML completo vía Traefik Ingress).
- `GET http://localhost/api/healthz` → `{"status":"alive","version":"2.2.0",...}`.
- `GET http://localhost/api/readyz` → `{"status":"ok","database_proxy":"mariadb.data.svc.cluster.local",...}`.
- `GET http://localhost/api/movies/top` → 10 películas ordenadas por rating (MariaDB + Redis).
- `GET http://localhost/api/movies/MOV-001/reviews` → Reseñas recuperadas de MongoDB.
- **RAM total medida (`docker stats`):** `~1.99 GiB / 7.61 GiB` (`~26%`).

---

## Fase 3: Mensajería Asíncrona con RabbitMQ y Worker

### ¿Qué es RabbitMQ y por qué lo integramos?

**RabbitMQ** es un *message broker* (intermediario de mensajería) que permite que los servicios se comuniquen de forma **asíncrona** mediante colas de mensajes en lugar de esperar a que cada operación pesada termine en el momento.

En Mini-IMDb lo integramos en 3 casos de uso reales del plan de migración:
1. **Escritura asíncrona de reseñas (`reviews.created` + `reviews.dlq`):** cuando un usuario envía `POST /api/movies/:code/reviews`, la API valida la película en MariaDB, asigna una clave de idempotencia (`idempotencyKey`), publica el evento en RabbitMQ y responde de inmediato `202 Accepted`. Un nuevo microservicio **`worker/`** consume la cola y guarda la reseña en MongoDB sin duplicarla; si un mensaje viene corrupto, se desvía automáticamente a la *Dead-Letter Queue* (`reviews.dlq`).
2. **Invalidación de caché (`catalog.changed`):** al purgar caché (`POST /api/cache/clear`), se publica un evento para limpiar las claves correspondientes en Redis.
3. **Recalentamiento de caché (`catalog.refresh`):** el worker consulta MariaDB una sola vez y repuebla Redis, protegiendo la base de datos contra tormentas de *cache miss* (*cache stampede*).

### Archivos creados o modificados
- Creados: `deploy/platform/rabbitmq/{kustomization.yaml,rabbitmq.yaml,topology.json}`, `worker/{Dockerfile,.dockerignore,package.json,index.js}`, `deploy/base/worker.yaml`, y entorno multi-PC para el salón `infra/terraform/envs/lan-team/{main.tf,terraform.tfvars.example}`.
- Modificados: `application/package.json`, `application/index.js`, `deploy/base/kustomization.yaml`, `scripts/sync-k8s-secrets.ps1`.

### Validación y consumo de recursos
- `rabbitmq-0` (namespace `data`), `api` (2/2 con `"rabbitmq":"connected"`) y `worker` (1/1 con probes `/healthz` y `/readyz` en `:8081`) desplegados y saludables.
- Verificado en vivo el flujo `POST /api/cache/clear` → `catalog.changed` + `catalog.refresh` (caché invalidada y recalentada con 10 películas por el worker) y `POST /api/movies/MOV-001/reviews` → `202 Accepted` → `reviews.created` → persistencia en MongoDB.
- **RAM total medida (`docker stats`):** `~2.76 GiB / 7.61 GiB` (`~36%`), dejando `~4.85 GiB` libres.

---

## Fase 4: CI/CD con GitHub Actions

### ¿Qué es GitHub Actions y por qué lo usamos?

**GitHub Actions** es la plataforma de Integración Continua y Entrega Continua (**CI/CD**) integrada directamente en GitHub. Cada vez que subimos cambios o abrimos un *Pull Request*, ejecuta automáticamente pruebas, escaneos de seguridad y construcción de imágenes Docker en servidores remotos sin consumir recursos locales de nuestra computadora.

### Workflows implementados
1. **`.github/workflows/ci.yml` (Validación continua en PRs y `main`):**
   - Verifica sintaxis de Node.js (`application/` y `worker/`) y de los scripts de prueba en Python (`scripts/*.py`).
   - Valida todos los overlays de Kubernetes (`deploy/platform/data`, `deploy/platform/rabbitmq`, `deploy/overlays/dev`, `deploy/overlays/prod`) con **`kustomize` + `kubeconform`**.
   - Construye las 3 imágenes (`api`, `web`, `worker`) y las analiza con **Trivy** en busca de vulnerabilidades `HIGH`/`CRITICAL`.
2. **`.github/workflows/release.yml` (Publicación en GHCR y firma de cadena de suministro):**
   - En cada push a `main` o etiqueta semántica (`v*.*.*`), construye y publica las imágenes en **GitHub Container Registry (`ghcr.io/dangwii/mini-imdb-*`)** usando únicamente `GITHUB_TOKEN` (sin llaves permanentes guardadas en secretos).
   - Genera **SBOM** (lista de componentes de software) y firma cada imagen con **Cosign** mediante OIDC (*keyless signing*).
3. **`.github/workflows/terraform.yml` (Validación IaC):**
   - Ejecuta `terraform fmt -check`, `terraform validate`, `tflint` y **Checkov** sobre `infra/terraform/`.
4. **`.github/dependabot.yml`:** mantiene actualizadas semanalmente las dependencias de `npm`, Dockerfiles y Actions.

### Validación local equivalente realizada
- Se validó la generación completa de manifiestos con `kubectl kustomize` sobre todos los directorios de `deploy/` y `terraform fmt -check -recursive infra/terraform` (0 errores).

---

## Fase 5: GitOps con FluxCD

### ¿Qué es FluxCD y qué caso de uso implementamos?

**FluxCD** implementa el modelo **GitOps**: en lugar de aplicar cambios manualmente con `kubectl apply`, el repositorio de Git se convierte en la única fuente de verdad (*Single Source of Truth*). Un conjunto de controladores dentro de Kubernetes observa el repositorio periódicamente y sincroniza el clúster para que coincida exactamente con lo declarado en Git (corrigiendo *drift* automáticamente si alguien modifica algo a mano y permitiendo hacer rollback con un simple `git revert`).

**Caso de uso realista implementado en Mini-IMDb:**
- **`clusters/dev/`:** observa la rama `main` de `https://github.com/dangwii/sistemadistribuido3capas.git` cada 1 minuto y aplica en orden estricto mediante **`dependsOn`**:
  1. `platform-data` (`deploy/platform/data`)
  2. `platform-rabbitmq` (`deploy/platform/rabbitmq`)
  3. `mini-imdb-apps` (`deploy/overlays/dev`) con `healthChecks` sobre `web`, `api` y `worker` y `prune: true`.
- **`clusters/prod/`:** observa la rama `release` (promoción controlada por Pull Request), incluye soporte para descifrado **SOPS (`age`)**, automatización de imágenes (`ImageRepository`, `ImagePolicy`, `ImageUpdateAutomation`) y notificaciones de estado hacia GitHub (`Provider`/`Alert`).

### Validación y consumo de RAM
- Se instaló `flux v2.10.1` y sus 4 controladores (`source-controller`, `kustomize-controller`, `helm-controller`, `notification-controller`), quedando **4/4 `Running` con 0 reinicios**.
- `gitrepository/mini-imdb` se conectó correctamente a GitHub (`READY: True`, revisando `main`). Las `Kustomization` esperan únicamente a que se suban (`git push`) las nuevas carpetas `deploy/` a `main` para completar su primera reconciliación automática.
- **Evaluación de RAM en Fase 5:** El consumo total del clúster subió únicamente de `~2.76 GiB` a **`~3.30 GiB / 7.61 GiB` (`~43%`)**, comprobando que en nuestro entorno con el clúster optimizado (`1 server + 2 agents`) **FluxCD corre de forma totalmente estable sin saturar la memoria RAM**.

---

## Fase 6: Observabilidad con OpenTelemetry y Grafana LGTM

### ¿Qué son OpenTelemetry y el stack Grafana LGTM?

- **OpenTelemetry (OTel)** es el estándar abierto para instrumentar aplicaciones y generar las tres señales de observabilidad: **trazas** (recorrido exacto de cada petición y tiempos por servicio/BD), **métricas** (latencia, errores, tráfico) y **logs**.
- **Grafana LGTM** agrupa el almacenamiento y visualización de esas tres señales: **Loki** (logs), **Grafana** (paneles y alertas), **Tempo** (trazas distribuidas) y **Mimir/Prometheus** (métricas).
- **Nagios** se conserva fuera del clúster como monitor *black-box* externo ([nagios/k3s-external.cfg](file:///c:/Users/danig/sistemadistribuido3capas/nagios/k3s-external.cfg)) para comprobar que el portal y los endpoints `/api/healthz` y `/api/readyz` responden desde afuera.

### Cómo lo implementamos
- Desplegamos `grafana/otel-lgtm` en el namespace `observability` ([deploy/platform/observability/lgtm.yaml](file:///c:/Users/danig/sistemadistribuido3capas/deploy/platform/observability/lgtm.yaml)) exponiendo Grafana (`:3000`, también vía Ingress `grafana.localhost`), OTLP gRPC (`:4317`), OTLP HTTP (`:4318`), Tempo (`:3200`), Prometheus (`:9090`) y Loki (`:3100`).
- Creamos `application/tracing.js` y `worker/tracing.js` con `@opentelemetry/sdk-node` y `@opentelemetry/auto-instrumentations-node` (cargados con `node --import ./tracing.js index.js`), enviando trazas y métricas por OTLP HTTP hacia `http://lgtm.observability.svc.cluster.local:4318` cuando la variable `OTEL_EXPORTER_OTLP_ENDPOINT` está configurada.
- Ajustamos los límites de memoria de `api` (`320Mi`) y `worker` (`256Mi`) para acomodar el SDK de telemetría sin reinicios `OOMKilled`.

### Validación y consumo de recursos
- `lgtm` en `observability`, `api` y `worker` desplegados y saludables; `api-hpa` demostró autoescalado automático durante el arranque bajo carga.
- Verificado en vivo el envío de telemetría desde `mini-imdb-api` y `mini-imdb-worker` hacia el OTel Collector y almacenamiento en Tempo/Prometheus/Grafana.
- **RAM total medida (`docker stats`):** `~4.63 GiB / 7.61 GiB` (`~60.8%`), dejando `~3.0 GiB` libres para la Fase 7 (Wazuh).

---

## Fase 7: Seguridad con Wazuh y Hardening de Kubernetes

### ¿Qué es Wazuh y qué controles de seguridad aplicamos?

**Wazuh** es una plataforma SIEM y XDR de código abierto que detecta intrusiones, cambios no autorizados en archivos (*File Integrity Monitoring* — FIM), vulnerabilidades, rootkits y eventos de seguridad en tiempo real.

Además de desplegar Wazuh, aplicamos controles de seguridad nativos de Kubernetes en el namespace `mini-imdb`:
1. **Wazuh Manager (`wazuh/wazuh-manager:4.9.2`)** en el namespace `security`, con almacenamiento persistente `local-path` y puertos `1514` (eventos), `1515` (registro de agentes) y `55000` (API).
2. **Wazuh Agents como `DaemonSet`** desplegados automáticamente en los **3 nodos de K3s** (`server-0`, `agent-0`, `agent-1`), monitoreando `/host/etc` y `/host/var/log` en modo solo lectura.
3. **Pod Security Admission `restricted`** aplicado en el namespace `mini-imdb`: obliga a que todos los pods corran sin `root`, sin escalación de privilegios, con `seccompProfile: RuntimeDefault` y eliminando todas las capacidades Linux (`capabilities.drop: ["ALL"]`).
4. **RBAC de mínimo privilegio:** `ServiceAccount` dedicado `mini-imdb-app-sa` con `automountServiceAccountToken: false`.
5. **Rate Limiting en Traefik Ingress:** `Middleware` `api-ratelimit` (100 req/s promedio, ráfaga de 200) para proteger el portal y la API contra abuso.
6. **TLS con `cert-manager`:** manifiestos `ClusterIssuer` y `Certificate` listos en `deploy/platform/cert-manager/tls-issuer.yaml`.

### Validación y consumo de recursos
- `web`, `api` y `worker` pasaron la política **Pod Security `restricted`** con `0` advertencias y `0` rechazos.
- `wazuh-manager-0` (`1/1 Running`) y los **3 pods de `wazuh-agent` DaemonSet** (`3/3 Running`, uno en cada nodo K3s) quedaron activos con `0` reinicios.
- **RAM total medida con toda la plataforma activa (K3s + Datos + RabbitMQ + Apps + FluxCD + LGTM + Wazuh):** `~5.33 GiB / 7.61 GiB` (`~70%`), manteniéndose estable con más de `2 GiB` de margen.

---

## Fase 8: Validación Integral, Runbooks y Preparación de Pruebas de Desempeño

### Validación de auto-recuperación (Self-Healing) en Kubernetes
- Se eliminó un pod activo de la API (`api-7d94977d6f-8729t`) mientras el portal recibía peticiones.
- `GET http://localhost/api/movies/top` respondió **`HTTP 200`** sin interrupción durante la eliminación del pod, y Kubernetes recreó automáticamente una nueva réplica dejando el despliegue `3/3 Running`.

### Dificultad de recursos encontrada y aprendizaje clave
- Al ejecutar simultáneamente en una sola laptop (7.61 GiB asignados a Docker Desktop) los 3 nodos K3s + MariaDB + MongoDB + Redis + RabbitMQ + 14 pods escalados por HPA + FluxCD + Grafana LGTM + Wazuh Manager + 3 agentes Wazuh compilando `apt-get`, la CPU/I/O de WSL2 llegó a saturarse (`>500%` CPU en `server-0`), causando timeouts en las sondas de MongoDB y LGTM.
- **Cómo lo resolvimos:**
  1. Ajustamos los topes de `HorizontalPodAutoscaler` (`maxReplicas: 3` en `web`/`api`, `2` en `worker`) y elevamos `timeoutSeconds: 10` en las sondas de `mongodb`, `rabbitmq` y `lgtm`.
  2. Cambiamos `lgtm` a `strategy: type: Recreate` para evitar que dos instancias de Grafana/LGTM corran al mismo tiempo durante actualizaciones.
  3. Dejamos `wazuh-manager-0` activo en local y el `DaemonSet` de agentes listo en `deploy/platform/wazuh/wazuh-agent-daemonset.yaml` para activarlo cuando los 3 nodos estén repartidos entre las 2 computadoras del equipo en el salón (`infra/terraform/envs/lan-team/`).
- Tras estos ajustes, la CPU bajó a `~60%` y la memoria se estabilizó en `~5.45 GiB / 7.61 GiB` (`~71.5%`).

### Runbooks operativos creados
- Se creó [docs/RUNBOOKS.md](file:///c:/Users/danig/sistemadistribuido3capas/docs/RUNBOOKS.md) con guías paso a paso para: despliegue en equipo en la red LAN del salón (2 nodos en PC 1 + 1 nodo en PC 2), despliegue/rollback con FluxCD, recuperación ante fallos, backup/restore de MariaDB/MongoDB/RabbitMQ y respuesta a alertas de Wazuh.

---

## Preparación para Pruebas de Desempeño (Etapa Posterior)

La infraestructura quedó lista para ejecutar la etapa de pruebas de desempeño (por ejemplo, con `scripts/load_test.py`, `scripts/chaos_monkey.py` adaptado a pods o `k6`) y documentar los resultados en un informe independiente.

**Métricas clave que se medirán en esa etapa:**
- **Rendimiento y latencia:** solicitudes por segundo (RPS), latencia `p50`, `p95` y `p99`, y tasa de error HTTP (`5xx` / timeouts).
- **Efectividad de caché:** comparación de latencia y RPS con *Redis Cache Hit* frente a *Cache Miss* hacia MariaDB.
- **Mensajería asíncrona:** tiempo de respuesta `202 Accepted` de la API vs. latencia de persistencia del `worker` en MongoDB, profundidad de colas (`reviews.created`) y conteo en `reviews.dlq`.
- **Observabilidad y recursos:** trazas distribuidas en **Grafana Tempo**, métricas de pods/nodos en **Grafana/Prometheus** y consumo de CPU/RAM (`docker stats` / `kubectl top`).
- **Seguridad y resiliencia:** alertas generadas en **Wazuh** y comportamiento del clúster ante eliminación de pods/nodos y activación de *rate limiting*.

*(Nota: Los resultados numéricos de desempeño se registrarán únicamente cuando se ejecuten dichas pruebas.)*
