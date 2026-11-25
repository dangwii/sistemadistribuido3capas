variable "cluster_name" {
  type    = string
  default = "mini-imdb-dev"
}

variable "network_name" {
  type    = string
  default = "k3d-mini-imdb-dev"
}

variable "subnet_cidr" {
  type    = string
  default = "172.32.0.0/24"
}

variable "server_count" {
  type    = number
  default = 1
}

variable "agent_count" {
  type    = number
  default = 2
}

variable "http_port" {
  type    = number
  default = 80
}

variable "https_port" {
  type    = number
  default = 443
}

variable "enable_flux" {
  type    = bool
  default = false
}
