output "cluster_name" {
  value = module.k3s_nodes.cluster_name
}

output "kubeconfig_context" {
  value = module.k3s_nodes.kubeconfig_context
}

output "namespaces" {
  value = module.storage.namespaces
}

output "flux_enabled" {
  value = module.flux_bootstrap.flux_enabled
}
