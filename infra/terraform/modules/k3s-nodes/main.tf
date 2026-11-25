resource "terraform_data" "k3s_cluster" {
  triggers_replace = [
    var.cluster_name,
    var.server_count,
    var.agent_count,
    var.network_name,
    var.k3s_image,
    var.http_port,
    var.https_port,
  ]

  input = {
    cluster_name = var.cluster_name
    server_count = var.server_count
    agent_count  = var.agent_count
    network_name = var.network_name
    k3s_image    = var.k3s_image
    http_port    = var.http_port
    https_port   = var.https_port
  }

  provisioner "local-exec" {
    interpreter = ["PowerShell", "-Command"]
    command     = <<-EOT
      $existing = k3d cluster list --no-headers | Select-String -Pattern "^${self.input.cluster_name}\s"
      if (-not $existing) {
        k3d cluster create ${self.input.cluster_name} `
          --image ${self.input.k3s_image} `
          --servers ${self.input.server_count} `
          --agents ${self.input.agent_count} `
          --network ${self.input.network_name} `
          -p "${self.input.http_port}:80@loadbalancer" `
          -p "${self.input.https_port}:443@loadbalancer" `
          --wait
      }
      kubectl config use-context "k3d-${self.input.cluster_name}"
    EOT
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["PowerShell", "-Command"]
    command     = "k3d cluster delete ${self.input.cluster_name}; exit 0"
  }
}
