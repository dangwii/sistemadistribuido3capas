variable "enable_flux" {
  description = "Habilita el bootstrap de FluxCD en el clúster (se activa en Fase 5)"
  type        = bool
  default     = false
}

variable "kubeconfig_context" {
  description = "Contexto kubectl objetivo para FluxCD"
  type        = string
}

variable "github_owner" {
  description = "Usuario u organización de GitHub"
  type        = string
  default     = "dangwii"
}

variable "github_repository" {
  description = "Nombre del repositorio GitOps"
  type        = string
  default     = "sistemadistribuido3capas"
}

variable "branch" {
  description = "Rama observada por FluxCD"
  type        = string
  default     = "main"
}

variable "cluster_path" {
  description = "Ruta dentro del repositorio para el entorno del clúster"
  type        = string
  default     = "clusters/dev"
}
