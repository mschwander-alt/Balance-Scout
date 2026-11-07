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
die() { echo; echo "✗ $*" >&2; exit 1; }

# Graph-Aufruf mit verständlicher Fehlermeldung; bricht bei jedem Fehler ab
graph() {
  local method="$1" url="$2" body="${3:-}" out
  if [[ -n "$body" ]]; then
    out="$(az rest --method "$method" --url "${GRAPH}${url}" --body "$body" 2>&1)" || graph_fail "$method $url" "$out"
  else
    out="$(az rest --method "$method" --url "${GRAPH}${url}" 2>&1)" || graph_fail "$method $url" "$out"
  fi
  printf '%s' "$out"
}
graph_fail() {
  local what="$1" out="$2"
  if grep -q "Authorization_RequestDenied\|Insufficient privileges" <<<"$out"; then
    die "Keine Berechtigung für: ${what}
  Ihr Konto hat in diesem Verzeichnis nicht die nötige Administratorrolle.
  Benötigt: Globaler Administrator – oder Anwendungsadministrator UND Administrator für privilegierte Rollen.
  Falls die Rolle über Privileged Identity Management (PIM) zugewiesen ist: zuerst aktivieren."
  fi
  die "Fehler bei ${what}:
$(grep -o '"message":"[^"]*"' <<<"$out" | head -1 | sed 's/"message":"//;s/"$//')"
}

TENANT_ID="$(az account show --query tenantId -o tsv)" || die "Nicht bei Azure angemeldet (az login)."

# ---------------------------------------------------------------- Vorabprüfung
step "Vorabprüfung"
ORG="$(graph GET "/organization?\$select=displayName,verifiedDomains")"
ORG_NAME="$(jq -r '.value[0].displayName' <<<"$ORG")"
DOMAINS="$(jq -r '[.value[0].verifiedDomains[].name] | join(", ")' <<<"$ORG")"
ME_UPN="$(graph GET "/me?\$select=userPrincipalName" | jq -r .userPrincipalName)"
echo "  Verzeichnis: ${ORG_NAME} (${TENANT_ID})"
echo "  Domänen:     ${DOMAINS}"
echo "  Angemeldet:  ${ME_UPN}"
if [[ "$DOMAINS" != *.* || "$DOMAINS" =~ ^[^,]*\.onmicrosoft\.com$ ]]; then
  echo "  ⚠ Dieses Verzeichnis hat nur eine onmicrosoft.com-Domäne. Ist das wirklich das Verzeichnis eurer"
  echo "    Microsoft-365-Konten? Ein Testabo legt manchmal ein neues, leeres Verzeichnis an."
fi
if [[ "$ME_UPN" == *"#EXT#"* ]]; then
  echo "  ⚠ Sie sind hier als Gastbenutzer angemeldet – vermutlich das falsche Verzeichnis."
fi
# Rollen-Vorlagen-IDs (fest bei Microsoft)
GA="62e90394-69f5-4237-9190-012177145e10"; APPADM="9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3"
CLOUDAPP="158c047a-c907-4556-b7ef-446551a6b5f7"; PRA="e8611ab8-c189-46e8-94e1-60213ab1f814"
ROLES="$(graph GET "/me/memberOf/microsoft.graph.directoryRole?\$select=displayName,roleTemplateId" | jq -r '[.value[].roleTemplateId] | join(" ")')"
has() { [[ " $ROLES " == *" $1 "* ]]; }
if has "$GA"; then
  echo "  Rolle:       Globaler Administrator ✓"
elif (has "$APPADM" || has "$CLOUDAPP") && has "$PRA"; then
  echo "  Rolle:       Anwendungs- und Rollenadministrator ✓"
else
  die "Ihr Konto (${ME_UPN}) hat in diesem Verzeichnis nicht die nötige Rolle.
  Benötigt: Globaler Administrator – oder Anwendungsadministrator UND Administrator für privilegierte Rollen.
  Aktive Rollen: $(graph GET "/me/memberOf/microsoft.graph.directoryRole?\$select=displayName" | jq -r '[.value[].displayName] | if length==0 then "keine" else join(", ") end')
  Falls die Rolle über PIM zugewiesen ist: im Entra-Portal unter 'Meine Rollen' aktivieren."
fi

# Bestehende App gleichen Namens wiederverwenden (Skript ist wiederholbar)
find_app() { graph GET "/applications?\$filter=displayName eq '$1'&\$select=id,appId" | jq -r '.value[0] // empty | "\(.id) \(.appId)"'; }
ensure_sp() {
  local appId="$1" sp
  sp="$(graph GET "/servicePrincipals?\$filter=appId eq '${appId}'&\$select=id" | jq -r '.value[0].id // empty')"
  if [[ -z "$sp" ]]; then
    sp="$(graph POST "/servicePrincipals" "{\"appId\":\"${appId}\"}" | jq -r '.id')"
  fi
  echo "$sp"
}
# Delegierte Berechtigung (Scope) eines Ressourcen-Service-Principals nachschlagen
scope_id() {
  local filter="$1" scope="$2"
  graph GET "/servicePrincipals?\$filter=${filter}&\$select=appId,oauth2PermissionScopes" |
    jq -r --arg s "$scope" '.value[0] // empty | "\(.appId) \((.oauth2PermissionScopes[] | select(.value==$s) | .id) // "")"'
}

# ---------------------------------------------------------------- API-App
step "App-Registrierung: ${API_NAME}"
FOUND="$(find_app "$API_NAME")"
read -r API_OBJ API_APP_ID <<<"$FOUND" || true
if [[ -z "${API_OBJ:-}" ]]; then
  CREATED="$(graph POST "/applications" "{\"displayName\":\"${API_NAME}\",\"signInAudience\":\"AzureADMyOrg\"}")"
  read -r API_OBJ API_APP_ID <<<"$(jq -r '"\(.id) \(.appId)"' <<<"$CREATED")"
  [[ -n "$API_APP_ID" && "$API_APP_ID" != null ]] || die "App '${API_NAME}' konnte nicht angelegt werden."
  echo "  angelegt: ${API_APP_ID}"
else
  echo "  vorhanden: ${API_APP_ID}"
fi

EXISTING="$(graph GET "/applications/${API_OBJ}?\$select=api,appRoles")"
SCOPE_ID="$(jq -r '.api.oauth2PermissionScopes[]? | select(.value=="access_as_user") | .id' <<<"$EXISTING")"
ADMIN_ROLE_ID="$(jq -r '.appRoles[]? | select(.value=="BalanceScout.Admin") | .id' <<<"$EXISTING")"
USER_ROLE_ID="$(jq -r '.appRoles[]? | select(.value=="BalanceScout.User") | .id' <<<"$EXISTING")"
SCOPE_ID="${SCOPE_ID:-$(uuid)}"
ADMIN_ROLE_ID="${ADMIN_ROLE_ID:-$(uuid)}"
USER_ROLE_ID="${USER_ROLE_ID:-$(uuid)}"
API_URI="api://${API_APP_ID}"

# Delegierte Rechte, die der Server im Namen des Benutzers nutzt (On-Behalf-Of)
GRAPH_SCOPES="$(graph GET "/servicePrincipals?\$filter=appId eq '${GRAPH_APP_ID}'&\$select=oauth2PermissionScopes")"
gscope() { jq -r --arg s "$1" '.value[0].oauth2PermissionScopes[] | select(.value==$s) | .id' <<<"$GRAPH_SCOPES"; }
SITES_RW="$(gscope Sites.ReadWrite.All)"; USER_READ="$(gscope User.Read)"; OFFLINE="$(gscope offline_access)"
[[ -n "$SITES_RW" && -n "$USER_READ" && -n "$OFFLINE" ]] || die "Microsoft-Graph-Berechtigungen konnten nicht ermittelt werden."
RRA="$(jq -n --arg g "$GRAPH_APP_ID" --arg a "$SITES_RW" --arg b "$USER_READ" --arg c "$OFFLINE" \
  '[{resourceAppId:$g, resourceAccess:[{id:$a,type:"Scope"},{id:$b,type:"Scope"},{id:$c,type:"Scope"}]}]')"

WIQ="$(scope_id "servicePrincipalNames/any(n:n eq 'api://workiq.svc.cloud.microsoft')" "WorkIQAgent.Ask" 2>/dev/null || true)"
read -r WORKIQ_APP WORKIQ_SCOPE <<<"$WIQ" || true
if [[ -n "${WORKIQ_APP:-}" && -n "${WORKIQ_SCOPE:-}" ]]; then
  RRA="$(jq --arg r "$WORKIQ_APP" --arg s "$WORKIQ_SCOPE" '. + [{resourceAppId:$r, resourceAccess:[{id:$s,type:"Scope"}]}]' <<<"$RRA")"
  echo "  Work IQ gefunden – Berechtigung WorkIQAgent.Ask wird hinzugefügt."
else
  WORKIQ_MISSING=1
  echo "  ℹ Work IQ ist (noch) nicht aktiviert – Copilot-Funktionen bleiben aus, alles andere funktioniert."
  echo "    Nach der Aktivierung (siehe README) dieses Skript einfach erneut ausführen."
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
graph PATCH "/applications/${API_OBJ}" "$BODY" >/dev/null
API_SP="$(ensure_sp "$API_APP_ID")"
# Nur zugewiesene Benutzer/Gruppen dürfen sich anmelden
graph PATCH "/servicePrincipals/${API_SP}" '{"appRoleAssignmentRequired": true}' >/dev/null
echo "  Audience: ${API_URI}"

step "Client-Secret für den Server (2 Jahre gültig)"
SECRET="$(graph POST "/applications/${API_OBJ}/addPassword" \
  '{"passwordCredential":{"displayName":"balance-scout-server","endDateTime":"'"$(date -u -d '+2 years' +%Y-%m-%dT%H:%M:%SZ)"'"}}' | jq -r '.secretText')"
[[ -n "$SECRET" && "$SECRET" != null ]] || die "Client-Secret konnte nicht erstellt werden."
echo "  erstellt (wird nur in ${OUT_FILE} abgelegt – danach in den Key Vault übernehmen und Datei löschen)"

# ------------------------------------------------------------ Desktop-App
step "App-Registrierung: ${DESKTOP_NAME}"
FOUND="$(find_app "$DESKTOP_NAME")"
read -r DESK_OBJ DESK_APP_ID <<<"$FOUND" || true
if [[ -z "${DESK_OBJ:-}" ]]; then
  CREATED="$(graph POST "/applications" "{\"displayName\":\"${DESKTOP_NAME}\",\"signInAudience\":\"AzureADMyOrg\"}")"
  read -r DESK_OBJ DESK_APP_ID <<<"$(jq -r '"\(.id) \(.appId)"' <<<"$CREATED")"
  [[ -n "$DESK_APP_ID" && "$DESK_APP_ID" != null ]] || die "App '${DESKTOP_NAME}' konnte nicht angelegt werden."
  echo "  angelegt: ${DESK_APP_ID}"
else
  echo "  vorhanden: ${DESK_APP_ID}"
fi
DBODY="$(jq -n --arg api "$API_APP_ID" --arg scope "$SCOPE_ID" --arg cid "$DESK_APP_ID" '{
  isFallbackPublicClient: true,
  publicClient: { redirectUris: ["http://localhost", ("ms-appx-web://Microsoft.AAD.BrokerPlugin/" + $cid)] },
  requiredResourceAccess: [{ resourceAppId: $api, resourceAccess: [{ id: $scope, type: "Scope" }] }]
}')"
graph PATCH "/applications/${DESK_OBJ}" "$DBODY" >/dev/null
ensure_sp "$DESK_APP_ID" >/dev/null

step "Desktop-App bei der API vorab autorisieren"
graph PATCH "/applications/${API_OBJ}" "$(jq -n --arg d "$DESK_APP_ID" --arg s "$SCOPE_ID" '{
  api: { knownClientApplications: [$d], preAuthorizedApplications: [{ appId: $d, delegatedPermissionIds: [$s] }] }
}')" >/dev/null

step "Administratorzustimmung"
sleep 10 # Replikation in Entra abwarten
az ad app permission admin-consent --id "$API_APP_ID" >/dev/null 2>&1 && echo "  API: erteilt" \
  || echo "  ⚠ API: Zustimmung nicht möglich – im Entra-Portal unter App-Registrierungen › ${API_NAME} › API-Berechtigungen › 'Administratorzustimmung erteilen'."
az ad app permission admin-consent --id "$DESK_APP_ID" >/dev/null 2>&1 && echo "  Desktop: erteilt" \
  || echo "  ⚠ Desktop: Zustimmung nicht möglich – im Entra-Portal wie oben für ${DESKTOP_NAME}."

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
