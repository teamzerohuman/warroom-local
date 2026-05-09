#!/usr/bin/env bash
set -euo pipefail

ALLY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CLICKTECH_ENV_FILE:-$ALLY_DIR/.env.local}"
SERVER_NAME="${LOGROCKET_MCP_SERVER_NAME:-logrocket-clicktech}"

DO_CODEX=0
DO_CLAUDE=0
DRY_RUN=0
RUN_LOGIN=0

usage() {
  cat <<'USAGE'
Usage: scripts/setup-logrocket-mcp.sh [--codex] [--claude] [--all] [--login] [--dry-run]

Configures ClickTech-scoped LogRocket MCP access for local MCP clients.

Reads these values from the shell environment first, then allies/clicktech/.env.local:
  LOGROCKET_ORG_ID       LogRocket organization id.
  LOGROCKET_PROJECT_ID   Optional LogRocket project id.
  LOGROCKET_MCP_URL      Optional fully scoped URL override.
  LOGROCKET_API_KEY      Optional project-scoped API key for Codex bearer-token auth.

The resolved URL must be scoped:
  https://mcp.logrocket.com/mcp/<org>
  https://mcp.logrocket.com/mcp/<org>/<project>

Options:
  --codex       Configure Codex only.
  --claude      Configure Claude Code only.
  --all         Configure both Codex and Claude Code. This is the default.
  --login       Run Codex OAuth login after adding the server when no API key is set.
  --dry-run     Print commands without running them.
  --env-file    Read a different env file path.
  --name        Override MCP server name. Default: logrocket-clicktech.
  -h, --help    Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --codex)
      DO_CODEX=1
      shift
      ;;
    --claude)
      DO_CLAUDE=1
      shift
      ;;
    --all)
      DO_CODEX=1
      DO_CLAUDE=1
      shift
      ;;
    --login)
      RUN_LOGIN=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --env-file)
      ENV_FILE="${2:?missing value for --env-file}"
      shift 2
      ;;
    --name)
      SERVER_NAME="${2:?missing value for --name}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$DO_CODEX" -eq 0 && "$DO_CLAUDE" -eq 0 ]]; then
  DO_CODEX=1
  DO_CLAUDE=1
fi

read_env_value() {
  local key="$1"
  local raw

  if [[ -n "${!key:-}" || ! -f "$ENV_FILE" ]]; then
    return 0
  fi

  raw="$(
    awk -v key="$key" '
      /^[[:space:]]*(#|$)/ { next }
      {
        line = $0
        sub(/^[[:space:]]*export[[:space:]]+/, "", line)
        if (line ~ "^[[:space:]]*" key "[[:space:]]*=") {
          sub(/^[^=]*=/, "", line)
          print line
        }
      }
    ' "$ENV_FILE" | tail -n 1
  )"

  if [[ -z "$raw" ]]; then
    return 0
  fi

  raw="$(printf '%s' "$raw" | sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "$raw" == \"*\" && "$raw" == *\" ]]; then
    raw="${raw:1:${#raw}-2}"
  elif [[ "$raw" == \'*\' && "$raw" == *\' ]]; then
    raw="${raw:1:${#raw}-2}"
  fi

  printf -v "$key" '%s' "$raw"
  export "$key"
}

print_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run_command() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    print_command "$@"
  else
    "$@"
  fi
}

resolve_url() {
  local url org project

  url="${LOGROCKET_MCP_URL:-}"
  org="${LOGROCKET_ORG_ID:-}"
  project="${LOGROCKET_PROJECT_ID:-}"

  if [[ -z "$url" && -n "$org" && -n "$project" ]]; then
    url="https://mcp.logrocket.com/mcp/$org/$project"
  elif [[ -z "$url" && -n "$org" ]]; then
    url="https://mcp.logrocket.com/mcp/$org"
  elif [[ -z "$url" && -n "$project" ]]; then
    echo "LOGROCKET_PROJECT_ID requires LOGROCKET_ORG_ID." >&2
    exit 2
  fi

  while [[ "$url" == */ ]]; do
    url="${url%/}"
  done

  if [[ -z "$url" ]]; then
    cat >&2 <<'ERROR'
Missing ClickTech LogRocket MCP scope.

Add LOGROCKET_ORG_ID and optionally LOGROCKET_PROJECT_ID to allies/clicktech/.env.local,
or set LOGROCKET_MCP_URL to a scoped URL:
  https://mcp.logrocket.com/mcp/<org>
  https://mcp.logrocket.com/mcp/<org>/<project>
ERROR
    exit 2
  fi

  if [[ "$url" == "https://mcp.logrocket.com/mcp" ]]; then
    echo "Refusing to configure unscoped LogRocket MCP URL for ClickTech work." >&2
    exit 2
  fi

  case "$url" in
    https://mcp.logrocket.com/mcp/*)
      printf '%s' "$url"
      ;;
    *)
      echo "Unexpected LOGROCKET_MCP_URL: $url" >&2
      echo "Expected https://mcp.logrocket.com/mcp/<org>[/<project>]." >&2
      exit 2
      ;;
  esac
}

read_env_value LOGROCKET_MCP_URL
read_env_value LOGROCKET_ORG_ID
read_env_value LOGROCKET_PROJECT_ID
read_env_value LOGROCKET_API_KEY

configure_codex() {
  local url="$1"
  local cmd

  if [[ "$DRY_RUN" -eq 0 ]] && ! command -v codex >/dev/null 2>&1; then
    echo "Codex CLI not found; skipping Codex MCP setup." >&2
    return 0
  fi

  cmd=(codex mcp add "$SERVER_NAME" --url "$url")
  if [[ -n "${LOGROCKET_API_KEY:-}" ]]; then
    cmd+=(--bearer-token-env-var LOGROCKET_API_KEY)
  fi

  run_command "${cmd[@]}"

  if [[ -n "${LOGROCKET_API_KEY:-}" ]]; then
    echo "Codex configured for $SERVER_NAME with bearer-token env var LOGROCKET_API_KEY."
  elif [[ "$RUN_LOGIN" -eq 1 ]]; then
    run_command codex mcp login "$SERVER_NAME"
  else
    echo "Codex configured for $SERVER_NAME. Run: codex mcp login $SERVER_NAME"
  fi
}

configure_claude() {
  local url="$1"
  local cmd

  if [[ "$DRY_RUN" -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
    echo "Claude Code CLI not found; skipping Claude MCP setup." >&2
    return 0
  fi

  cmd=(claude mcp add --scope local --transport http "$SERVER_NAME" "$url")
  run_command "${cmd[@]}"
  echo "Claude Code configured for $SERVER_NAME. In Claude Code, run /mcp to authenticate."
}

LOGROCKET_RESOLVED_MCP_URL="$(resolve_url)"
echo "Using LogRocket MCP URL: $LOGROCKET_RESOLVED_MCP_URL"

if [[ "$DO_CODEX" -eq 1 ]]; then
  configure_codex "$LOGROCKET_RESOLVED_MCP_URL"
fi

if [[ "$DO_CLAUDE" -eq 1 ]]; then
  configure_claude "$LOGROCKET_RESOLVED_MCP_URL"
fi
