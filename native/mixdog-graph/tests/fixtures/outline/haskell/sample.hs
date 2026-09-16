module Demo.Accounts
  ( User (..)
  , greet
  , render
  ) where

import Data.Text (Text, pack)
import qualified Data.Map as Map
import Control.Monad (when)

data User = User
  { userName :: Text
  , userId :: Int
  }

newtype UserId = UserId Int

type Name = Text

class Render a where
  render :: a -> Text
  renderPrec :: Int -> a -> Text
  renderPrec _ = render

instance Render User where
  render (User name _) = name

greet :: User -> Text
greet user = pack "hello " <> userName user

fromMap :: Map.Map Int User -> Maybe User
fromMap = Map.lookup 1

answer = 42
