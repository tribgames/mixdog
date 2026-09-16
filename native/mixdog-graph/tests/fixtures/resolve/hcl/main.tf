# Resolution fixture: a local module source is a DIRECTORY, so the edge fans
# out to every .tf file directly inside it.
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

module "vpc" {
  source = "./modules/vpc"
  cidr   = "10.0.0.0/16"
}

# Registry source: a remote dependency, not a file in this repository.
module "consul" {
  source  = "hashicorp/consul/aws"
  version = "0.11.0"
}

resource "aws_instance" "web" {
  subnet_id = module.vpc.subnet_id
}
