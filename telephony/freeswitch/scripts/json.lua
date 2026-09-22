--[[
A minimal, decode-only JSON parser for the FreeSWITCH Lua scripts in this
directory (S2-10's `flow_runner.lua` is the first caller).

Why this exists rather than a library:

  - `voicemail.lua` (S2-16) gets away with `string.match` because every
    response it reads is flat and known-shape. The call-flow IR is not: it is
    a map of node ids to nested objects, each with its own `config` and
    `ports` sub-objects. Pattern matching cannot parse that correctly, and a
    parser that is *almost* right on a call-routing hot path is worse than
    none.
  - Whether this image's `mod_lua` build exposes a JSON helper
    (`freeswitch.JSON`, cJSON, dkjson) is exactly the sort of unverified
    FreeSWITCH assumption that has cost this codebase real debugging time
    (docs/decisions.md G-19/G-20/G-24). Vendoring ~120 lines of pure Lua
    removes the question entirely.

Decode only: nothing here needs to *emit* JSON. `flow_runner.lua` sends no
request bodies, and the one service call it makes is a GET.

Returns Lua values: objects -> tables keyed by string, arrays -> tables keyed
by 1..n, `null` -> the sentinel `json.null` (so a present-but-null field is
distinguishable from an absent one), and numbers/strings/booleans natively.
--]]

local json = {}

-- A unique sentinel for JSON null. `nil` cannot be stored in a Lua table, so
-- without this a null-valued key would be indistinguishable from a missing
-- one.
json.null = setmetatable({}, { __tostring = function() return "null" end })

local ESCAPES = {
  ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b',
  f = '\f', n = '\n', r = '\r', t = '\t',
}

local function skipWhitespace(str, pos)
  local _, stop = str:find("^[ \t\r\n]*", pos)
  return stop + 1
end

local function decodeError(str, pos, message)
  error(string.format("json: %s at position %d", message, pos), 0)
end

-- Encodes a Unicode code point as UTF-8. FreeSWITCH's Lua is 5.1/5.2, where
-- `utf8.char` does not exist, so this is done by hand.
local function utf8Char(codepoint)
  if codepoint < 0x80 then
    return string.char(codepoint)
  elseif codepoint < 0x800 then
    return string.char(0xC0 + math.floor(codepoint / 0x40), 0x80 + codepoint % 0x40)
  elseif codepoint < 0x10000 then
    return string.char(
      0xE0 + math.floor(codepoint / 0x1000),
      0x80 + math.floor(codepoint / 0x40) % 0x40,
      0x80 + codepoint % 0x40
    )
  end
  return string.char(
    0xF0 + math.floor(codepoint / 0x40000),
    0x80 + math.floor(codepoint / 0x1000) % 0x40,
    0x80 + math.floor(codepoint / 0x40) % 0x40,
    0x80 + codepoint % 0x40
  )
end

local decodeValue

local function decodeString(str, pos)
  -- pos points at the opening quote.
  local out = {}
  local i = pos + 1
  while true do
    local char = str:sub(i, i)
    if char == "" then decodeError(str, i, "unterminated string") end
    if char == '"' then return table.concat(out), i + 1 end

    if char == "\\" then
      local escape = str:sub(i + 1, i + 1)
      local simple = ESCAPES[escape]
      if simple ~= nil then
        out[#out + 1] = simple
        i = i + 2
      elseif escape == "u" then
        local hex = str:sub(i + 2, i + 5)
        local codepoint = tonumber(hex, 16)
        if codepoint == nil then decodeError(str, i, "bad \\u escape") end
        i = i + 6
        -- A surrogate pair encodes one code point above the BMP as two
        -- \u escapes; decode both before emitting, or the result is mojibake.
        if codepoint >= 0xD800 and codepoint <= 0xDBFF and str:sub(i, i + 1) == "\\u" then
          local low = tonumber(str:sub(i + 2, i + 5), 16)
          if low ~= nil and low >= 0xDC00 and low <= 0xDFFF then
            codepoint = 0x10000 + (codepoint - 0xD800) * 0x400 + (low - 0xDC00)
            i = i + 6
          end
        end
        out[#out + 1] = utf8Char(codepoint)
      else
        decodeError(str, i, "invalid escape '\\" .. escape .. "'")
      end
    else
      out[#out + 1] = char
      i = i + 1
    end
  end
end

local function decodeNumber(str, pos)
  local literal = str:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
  local value = tonumber(literal)
  if value == nil then decodeError(str, pos, "invalid number") end
  return value, pos + #literal
end

local function decodeArray(str, pos)
  local out, i, n = {}, pos + 1, 0
  i = skipWhitespace(str, i)
  if str:sub(i, i) == "]" then return out, i + 1 end
  while true do
    local value
    value, i = decodeValue(str, skipWhitespace(str, i))
    n = n + 1
    out[n] = value
    i = skipWhitespace(str, i)
    local char = str:sub(i, i)
    if char == "]" then return out, i + 1 end
    if char ~= "," then decodeError(str, i, "expected ',' or ']' in array") end
    i = i + 1
  end
end

local function decodeObject(str, pos)
  local out, i = {}, pos + 1
  i = skipWhitespace(str, i)
  if str:sub(i, i) == "}" then return out, i + 1 end
  while true do
    i = skipWhitespace(str, i)
    if str:sub(i, i) ~= '"' then decodeError(str, i, "expected a string key in object") end
    local key
    key, i = decodeString(str, i)
    i = skipWhitespace(str, i)
    if str:sub(i, i) ~= ":" then decodeError(str, i, "expected ':' after object key") end
    local value
    value, i = decodeValue(str, skipWhitespace(str, i + 1))
    out[key] = value
    i = skipWhitespace(str, i)
    local char = str:sub(i, i)
    if char == "}" then return out, i + 1 end
    if char ~= "," then decodeError(str, i, "expected ',' or '}' in object") end
    i = i + 1
  end
end

decodeValue = function(str, pos)
  local char = str:sub(pos, pos)
  if char == "{" then return decodeObject(str, pos) end
  if char == "[" then return decodeArray(str, pos) end
  if char == '"' then return decodeString(str, pos) end
  if char == "t" and str:sub(pos, pos + 3) == "true" then return true, pos + 4 end
  if char == "f" and str:sub(pos, pos + 4) == "false" then return false, pos + 5 end
  if char == "n" and str:sub(pos, pos + 3) == "null" then return json.null, pos + 4 end
  if char:match("[%d-]") then return decodeNumber(str, pos) end
  decodeError(str, pos, "unexpected character '" .. char .. "'")
end

--[[
Parses `str`. Returns the decoded value, or `nil` plus a message when the
input is not valid JSON — callers on a call-routing path must be able to
branch on a parse failure rather than have the script abort mid-call, so this
never raises.
--]]
function json.decode(str)
  if type(str) ~= "string" or str == "" then return nil, "json: empty input" end

  local ok, value, pos = pcall(function()
    local v, p = decodeValue(str, skipWhitespace(str, 1))
    return v, p
  end)
  if not ok then return nil, tostring(value) end

  -- Trailing garbage means this was not one well-formed document, which for
  -- an HTTP response usually means an error page, not JSON.
  if skipWhitespace(str, pos) <= #str then
    return nil, "json: trailing content after the top-level value"
  end
  return value
end

return json
