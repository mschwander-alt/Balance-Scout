#!/usr/bin/env bash
# Fehlerfälle: Skript muss sofort, verständlich und ohne Änderungen am Verzeichnis abbrechen.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
export PATH="$PWD/bin:$PATH"
fail=0
run_case() {
  local name="$1"; shift
  local st work; st="$(mktemp -u)"; work="$(mktemp -d)"
  cp ../setup-entra.sh "$work/"
  out="$(cd "$work" && env FAKE_AZ_STATE="$st" "$@" ./setup-entra.sh 2>&1)"; code=$?
  creates="$(python3 -c "import json,sys;d=json.load(open('$st'));print(sum(1 for l in d['log'] if l[0]in('POST','PATCH')))" 2>/dev/null || echo 0)"
  echo "=== $name (Exit $code, Änderungen: $creates)"; echo "$out" | sed 's/^/    /'
  [[ $code -ne 0 ]] || { echo "    FEHLER: hätte abbrechen müssen"; fail=1; }
  [[ -f "$work/entra-ergebnis.env" ]] && { echo "    FEHLER: Ergebnisdatei trotz Abbruch"; fail=1; }
  [[ $creates -eq 0 ]] || { echo "    FEHLER: es wurde trotzdem etwas geändert"; fail=1; }
}
run_case "Testabo-Verzeichnis ohne Adminrolle" FAKE_ORG="Standardverzeichnis" FAKE_DOMAINS="michaelxyz.onmicrosoft.com" FAKE_ROLES="" FAKE_UPN="michael_gmail.com#EXT#@michaelxyz.onmicrosoft.com"
run_case "Rolle vorhanden, Erstellen trotzdem verweigert" FAKE_FORBIDDEN_CREATE=1
exit $fail
