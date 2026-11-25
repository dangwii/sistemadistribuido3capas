# Entorno Terraform para despliegue real en equipo (2 computadoras en red LAN):
# - PC 1 (Daniel): 2 nodos (1 server + 1 agent)
# - PC 2 (Mariana): 1 nodo (1 agent)
# Total: 3 nodos K3s reales distribuidos entre ambas computadoras.

variable "server_ip" {
  description = "IP LAN de la VM server K3s en PC 1"
  type        = string
}

variable "agent_ips" {
  description = "IPs LAN de las VMs agent K3s (ej. 1 en PC 1 y 1 en PC 2)"
  type        = list(string)
}

variable "ssh_user" {
  description = "Usuario SSH de las VMs Ubuntu"
  type        = string
  default     = "ubuntu"
}

variable "ssh_private_key_path" {
  description = "Ruta local a la llave privada SSH (nunca subir a Git)"
  type        = string
  default     = "~/.ssh/id_ed25519"
}

variable "k3s_token" {
  description = "Token compartido del clúster K3s (pasar vía TF_VAR_k3s_token)"
  type        = string
  sensitive   = true
}

resource "terraform_data" "k3s_server" {
  input = {
    server_ip = var.server_ip
    ssh_user  = var.ssh_user
    key_path  = var.ssh_private_key_path
  }

  provisioner "local-exec" {
    interpreter = ["PowerShell", "-Command"]
    command     = <<-EOT
      ssh -i "${self.input.key_path}" -o StrictHostKeyChecking=no ${self.input.ssh_user}@${self.input.server_ip} `
        "curl -sfL https://get.k3s.io | K3S_TOKEN='$env:TF_VAR_k3s_token' sh -s - server --cluster-init --tls-san ${self.input.server_ip} --write-kubeconfig-mode 644"
    EOT
  }
}

resource "terraform_data" "k3s_agents" {
  for_each = toset(var.agent_ips)

  input = {
    agent_ip  = each.value
    server_ip = var.server_ip
    ssh_user  = var.ssh_user
    key_path  = var.ssh_private_key_path
  }

  provisioner "local-exec" {
    interpreter = ["PowerShell", "-Command"]
    command     = <<-EOT
      ssh -i "${self.input.key_path}" -o StrictHostKeyChecking=no ${self.input.ssh_user}@${self.input.agent_ip} `
        "curl -sfL https://get.k3s.io | K3S_URL='https://${self.input.server_ip}:6443' K3S_TOKEN='$env:TF_VAR_k3s_token' sh -s - agent"
    EOT
  }

  depends_on = [terraform_data.k3s_server]
}

output "k3s_api_endpoint" {
  value = "https://${var.server_ip}:6443"
}

output "cluster_nodes" {
  value = concat([var.server_ip], var.agent_ips)
}
