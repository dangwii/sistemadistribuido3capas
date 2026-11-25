output "cluster_name" {
  description = "Nombre del clúster K3s creado"
  value       = terraform_data.k3s_cluster.input.cluster_name
}

output "kubeconfig_context" {
  description = "Contexto kubectl generado para el clúster"
  value       = "k3d-${terraform_data.k3s_cluster.input.cluster_name}"
}

output "server_count" {
  description = "Cantidad de nodos control-plane con etcd embebido"
  value       = terraform_data.k3s_cluster.input.server_count
}
