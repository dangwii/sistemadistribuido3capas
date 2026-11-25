resource "terraform_data" "k3s_network" {
  input = {
    network_name = var.network_name
    subnet_cidr  = var.subnet_cidr
  }

  provisioner "local-exec" {
    interpreter = ["PowerShell", "-Command"]
    command     = "docker network inspect ${self.input.network_name} *> $null; if ($LASTEXITCODE -ne 0) { docker network create --subnet ${self.input.subnet_cidr} ${self.input.network_name} }"
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["PowerShell", "-Command"]
    command     = "docker network rm ${self.input.network_name} *> $null; exit 0"
  }
}
