module Acme.Internal.Helper (upper) where

import Data.Char (toUpper)

upper :: String -> String
upper = map toUpper
