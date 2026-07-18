#!/usr/bin/env bash
# kelivo-shim runtime: install Claude Code if missing, wire OB memory, run the shim.
export DEBIAN_FRONTEND=noninteractive

# claude-code + gmail-mcp now come from package.json (installed at BUILD time by
# zbpack), so boot only needs the platform-native binary (postinstall is blocked by
# npm allowScripts). install.cjs downloads it; retry for network flakes.
CC_PKG="/src/node_modules/@anthropic-ai/claude-code"
[ -d "$CC_PKG" ] || CC_PKG="$(npm root -g)/@anthropic-ai/claude-code"
export CLAUDE_BIN="$CC_PKG/bin/claude.exe"
for i in 1 2 3 4 5; do
  if "$CLAUDE_BIN" --version >/dev/null 2>&1; then break; fi
  echo "[entrypoint] claude native binary missing, fetching (attempt $i)..."
  (cd "$CC_PKG" && node install.cjs) || true
  sleep 3
done
"$CLAUDE_BIN" --version || echo "[entrypoint] WARNING: claude still not runnable"

unset ANTHROPIC_API_KEY   # subscription channel must win

# Voice fallback transcoder: only needed if ElevenLabs can't serve Ogg/Opus
# directly (plan-gated formats) — then mp3 gets transcoded via ffmpeg.
# Install is best-effort; without it opus-direct still works.
if [ -n "$ELEVENLABS_API_KEY" ] && ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[entrypoint] installing ffmpeg (voice mp3 fallback)..."
  (apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg) \
    || echo "[entrypoint] ffmpeg install failed; voice works only if opus-direct is available"
fi

# Gmail MCP: creds uploaded in gmail-auth/ (non-dot dir survives upload); server
# reads them from ~/.gmail-mcp/. Pre-install so npx resolves without a cold download.
if [ -d gmail-auth ]; then
  mkdir -p "${HOME:-/root}/.gmail-mcp"
  cp gmail-auth/* "${HOME:-/root}/.gmail-mcp/" || true
fi

# MCP config (regenerated each boot; dotfiles may not survive upload)
if [ ! -f .mcp.json ]; then
  cat > .mcp.json <<'JSON'
{ "mcpServers": {
  "ombre": { "type": "http", "url": "https://<你的记忆MCP域名>/mcp" },
  "fish":  { "type": "http", "url": "https://<你的其他MCP域名>/mcp" },
  "gmail": { "command": "npx", "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"] }
} }
JSON
fi

# Trust the workspace so CLAUDE.md loads cleanly (permissions come from --allowedTools).
printf '%s' '{"hasCompletedOnboarding":true,"projects":{"/src":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' > "${HOME:-/root}/.claude.json"

exec node server.js
