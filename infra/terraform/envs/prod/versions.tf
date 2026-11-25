terraform {
  required_version = ">= 1.6.0"

  # En producción, configurar backend remoto con state locking:
  # backend "s3" {
  #   bucket         = "mini-imdb-tfstate"
  #   key            = "prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "mini-imdb-tflocks"
  #   encrypt        = true
  # }
}
