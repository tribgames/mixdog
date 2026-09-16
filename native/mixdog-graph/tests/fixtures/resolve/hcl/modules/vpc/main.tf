resource "aws_vpc" "this" {
  cidr_block = var.cidr
}

output "subnet_id" {
  value = aws_vpc.this.id
}
