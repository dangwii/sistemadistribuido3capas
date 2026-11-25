output "flux_enabled" {
  description = "Indica si FluxCD fue inicializado en este entorno"
  value       = var.enable_flux
}

output "cluster_path" {
  description = "Ruta GitOps asignada al entorno"
  value       = var.cluster_path
}
