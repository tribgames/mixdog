# hidden()

locals {
  decoy = "hidden()"
  top   = file("a.txt")
}

variable "run" {
  type    = string
  default = lookup({ a = "x" }, "a")
}

resource "aws_instance" "web" {
  ami = file(lookup({ k = "i-1" }, "k"))
  tags = {
    Name = "μ-${format("%s", "web")}"
  }
}
