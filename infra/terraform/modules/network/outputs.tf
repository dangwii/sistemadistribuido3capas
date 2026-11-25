output "network_name" {
  description = "Nombre de la red aprovisionada para K3s"
  value       = terraform_data.k3s_network.input.network_name
}

output "subnet_cidr" {
  description = "Subred CIDR configurada"
  value       = terraform_data.k3s_network.input.subnet_cidr
}
