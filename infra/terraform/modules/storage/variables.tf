variable "kubeconfig_context" {
  description = "Contexto kubectl del clúster K3s"
  type        = string
}

variable "namespaces" {
  description = "Namespaces base de la plataforma Mini-IMDb"
  type        = list(string)
  default     = ["mini-imdb", "data", "observability", "security"]
}

variable "storage_class_name" {
  description = "StorageClass predeterminada en K3s (local-path)"
  type        = string
  default     = "local-path"
}
