-- Parity fixture: declaration and import shapes the graph reports for Lua.
local json = require("dkjson")
local helper = require 'lib.helper'

local M = {}

function M.build(name)
  return setmetatable({ name = name }, { __index = M })
end

function M:read(key)
  return json.encode({ name = self.name, key = key })
end

local function normalize(value)
  return helper.trim(value)
end

function top_level(value)
  return normalize(value)
end

return M
