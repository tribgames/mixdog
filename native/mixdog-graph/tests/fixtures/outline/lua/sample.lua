local M = {}

require("socket.http")
require 'json'
require("config.loader")

-- commented require should not appear
-- require("dead")

function greet(name)
  return "hello " .. tostring(name)
end

local function helper(x)
  return x + 1
end

function M.encode(value)
  return json.encode(value)
end

function M:reset()
  self.state = {}
end

function M.nested.deep()
  return helper(2)
end

local anon = function(x)
  return x
end

function M.run(input)
  local encoded = M.encode(input)
  return greet(encoded)
end

return M
