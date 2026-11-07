#!/usr/bin/env bash
# =============================================================================
# Balance Scout – Bereitstellung in Azure Schweiz
#
# Voraussetzung: ./setup-entra.sh wurde ausgeführt (entra-ergebnis.env).
# Ausführen in der Azure Cloud Shell (Bash) im Ordner infra/:
#
#   ./deploy.sh --resource-group rg-balance-scout [--location switzerlandnorth]
#               [--sharepoint-drive <Drive-ID>] [--allow-ip 203.0.113.0/24 ...]
#               [--no-openai] [--copilot-variant workiq|graph-beta]
#
# Ablauf:
#   1. Ressourcengruppe + Infrastruktur (Bicep) mit Platzhalter-Image
#   2. Server-Image in der Azure Container Registry bauen (kein Docker nötig)
#   3. Infrastruktur erneut mit echtem Image ausrollen
#   4. Richtliniendatei für die Windows-App erzeugen (desktop-config.json)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

RG=""
LOCATION="switzerlandnorth"
SP_DRIVE=""
IPS=()
OPENAI=true
VARIANT="workiq"
ENV_FILE="entra-ergebnis.env"
VERSION="$(jq -r .version ../server/package.json)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group) RG="$2"; shift 2 ;;
    --location) LOCATION="$2"; shift 2 ;;
    --sharepoint-drive) SP_DRIVE="$2"; shift 2 ;;
    --allow-ip) IPS+=("$2"); shift 2 ;;
    --no-openai) OPENAI=false; shift ;;
    --copilot-variant) VARIANT="$2"; shift 2 ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$RG" ]] || { echo "--resource-group fehlt" >&2; exit 2; }
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE fehlt – zuerst ./setup-entra.sh ausführen." >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

step() { echo; echo "▶ $*"; }
IPS_JSON="$(printf '%s\n' "${IPS[@]:-}" | jq -R . | jq -cs 'map(select(length>0))')"

# Datenbank-Passwort: einmalig erzeugen und im Key Vault halten (bei Wiederholung aus Key Vault lesen)
step "Ressourcengruppe ${RG} (${LOCATION})"
az group create -n "$RG" -l "$LOCATION" --tags application=balance-scout dataResidency=CH -o none

KV_NAME="$(az keyvault list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)"
DB_PASSWORD=""
if [[ -n "$KV_NAME" ]]; then
  DB_PASSWORD="$(az keyvault secret show --vault-name "$KV_NAME" -n db-admin-password --query value -o tsv 2>/dev/null || true)"
fi
if [[ -z "$DB_PASSWORD" ]]; then
  DB_PASSWORD="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)Aa1!"
fi

deploy() {
  local image="$1"
  az deployment group create -g "$RG" -n "balance-scout-$(date +%Y%m%d%H%M%S)" -f main.bicep -o json \
    -p location="$LOCATION" serverImage="$image" tenantId="$TENANT_ID" \
       apiAudience="$API_AUDIENCE" apiClientId="$API_APP_ID" apiClientSecret="$API_CLIENT_SECRET" \
       dbAdminPassword="$DB_PASSWORD" enableM365Copilot="$WORKIQ_CONFIGURED" m365CopilotVariant="$VARIANT" \
       sharePointDriveId="$SP_DRIVE" deployAzureOpenAI="$OPENAI" allowedIpRanges="$IPS_JSON" \
    --query properties.outputs
}

step "Infrastruktur bereitstellen (Erstlauf mit Platzhalter-Image, dauert ca. 10–15 Min.)"
OUT="$(deploy "")"
ACR="$(jq -r .acrName.value <<<"$OUT")"
ACR_LOGIN="$(jq -r .acrLoginServer.value <<<"$OUT")"
KV_NAME="$(jq -r .keyVaultName.value <<<"$OUT")"

# Datenbank-Passwort im Key Vault sichern (für spätere Läufe). Der ausführende Benutzer braucht dafür
# die Rolle "Key Vault Secrets Officer" auf dem Vault.
ME="$(az ad signed-in-user show --query id -o tsv)"
az role assignment create --assignee-object-id "$ME" --assignee-principal-type User --role "Key Vault Secrets Officer" \
  --scope "$(az keyvault show -n "$KV_NAME" --query id -o tsv)" -o none 2>/dev/null || true
sleep 20
az keyvault secret set --vault-name "$KV_NAME" -n db-admin-password --value "$DB_PASSWORD" -o none

step "Server-Image ${VERSION} in ${ACR} bauen"
IMAGE="${ACR_LOGIN}/balance-scout-server:${VERSION}"
az acr build -r "$ACR" -t "balance-scout-server:${VERSION}" -t "balance-scout-server:latest" ../server -o none

step "Server mit Image ${IMAGE} ausrollen"
OUT="$(deploy "$IMAGE")"
URL="$(jq -r .serverUrl.value <<<"$OUT")"

step "Funktionstest"
for i in {1..30}; do
  if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then echo "  Server antwortet: ${URL}"; break; fi
  sleep 10
  [[ $i == 30 ]] && echo "  ⚠ Server antwortet noch nicht – Protokolle: az containerapp logs show -g $RG -n $(jq -r .containerAppName.value <<<"$OUT")"
done

step "Richtliniendatei für die Windows-App"
jq -n --arg s "$URL" --arg t "$TENANT_ID" --arg c "$DESKTOP_CLIENT_ID" --arg a "$API_SCOPE" \
  '{serverUrl:$s, tenantId:$t, clientId:$c, apiScope:$a}' > desktop-config.json
cat desktop-config.json
cat <<EOF

Fertig.
  Server:      ${URL}
  Windows-App: desktop-config.json als %ProgramData%\\BalanceScout\\config.json verteilen
               (z. B. per Intune/Gruppenrichtlinie) – dann ist keine Einrichtung durch Benutzer nötig.
  Sicherheit:  ${ENV_FILE} enthält das Client-Secret → jetzt löschen:  shred -u ${ENV_FILE}
EOF
