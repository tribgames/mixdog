-- Resolution fixture: the module search path walks up from this file.
module Main where

-- Found under the project root's `src/`.
import Acme.Util (shout)
-- Found next to this file, in `app/`.
import Sibling (helper)
-- Not in this project: an external package, not an edge.
import Data.List (sort)

main :: IO ()
main = putStrLn (shout (helper (sort ["b", "a"])))
