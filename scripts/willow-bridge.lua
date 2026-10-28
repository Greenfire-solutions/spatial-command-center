--[[
  Willow -> Spatial Command Center

  The problem this solves: Willow dictates into whatever text field has focus on
  the Mac, and the field we want the text in is on a headset. So something on
  the Mac has to hold focus, receive the dictation, and forward it.

  An hs.chooser is that something. It is a native focused text field that can be
  shown and hidden instantly, its query is readable from Lua, and it restores
  the previously focused app on close. No webview, no extra window to manage.

  Flow, driven entirely by the A button on the right controller:

    A down  -> the bridge runs sccDictateStart()  -> chooser takes focus,
               Willow's push-to-talk is held down
    A up    -> the bridge runs sccDictateStop()   -> Willow released, the
               chooser's text is POSTed to the bridge and the chooser closes

  Install:
    cp scripts/willow-bridge.lua ~/.hammerspoon/willow-bridge.lua
    echo 'require("willow-bridge")' >> ~/.hammerspoon/init.lua
    hs -c 'hs.reload()'

  Then start the server with hooks pointing at it:
    SCC_DICTATE_START="hs -c 'sccDictateStart()'" \
    SCC_DICTATE_STOP="hs -c 'sccDictateStop()'" \
    SCC_VOICE_TOKEN=<secret> ... npx vite preview ...
--]]

local M = {}

-- Where the bridge is listening, and the shared secret it expects.
local BRIDGE_URL   = os.getenv("SCC_BRIDGE_URL")   or "http://127.0.0.1:4180/voice/say"
local VOICE_TOKEN  = os.getenv("SCC_VOICE_TOKEN")  or ""

-- Willow's push-to-talk binding. The memory of this rig says Ctrl+Opt+D was
-- added as a second trigger precisely because the original Fn/globe binding is
-- resolved in keyboard firmware and can never be synthesised.
local WILLOW_MODS = { "ctrl", "alt" }
local WILLOW_KEY  = "d"

-- Willow needs a moment after the key is released before its final text lands
-- in the field. Reading too early truncates the last word.
local SETTLE_SECONDS = 0.45

local chooser = nil
local previousApp = nil

local function ensureChooser()
  if chooser then return chooser end
  chooser = hs.chooser.new(function() end)
  chooser:choices({})
  chooser:placeholderText("Speak a command…")
  chooser:searchSubText(false)
  chooser:width(30)
  return chooser
end

local function post(text)
  if not text or text == "" then return end
  local headers = { ["Content-Type"] = "application/json" }
  if VOICE_TOKEN ~= "" then headers["x-voice-token"] = VOICE_TOKEN end
  local body = hs.json.encode({ text = text, final = true })
  hs.http.asyncPost(BRIDGE_URL, body, headers, function(status)
    if status ~= 204 then
      hs.printf("[willow-bridge] bridge replied %d", status)
    end
  end)
end

--- Called when push-to-talk goes down on the controller.
function sccDictateStart()
  previousApp = hs.application.frontmostApplication()
  local c = ensureChooser()
  c:query("")
  c:show()
  -- Held, not tapped: Willow is push-to-talk, so the key stays down while the
  -- controller button does.
  hs.eventtap.event.newKeyEvent(WILLOW_MODS, WILLOW_KEY, true):post()
  return "started"
end

--- Called when push-to-talk comes back up.
function sccDictateStop()
  hs.eventtap.event.newKeyEvent(WILLOW_MODS, WILLOW_KEY, false):post()

  hs.timer.doAfter(SETTLE_SECONDS, function()
    local c = ensureChooser()
    local text = c:query() or ""
    c:query("")
    c:hide()
    -- Give focus back to whatever was in front, so dictating never steals the
    -- user's place in another app.
    if previousApp then previousApp:activate() end
    previousApp = nil
    post(text)
    hs.printf("[willow-bridge] heard: %s", text)
  end)
  return "stopped"
end

--- Send text without speaking, for testing the wire on its own.
function sccDictateSay(text)
  post(text)
  return "sent"
end

return M
