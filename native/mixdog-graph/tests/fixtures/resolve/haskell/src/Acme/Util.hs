module Acme.Util (shout) where

-- Resolves by walking up to `src/`, the nearest ancestor that holds it.
import Acme.Internal.Helper (upper)

shout :: String -> String
shout = upper
