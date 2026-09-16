-- Resolution fixture: two ancestors up. Nothing resolves in `app/deep` or in
-- `app`, so the search only finds `Acme.Util` when it reaches the project root
-- and tries its `src/` source dir.
module Far where

import Acme.Util (shout)

far :: String
far = shout "far"
