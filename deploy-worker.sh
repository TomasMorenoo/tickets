#!/bin/bash
set -u

QUEUE_DIR=/vps/clientes/tickets/data/deploy-queue
LOG_FILE=/var/log/bitacora-deploy.log
TICKETS_COMPOSE=/etc/bitacora-deploy/tickets-compose.yml
DRP_COMPOSE=/etc/bitacora-deploy/drpiscinas-compose.yml

mkdir -p "$QUEUE_DIR"
shopt -s nullglob

notify() {
  local message="$1"
  local env_file=/vps/clientes/tickets/.env
  local token chat_id
  token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$env_file" | tail -n 1 | tr -d '\r')
  chat_id=$(sed -n 's/^TELEGRAM_ALLOWED_CHAT_ID=//p' "$env_file" | tail -n 1 | tr -d '\r')
  if [[ -n "$token" && -n "$chat_id" ]]; then
    curl -fsS --max-time 20 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat_id}" \
      --data-urlencode "text=${message}" >/dev/null 2>&1 || true
  fi
}

for request in "$QUEUE_DIR"/*.request; do
  name=$(basename "$request")
  ticket=$(sed -n 's/^ticket=\([A-Z0-9-]\{1,32\}\)$/\1/p' "$request" | head -n 1)
  [[ -n "$ticket" ]] || ticket="Ticket"
  success=false

  case "$name" in
    tickets__*)
      if docker compose --project-directory /vps/clientes/tickets -f "$TICKETS_COMPOSE" up -d --build web telegram whatsapp >>"$LOG_FILE" 2>&1; then
        success=true
      fi
      ;;
    drpiscinas__*)
      if docker compose --project-directory /vps/clientes/drPiscinas -f "$DRP_COMPOSE" up -d --build web >>"$LOG_FILE" 2>&1; then
        success=true
      fi
      ;;
  esac

  rm -f -- "$request"
  if [[ "$success" == true ]]; then
    notify "✅ ${ticket} desplegado y aplicación reiniciada. Ya podés revisarlo."
  else
    notify "❌ Falló el despliegue de ${ticket}. Revisá /var/log/bitacora-deploy.log."
  fi
done
