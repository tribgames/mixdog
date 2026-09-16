# A nested directory is its OWN module: `source = "./modules/vpc"` must not
# reach this file.
resource "aws_subnet" "deep" {
  vpc_id = "vpc-0"
}
