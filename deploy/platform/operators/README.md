# Operadores de Capa de Datos para Producción

En el entorno `dev` (clúster K3s local con 7.6 GiB de RAM en Docker Desktop), la capa de datos se despliega mediante `StatefulSet` optimizados en `deploy/platform/data/` para dejar memoria disponible para RabbitMQ, FluxCD, Grafana LGTM y Wazuh.

Para el entorno `prod` con múltiples nodos dedicados (16+ GiB RAM por nodo), se instalan los siguientes operadores mediante Helm/Flux:

- **MariaDB Operator (Galera Cluster + MaxScale):** `helm repo add mariadb-operator https://helm.mariadb.com/mariadb-operator`
- **MongoDB Community Kubernetes Operator:** `helm repo add mongodb https://mongodb.github.io/helm-charts`
- **Redis Operator / Sentinel:** `helm repo add bitnami https://charts.bitnami.com/bitnami`
- **RabbitMQ Cluster Operator:** `kubectl apply -f https://github.com/rabbitmq/cluster-operator/releases/latest/download/cluster-operator.yml`
