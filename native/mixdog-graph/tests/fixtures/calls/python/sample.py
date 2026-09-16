# hidden()
quoted = "hidden()"

def inner():
    return None

def leaf(x):
    return x

def nest(x):
    return x

def helper():
    return None

def seed():
    return None

def plain():
    return None

def deco():
    return lambda fn: fn

@deco()
def run(a):
    inner()
    nest(leaf(1))
    a.b().c()

class Widget:
    def ping(self):
        return None

    def act(self):
        helper()
        self.ping()

plain()
mark = "μ"; seed()
Widget()
