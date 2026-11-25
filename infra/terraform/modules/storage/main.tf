resource "terraform_data" "platform_namespaces_and_storage" {
  input = {
    kubeconfig_context = var.kubeconfig_context
    namespaces         = var.namespaces
    storage_class_name = var.storage_class_name
  }

  provisioner "local-exec" {
    interpreter = ["PowerShell", "-Command"]
    command     = <<-EOT
      kubectl --context "${self.input.kubeconfig_context}" get storageclass ${self.input.storage_class_name}
      foreach ($ns in @(${join(",", [for ns in var.namespaces : "'${ns}'"])})) {
        kubectl --context "${self.input.kubeconfig_context}" create namespace $ns --dry-run=client -o yaml | kubectl --context "${self.input.kubeconfig_context}" apply -f -
      }
    EOT
  }
}
