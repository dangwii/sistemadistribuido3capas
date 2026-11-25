variable "cluster_name" {
  type    = string
  default = "mini-imdb-prod"
}

variable "network_name" {
  type    = string
  default = "k3d-mini-imdb-prod"
}

variable "subnet_cidr" {
  type    = string
  default = "172.33.0.0/24"
}

variable "server_count" {
  type    = number
  default = 3
}

variable "agent_count" {
  type    = number
  default = 2
}

variable "http_port" {
  type    = number
  default = 8080
}

variable "https_port" {
  type    = number
  default = 8443
}

variable "enable_flux" {
  type    = bool
  default = true
}
