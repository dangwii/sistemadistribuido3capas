output "storage_class_name" {
  description = "StorageClass validada en K3s"
  value       = terraform_data.platform_namespaces_and_storage.input.storage_class_name
}

output "namespaces" {
  description = "Namespaces creados en el clúster"
  value       = terraform_data.platform_namespaces_and_storage.input.namespaces
}
