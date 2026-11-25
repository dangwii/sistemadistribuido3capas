variable "network_name" {
  description = "Nombre de la red Docker dedicada para el clúster K3s"
  type        = string
}

variable "subnet_cidr" {
  description = "Subred CIDR asignada al clúster K3s"
  type        = string
  default     = "172.32.0.0/24"
}
