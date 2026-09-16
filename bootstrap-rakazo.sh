#!/usr/bin/env bash
# One-shot: install Docker (moby), open Ollama for containers, start Rakazo.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
MODE="${1:-all}"

elevate() {
  if [[ "${EUID}" -eq 0 ]]; then
    return 0
  fi
  if command -v pkexec >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
    exec pkexec env DISPLAY="$DISPLAY" XAUTHORITY="${XAUTHORITY:-}" \
      HOME="$HOME" PATH="$PATH" bash "$ROOT/bootstrap-rakazo.sh" install
  fi
  exec sudo -E bash "$ROOT/bootstrap-rakazo.sh" install
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "Docker already installed: $(docker --version)"
  else
    echo "Installing moby-engine + docker-cli + docker-compose…"
    dnf -y install moby-engine docker-cli docker-compose
  fi
  systemctl enable --now docker
  usermod -aG docker cr1m3 || true
}

open_ollama() {
  local dropin="/etc/systemd/system/ollama.service.d/rakazo-listen.conf"
  mkdir -p /etc/systemd/system/ollama.service.d
  if [[ ! -f "$dropin" ]] || ! grep -q 'OLLAMA_HOST=0.0.0.0:11434' "$dropin"; then
    cat >"$dropin" <<'EOF'
[Service]
# Allow Docker containers (host.docker.internal) to reach Ollama.
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF
    systemctl daemon-reload
    systemctl restart ollama
    echo "Ollama now listening on 0.0.0.0:11434"
  else
    echo "Ollama already configured for container access"
    systemctl is-active --quiet ollama || systemctl start ollama
  fi
}

start_rakazo() {
  cd "$ROOT"
  if ! docker info >/dev/null 2>&1; then
    echo "Cannot talk to Docker. Run:  newgrp docker"
    echo "Then:  bash $ROOT/bootstrap-rakazo.sh start"
    exit 1
  fi

  echo "Pulling and starting Rakazo images (this can take a while)…"
  docker compose --env-file .env \
    -f docker-compose.images.yml \
    -f docker-compose.override.yml \
    up -d

  echo
  echo "Waiting for web on http://127.0.0.1:5173 …"
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:5173/" >/dev/null 2>&1; then
      echo "Rakazo is up: http://127.0.0.1:5173"
      docker compose --env-file .env \
        -f docker-compose.images.yml \
        -f docker-compose.override.yml \
        ps
      return 0
    fi
    sleep 5
  done
  echo "Stack started but web not responding yet. Logs:"
  docker compose --env-file .env \
    -f docker-compose.images.yml \
    -f docker-compose.override.yml \
    logs --tail=100
  exit 1
}

case "$MODE" in
  all)
    # User-facing entry: escalate for install, then start as current user if possible.
    if [[ "${EUID}" -ne 0 ]]; then
      if ! command -v docker >/dev/null 2>&1 || ! systemctl is-active --quiet docker 2>/dev/null; then
        elevate
      fi
      # Docker present — still ensure Ollama listen + start stack
      if ! ss -ltn | grep -q '0.0.0.0:11434'; then
        elevate
      fi
      start_rakazo
    else
      install_docker
      open_ollama
      # Prefer starting as cr1m3 with docker group
      if id cr1m3 &>/dev/null; then
        runuser -u cr1m3 -- bash "$ROOT/bootstrap-rakazo.sh" start || \
          bash "$ROOT/bootstrap-rakazo.sh" start
      else
        start_rakazo
      fi
    fi
    ;;
  install)
    install_docker
    open_ollama
    echo "Install done. Starting stack as cr1m3…"
    runuser -u cr1m3 -- bash "$ROOT/bootstrap-rakazo.sh" start || \
      bash "$ROOT/bootstrap-rakazo.sh" start
    ;;
  start)
    start_rakazo
    ;;
  *)
    echo "Usage: $0 [all|install|start]"
    exit 2
    ;;
esac
