# Bootstrap de FluxCD controlado por bandera (Fase 5).
# Requiere GITHUB_TOKEN en el entorno (nunca guardado en el repositorio) y CLI `flux` instalada.
resource "terraform_data" "flux_bootstrap" {
  count = var.enable_flux ? 1 : 0

  input = {
    kubeconfig_context = var.kubeconfig_context
    github_owner       = var.github_owner
    github_repository  = var.github_repository
    branch             = var.branch
    cluster_path       = var.cluster_path
  }

  provisioner "local-exec" {
    interpreter = ["PowerShell", "-Command"]
    command     = <<-EOT
      if (-not $env:GITHUB_TOKEN) {
        Write-Error "Define GITHUB_TOKEN antes de habilitar FluxCD bootstrap."
        exit 1
      }
      flux bootstrap github `
        --context="${self.input.kubeconfig_context}" `
        --owner="${self.input.github_owner}" `
        --repository="${self.input.github_repository}" `
        --branch="${self.input.branch}" `
        --path="${self.input.cluster_path}" `
        --personal `
        --components="source-controller,kustomize-controller,helm-controller"
    EOT
  }
}
