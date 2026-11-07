#!/usr/bin/env bash
# =============================================================================
# Balance Scout – App-Registrierungen in Microsoft Entra ID anlegen
#
# Ausführen in der Azure Cloud Shell (Bash) als Global Administrator oder
# Application Administrator + Privileged Role Administrator (für Zustimmung):
#
#   ./setup-entra.sh [--admin-group <Objekt-ID>] [--user-group <Objekt-ID>]
#
# Legt an:
#   1. "Balance Scout API"     – Server: Scope access_as_user, App-Rollen
#                                 BalanceScout.Admin / BalanceScout.User,
#                                 delegierte Rechte für SharePoint und Copilot (Work IQ)
#   2. "Balance Scout Desktop" – Windows-App (öffentlicher Client, Windows-SSO/WAM)
# und erteilt die Administratorzustimmung.
# Nur zugewiesene Benutzer/Gruppen erhalten Zugriff.
# =============================================================================
set -euo pipefail

ADMIN_GROUP=""
USER_GROUP=""
API_NAME="Balance Scout API"
DESKTOP_NAME="Balance Scout Desktop"
OUT_FILE="entra-ergebnis.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-group) ADMIN_GROUP="$2"; shift 2 ;;
    --user-group) USER_GROUP="$2"; shift 2 ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

command -v az >/dev/null || { echo "Azure CLI (az) fehlt – bitte in der Azure Cloud Shell ausführen." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq fehlt." >&2; exit 1; }

GRAPH="https://graph.microsoft.com/v1.0"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
uuid() { cat /proc/sys/kernel/random/uuid; }
step() { echo; echo "▶ $*"; }

TENANT_ID="$(az account show --query tenantId -o tsv)"
step "Tenant: ${TENANT_ID}"

# Bestehende App gleichen Namens wiederverwenden (Skript ist wiederholbar)
find_app() { az rest --method GET --url "${GRAPH}/applications?\$filter=displayName eq '$1'&\$select=id,appId" | jq -r '.value[0] // empty | "\(.id) \(.appId)"'; }
ensure_sp() {
  local appId="$1" sp
  sp="$(az rest --method GET --url "${GRAPH}/servicePrincipals?\$filter=appId eq '${appId}'&\$select=id" | jq -r '.value[0].id // empty')"
  if [[ -z "$sp" ]]; then
    sp="$(az rest --method POST --url "${GRAPH}/servicePrincipals" --body "{\"appId\":\"${appId}\"}" | jq -r '.id')"
  fi
  echo "$sp"
}
# Delegierte Berechtigung (Scope) eines Ressourcen-Service-Principals nachschlagen
scope_id() {
  local filter="$1" scope="$2"
  az rest --method GET --url "${GRAPH}/servicePrincipals?\$filter=${filter}&\$select=appId,oauth2PermissionScopes" |
    jq -r --arg s "$scope" '.value[0] // empty | "\(.appId) \((.oauth2PermissionScopes[] | select(.value==$s) | .id) // "")"'
}

# ---------------------------------------------------------------- API-App
step "App-Registrierung: ${API_NAME}"
read -r API_OBJ API_APP_ID <<<"$(find_app "$API_NAME" || true)"
if [[ -z "${API_OBJ:-}" ]]; then
  read -r API_OBJ API_APP_ID <<<"$(az rest --method POST --url "${GRAPH}/applications" \
    --body "{\"displayName\":\"${API_NAME}\",\"signInAudience\":\"AzureADMyOrg\"}" | jq -r '"\(.id) \(.appId)"')"
  echo "  angelegt: ${API_APP_ID}"
else
  echo "  vorhanden: ${API_APP_ID}"
fi

EXISTING="$(az rest --method GET --url "${GRAPH}/applications/${API_OBJ}?\$select=api,appRoles")"
SCOPE_ID="$(jq -r '.api.oauth2PermissionScopes[]? | select(.value=="access_as_user") | .id' <<<"$EXISTING")"
ADMIN_ROLE_ID="$(jq -r '.appRoles[]? | select(.value=="BalanceScout.Admin") | .id' <<<"$EXISTING")"
USER_ROLE_ID="$(jq -r '.appRoles[]? | select(.value=="BalanceScout.User") | .id' <<<"$EXISTING")"
SCOPE_ID="${SCOPE_ID:-$(uuid)}"
ADMIN_ROLE_ID="${ADMIN_ROLE_ID:-$(uuid)}"
USER_ROLE_ID="${USER_ROLE_ID:-$(uuid)}"
API_URI="api://${API_APP_ID}"

# Delegierte Rechte, die der Server im Namen des Benutzers nutzt (On-Behalf-Of)
read -r _ SITES_RW <<<"$(scope_id "appId eq '${GRAPH_APP_ID}'" "Sites.ReadWrite.All")"
read -r _ USER_READ <<<"$(scope_id "appId eq '${GRAPH_APP_ID}'" "User.Read")"
read -r _ OFFLINE <<<"$(scope_id "appId eq '${GRAPH_APP_ID}'" "offline_access")"
RRA="$(jq -n --arg g "$GRAPH_APP_ID" --arg a "$SITES_RW" --arg b "$USER_READ" --arg c "$OFFLINE" \
  '[{resourceAppId:$g, resourceAccess:[{id:$a,type:"Scope"},{id:$b,type:"Scope"},{id:$c,type:"Scope"}]}]')"

read -r WORKIQ_APP WORKIQ_SCOPE <<<"$(scope_id "servicePrincipalNames/any(n:n eq 'api://workiq.svc.cloud.microsoft')" "WorkIQAgent.Ask" || true)"
if [[ -n "${WORKIQ_APP:-}" && -n "${WORKIQ_SCOPE:-}" ]]; then
  RRA="$(jq --arg r "$WORKIQ_APP" --arg s "$WORKIQ_SCOPE" '. + [{resourceAppId:$r, resourceAccess:[{id:$s,type:"Scope"}]}]' <<<"$RRA")"
  echo "  Work IQ gefunden – Berechtigung WorkIQAgent.Ask wird hinzugefügt."
else
  WORKIQ_MISSING=1
  echo "  ⚠ Work IQ ist im Tenant nicht aktiviert. Copilot-Funktionen erst nach Aktivierung (siehe README) – Skript danach erneut ausführen."
fi

BODY="$(jq -n --arg uri "$API_URI" --arg scope "$SCOPE_ID" --arg ra "$ADMIN_ROLE_ID" --arg ru "$USER_ROLE_ID" --argjson rra "$RRA" '{
  identifierUris: [$uri],
  api: {
    requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: [{
      id: $scope, value: "access_as_user", type: "User", isEnabled: true,
      adminConsentDisplayName: "Balance Scout verwenden",
      adminConsentDescription: "Erlaubt der Balance-Scout-App, im Namen des angemeldeten Benutzers auf den Balance-Scout-Server zuzugreifen.",
      userConsentDisplayName: "Balance Scout verwenden",
      userConsentDescription: "Erlaubt Balance Scout, in Ihrem Namen auf den Server zuzugreifen."
    }]
  },
  appRoles: [
    { id: $ra, value: "BalanceScout.Admin", displayName: "Balance Scout Administrator", description: "KI-Richtlinien und Anbieter verwalten", allowedMemberTypes: ["User"], isEnabled: true },
    { id: $ru, value: "BalanceScout.User", displayName: "Balance Scout Benutzer", description: "Mandate prüfen", allowedMemberTypes: ["User"], isEnabled: true }
  ],
  requiredResourceAccess: $rra
}')"
az rest --method PATCH --url "${GRAPH}/applications/${API_OBJ}" --body "$BODY" >/dev/null
API_SP="$(ensure_sp "$API_APP_ID")"
# Nur zugewiesene Benutzer/Gruppen dürfen sich anmelden
az rest --method PATCH --url "${GRAPH}/servicePrincipals/${API_SP}" --body '{"appRoleAssignmentRequired": true}' >/dev/null
echo "  Audience: ${API_URI}"

step "Client-Secret für den Server (2 Jahre gültig)"
SECRET="$(az rest --method POST --url "${GRAPH}/applications/${API_OBJ}/addPassword" \
  --body '{"passwordCredential":{"displayName":"balance-scout-server","endDateTime":"'"$(date -u -d '+2 years' +%Y-%m-%dT%H:%M:%SZ)"'"}}' | jq -r '.secretText')"
echo "  erstellt (wird nur in ${OUT_FILE} abgelegt – danach in den Key Vault übernehmen und Datei löschen)"

# ------------------------------------------------------------ Desktop-App
step "App-Registrierung: ${DESKTOP_NAME}"
read -r DESK_OBJ DESK_APP_ID <<<"$(find_app "$DESKTOP_NAME" || true)"
if [[ -z "${DESK_OBJ:-}" ]]; then
  read -r DESK_OBJ DESK_APP_ID <<<"$(az rest --method POST --url "${GRAPH}/applications" \
    --body "{\"displayName\":\"${DESKTOP_NAME}\",\"signInAudience\":\"AzureADMyOrg\"}" | jq -r '"\(.id) \(.appId)"')"
  echo "  angelegt: ${DESK_APP_ID}"
else
  echo "  vorhanden: ${DESK_APP_ID}"
fi
DBODY="$(jq -n --arg api "$API_APP_ID" --arg scope "$SCOPE_ID" --arg cid "$DESK_APP_ID" '{
  isFallbackPublicClient: true,
  publicClient: { redirectUris: ["http://localhost", ("ms-appx-web://Microsoft.AAD.BrokerPlugin/" + $cid)] },
  requiredResourceAccess: [{ resourceAppId: $api, resourceAccess: [{ id: $scope, type: "Scope" }] }]
}')"
az rest --method PATCH --url "${GRAPH}/applications/${DESK_OBJ}" --body "$DBODY" >/dev/null
ensure_sp "$DESK_APP_ID" >/dev/null

step "Desktop-App bei der API vorab autorisieren"
az rest --method PATCH --url "${GRAPH}/applications/${API_OBJ}" --body "$(jq -n --arg d "$DESK_APP_ID" --arg s "$SCOPE_ID" '{
  api: { knownClientApplications: [$d], preAuthorizedApplications: [{ appId: $d, delegatedPermissionIds: [$s] }] }
}')" >/dev/null

step "Administratorzustimmung"
sleep 10 # Replikation in Entra abwarten
az ad app permission admin-consent --id "$API_APP_ID" && echo "  API: erteilt"
az ad app permission admin-consent --id "$DESK_APP_ID" && echo "  Desktop: erteilt"

assign() {
  local group="$1" role="$2" label="$3"
  [[ -z "$group" ]] && return 0
  az rest --method POST --url "${GRAPH}/servicePrincipals/${API_SP}/appRoleAssignedTo" \
    --body "{\"principalId\":\"${group}\",\"resourceId\":\"${API_SP}\",\"appRoleId\":\"${role}\"}" >/dev/null 2>&1 \
    && echo "  ${label}: Gruppe ${group} zugewiesen" || echo "  ${label}: bereits zugewiesen oder Fehler (Gruppe ${group})"
}
step "Rollen zuweisen"
assign "$ADMIN_GROUP" "$ADMIN_ROLE_ID" "Administratoren"
assign "$USER_GROUP" "$USER_ROLE_ID" "Benutzer"
[[ -z "$ADMIN_GROUP$USER_GROUP" ]] && echo "  ⚠ Keine Gruppen angegeben – Benutzer im Entra-Portal unter Unternehmensanwendungen › ${API_NAME} › Benutzer und Gruppen zuweisen."

umask 077
cat >"$OUT_FILE" <<EOF
# Balance Scout – Ergebnis der Entra-Einrichtung ($(date -u +%Y-%m-%dT%H:%MZ))
# VERTRAULICH: enthält das Client-Secret. Nach dem Deployment löschen.
TENANT_ID=${TENANT_ID}
API_APP_ID=${API_APP_ID}
API_AUDIENCE=${API_URI}
API_SCOPE=${API_URI}/access_as_user
API_CLIENT_SECRET=${SECRET}
DESKTOP_CLIENT_ID=${DESK_APP_ID}
WORKIQ_CONFIGURED=$([[ -n "${WORKIQ_MISSING:-}" ]] && echo false || echo true)
EOF
step "Fertig. Werte in ${OUT_FILE} – weiter mit ./deploy.sh"
