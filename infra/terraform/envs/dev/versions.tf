terraform {
  required_version = ">= 1.6.0"

  # Para equipos distribuidos / producción, habilitar backend remoto con bloqueo:
  # backend "s3" {
  #   bucket         = "mini-imdb-tfstate"
  #   key            = "dev/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "mini-imdb-tflocks"
  #   encrypt        = true
  # }
}
