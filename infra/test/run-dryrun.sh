#!/usr/bin/env bash
# Trockenlauf von setup-entra.sh gegen nachgebildete Azure CLI; prüft die gesendeten Daten.
set -euo pipefail
cd "$(dirname "$0")"
FAKE_AZ_STATE="$(mktemp -u)"
export PATH="$PWD/bin:$PATH" FAKE_AZ_STATE FAKE_WORKIQ="${1:-1}"
work="$(mktemp -d)"; cp ../setup-entra.sh "$work/"
sed -i 's/^sleep 10.*/:/' "$work/setup-entra.sh"
(cd "$work" && ./setup-entra.sh --admin-group grp-admin --user-group grp-user >/dev/null)
(cd "$work" && ./setup-entra.sh >/dev/null)   # zweiter Lauf: muss wiederverwenden, nicht duplizieren
python3 - "$FAKE_AZ_STATE" "$work/entra-ergebnis.env" "$FAKE_WORKIQ" <<'PY'
import json, sys, os, stat
st = json.load(open(sys.argv[1])); env = dict(l.split('=',1) for l in open(sys.argv[2]).read().splitlines() if '=' in l and not l.startswith('#'))
wiq = sys.argv[3] == '1'
apps = {a['displayName']: a for a in st['apps'].values()}
assert len(st['apps']) == 2, f"Duplikate: {len(st['apps'])} Apps"
api, desk = apps['Balance Scout API'], apps['Balance Scout Desktop']
assert api['identifierUris'] == [f"api://{api['appId']}"]
scope = api['api']['oauth2PermissionScopes'][0]
assert scope['value'] == 'access_as_user' and scope['type'] == 'User'
assert api['api']['requestedAccessTokenVersion'] == 2
roles = {r['value']: r['id'] for r in api['appRoles']}
assert set(roles) == {'BalanceScout.Admin', 'BalanceScout.User'}
rra = {r['resourceAppId']: [x['id'] for x in r['resourceAccess']] for r in api['requiredResourceAccess']}
assert '89fe6a52-be36-487e-b7d8-d061c450a026' in rra['00000003-0000-0000-c000-000000000000']
assert (rra.get('wiq-app-id') == ['wiq-scope-id']) == wiq
assert api['api']['preAuthorizedApplications'] == [{'appId': desk['appId'], 'delegatedPermissionIds': [scope['id']]}]
assert api['api']['knownClientApplications'] == [desk['appId']]
assert desk['isFallbackPublicClient'] is True
assert f"ms-appx-web://Microsoft.AAD.BrokerPlugin/{desk['appId']}" in desk['publicClient']['redirectUris']
assert desk['requiredResourceAccess'] == [{'resourceAppId': api['appId'], 'resourceAccess': [{'id': scope['id'], 'type': 'Scope'}]}]
rest = [l for l in st['log'] if len(l) == 3]
assert any(m == 'PATCH' and u.startswith('/servicePrincipals/') and b == {'appRoleAssignmentRequired': True} for m, u, b in rest)
assert {a['appRoleId'] for a in st['assign']} == {roles['BalanceScout.Admin'], roles['BalanceScout.User']}
assert sum(1 for l in st['log'] if l[0] == 'consent') == 4
# Scope-/Rollen-IDs bleiben über Läufe stabil (sonst brechen bestehende Zustimmungen)
patches = [b for m, u, b in rest if m == 'PATCH' and u == f"/applications/{api['id']}" and b and 'appRoles' in b]
assert len(patches) == 2 and patches[0]['appRoles'] == patches[1]['appRoles'] and patches[0]['api']['oauth2PermissionScopes'][0]['id'] == patches[1]['api']['oauth2PermissionScopes'][0]['id']
assert env['API_SCOPE'] == f"api://{api['appId']}/access_as_user" and env['DESKTOP_CLIENT_ID'] == desk['appId']
assert env['WORKIQ_CONFIGURED'] == ('true' if wiq else 'false') and env['API_CLIENT_SECRET'] == 'GEHEIM~123'
assert stat.S_IMODE(os.stat(sys.argv[2]).st_mode) == 0o600, 'Ergebnisdatei muss nur für den Besitzer lesbar sein'
print(f"Trockenlauf OK (Work IQ {'aktiv' if wiq else 'nicht aktiviert'}): 2 Apps, Rollen, Scopes, Vorautorisierung, WAM-Umleitung, Zustimmung, Zuweisungen, Datei 600")
PY

# Fehlerfälle (fehlende Rechte, falsches Verzeichnis) einmal mitprüfen
if [[ "$FAKE_WORKIQ" == "1" ]]; then
  bash ./run-failcases.sh >/dev/null || { echo "Fehlerfälle NICHT OK – Details: ./test/run-failcases.sh" >&2; exit 1; }
  echo "Fehlerfälle OK: Abbruch ohne Änderungen bei fehlender Rolle und bei verweigertem Zugriff"
fi
