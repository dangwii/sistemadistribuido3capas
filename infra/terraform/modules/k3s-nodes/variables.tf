variable "cluster_name" {
  description = "Nombre del clúster K3s"
  type        = string
}

variable "server_count" {
  description = "Número de nodos server K3s (3 para HA con etcd embebido)"
  type        = number
  default     = 3
}

variable "agent_count" {
  description = "Número de nodos worker adicionales"
  type        = number
  default     = 0
}

variable "network_name" {
  description = "Nombre de la red Docker donde se desplegará K3s"
  type        = string
}

variable "k3s_image" {
  description = "Imagen oficial de K3s a utilizar en k3d"
  type        = string
  default     = "rancher/k3s:v1.31.4-k3s1"
}

variable "http_port" {
  description = "Puerto HTTP del host mapeado al Ingress Traefik de K3s"
  type        = number
  default     = 80
}

variable "https_port" {
  description = "Puerto HTTPS del host mapeado al Ingress Traefik de K3s"
  type        = number
  default     = 443
}
