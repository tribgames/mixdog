module Sample where

-- hidden()
quoted :: String
quoted = "hidden()"

data Widget = Widget Int

inner :: Int -> Int
inner x = x

leaf :: Int -> Int
leaf x = x

nest :: Int -> Int
nest x = x

helper :: Int -> Int
helper x = x

seed :: Int -> Int
seed x = x

plain :: Int -> Int
plain x = x

top :: Int
top = plain 1

run :: Int -> Int
run x = inner x

nested :: Int -> Int
nested x = nest (leaf x)

qualifiedCall :: Int -> Int
qualifiedCall x = Foo.bar x

built :: Widget
built = Widget 1

class C a where
  act :: a -> a

instance C Int where
  act n = helper n

seeded :: Int
seeded = let _ = "μ" in seed 0
