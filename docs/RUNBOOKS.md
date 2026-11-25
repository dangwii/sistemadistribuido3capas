# Runbooks Operativos — Mini-IMDb en Kubernetes (K3s)

Guía práctica de operación, recuperación ante fallos y despliegue en equipo para la plataforma **Mini-IMDb**.

---

## 1. Despliegue en equipo en el salón (2 computadoras en red LAN)

Requisitos: 2 PCs en la misma red LAN (Wi-Fi/Ethernet) con 3 VMs Ubuntu Server en modo **Bridged** (2 VMs en PC 1 y 1 VM en PC 2) y acceso SSH sin contraseña mediante llave pública.

1. Copiar `infra/terraform/envs/lan-team/terraform.tfvars.example` a `terraform.tfvars` y colocar las 3 IPs LAN reales:
   - `server_ip`: IP de la VM 1 en PC 1 (control-plane K3s).
   - `agent_ips`: `[IP VM 2 en PC 1, IP VM 1 en PC 2]`.
2. Definir el token compartido y aprovisionar K3s con Terraform:
   ```powershell
   $env:TF_VAR_k3s_token = "token-seguro-del-equipo"
   terraform -chdir=infra/terraform/envs/lan-team init
   terraform -chdir=infra/terraform/envs/lan-team apply
   ```
3. Copiar `/etc/rancher/k3s/k3s.yaml` desde el servidor a `~/.kube/config`, reemplazando `127.0.0.1` por la `server_ip` LAN, y validar los 3 nodos:
   ```bash
   kubectl get nodes -o wide
   ```
4. Sincronizar secretos locales desde `.env` y aplicar la plataforma (o activar FluxCD con `clusters/dev`):
   ```powershell
   .\scripts\sync-k8s-secrets.ps1
   kubectl apply -k deploy/platform/data
   kubectl apply -k deploy/platform/rabbitmq
   kubectl apply -k deploy/overlays/dev
   kubectl apply -k deploy/platform/observability
   kubectl apply -k deploy/platform/wazuh
   ```

---

## 2. Despliegue y Rollback (GitOps / Kustomize)

- **Despliegue con FluxCD:** cualquier cambio fusionado en `main` (`dev`) o `release` (`prod`) se sincroniza automáticamente en ≤ 1 minuto. Para forzar reconciliación inmediata:
  ```bash
  flux reconcile source git mini-imdb
  flux reconcile kustomization mini-imdb-apps --with-source
  ```
- **Rollback seguro con GitOps:** revertir el último commit en Git y hacer push:
  ```bash
  git revert HEAD --no-edit
  git push origin main
  ```
- **Rollback de emergencia en Kubernetes:**
  ```bash
  kubectl -n mini-imdb rollout undo deployment/api
  kubectl -n mini-imdb rollout undo deployment/web
  kubectl -n mini-imdb rollout undo deployment/worker
  ```

---

## 3. Recuperación ante caída de pod o nodo

- **Caída de un pod (`web`, `api` o `worker`):** Kubernetes recrea el pod automáticamente y el `Service` + `readinessProbe` (`/readyz` o `/healthz`) evita enrutar tráfico a pods no listos.
- **Caída de un nodo worker:**
  ```bash
  kubectl get nodes
  kubectl get pods -A -o wide
  ```
  Los pods sin estado (`web`, `api`, `worker`) se reprograman automáticamente en los nodos sanos respetando `PodDisruptionBudget` (`minAvailable: 1`).
- **Saturación de colas en RabbitMQ:**
  - Escalar temporalmente el `worker`: `kubectl -n mini-imdb scale deployment/worker --replicas=3`.
  - Revisar mensajes en la Dead-Letter Queue (`reviews.dlq`) desde la consola de RabbitMQ (`kubectl -n data port-forward svc/rabbitmq 15672:15672`).

---

## 4. Backup y Restore de la Capa de Datos

- **MariaDB (Backup):**
  ```bash
  kubectl -n data exec mariadb-0 -- sh -c 'mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' > backup-mariadb.sql
  ```
- **MariaDB (Restore):**
  ```bash
  cat backup-mariadb.sql | kubectl -n data exec -i mariadb-0 -- sh -c 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"'
  ```
- **MongoDB (Backup):**
  ```bash
  kubectl -n data exec mongodb-0 -- sh -c 'mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive' > backup-mongodb.archive
  ```
- **MongoDB (Restore):**
  ```bash
  cat backup-mongodb.archive | kubectl -n data exec -i mongodb-0 -- sh -c 'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --drop'
  ```
- **RabbitMQ (Exportar definiciones de colas/exchanges):**
  ```bash
  kubectl -n data exec rabbitmq-0 -- rabbitmqctl export_definitions /tmp/defs.json
  kubectl cp data/rabbitmq-0:/tmp/defs.json ./backup-rabbitmq-defs.json
  ```

---

## 5. Respuesta ante incidentes de seguridad (Wazuh)

- **Consultar agentes activos en el clúster:**
  ```bash
  kubectl -n security exec wazuh-manager-0 -- /var/ossec/bin/agent_control -l
  ```
- **Revisar alertas recientes de seguridad (FIM, rootcheck, cumplimiento):**
  ```bash
  kubectl -n security exec wazuh-manager-0 -- tail -n 30 /var/ossec/logs/alerts/alerts.log
  ```
- **Contención ante compromiso de un pod:** aislar el pod eliminándolo o restringiendo tráfico en `deploy/base/network-policies.yaml` y revisar trazas en **Grafana LGTM** (`kubectl -n observability port-forward svc/lgtm 3000:3000`, `http://localhost:3000`).
