module "network" {
  source = "../../modules/network"

  network_name = var.network_name
  subnet_cidr  = var.subnet_cidr
}

module "k3s_nodes" {
  source = "../../modules/k3s-nodes"

  cluster_name = var.cluster_name
  server_count = var.server_count
  agent_count  = var.agent_count
  network_name = module.network.network_name
  http_port    = var.http_port
  https_port   = var.https_port

  depends_on = [module.network]
}

module "storage" {
  source = "../../modules/storage"

  kubeconfig_context = module.k3s_nodes.kubeconfig_context
  namespaces         = ["mini-imdb", "data", "observability", "security"]
  storage_class_name = "local-path"

  depends_on = [module.k3s_nodes]
}

module "flux_bootstrap" {
  source = "../../modules/flux-bootstrap"

  enable_flux        = var.enable_flux
  kubeconfig_context = module.k3s_nodes.kubeconfig_context
  cluster_path       = "clusters/prod"
  branch             = "release"

  depends_on = [module.storage]
}
