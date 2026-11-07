#!/usr/bin/env python3
"""Nachbildung der benötigten Azure-CLI-/Graph-Aufrufe für einen Trockenlauf von setup-entra.sh."""
import json, os, sys, uuid, urllib.parse
STATE = os.environ['FAKE_AZ_STATE']
st = json.load(open(STATE)) if os.path.exists(STATE) else {'apps': {}, 'sps': {}, 'log': [], 'assign': []}
args = sys.argv[1:]
def save(): json.dump(st, open(STATE, 'w'), indent=1)
def out(o): print(json.dumps(o)); save(); sys.exit(0)
def opt(name):
    return args[args.index(name)+1] if name in args else None
GRAPH_SP = {'appId': '00000003-0000-0000-c000-000000000000', 'oauth2PermissionScopes': [
    {'value': 'Sites.ReadWrite.All', 'id': '89fe6a52-be36-487e-b7d8-d061c450a026'},
    {'value': 'User.Read', 'id': 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'},
    {'value': 'offline_access', 'id': '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'}]}
WORKIQ_SP = {'appId': 'wiq-app-id', 'oauth2PermissionScopes': [{'value': 'WorkIQAgent.Ask', 'id': 'wiq-scope-id'}]}
if args[:2] == ['account', 'show']: print('11111111-2222-3333-4444-555555555555'); sys.exit(0)
if args[:4] == ['ad', 'app', 'permission', 'admin-consent']: st['log'].append(['consent', opt('--id')]); save(); sys.exit(0)
if args[0] == 'rest':
    method, url, body = opt('--method'), urllib.parse.unquote(opt('--url')), opt('--body')
    body = json.loads(body) if body else None
    st['log'].append([method, url.replace('https://graph.microsoft.com/v1.0', ''), body])
    path = url.replace('https://graph.microsoft.com/v1.0', '')
    if path.startswith('/organization'):
        out({'value': [{'displayName': os.environ.get('FAKE_ORG', 'Aumico AG'), 'verifiedDomains': [{'name': d} for d in os.environ.get('FAKE_DOMAINS', 'aumico.io,aumico.onmicrosoft.com').split(',')]}]})
    if path.startswith('/me/memberOf'):
        roles = [r for r in os.environ.get('FAKE_ROLES', '62e90394-69f5-4237-9190-012177145e10').split(',') if r]
        out({'value': [{'displayName': 'Rolle ' + r[:8], 'roleTemplateId': r} for r in roles]})
    if path.startswith('/me'):
        out({'userPrincipalName': os.environ.get('FAKE_UPN', 'michael@aumico.io')})
    if method == 'POST' and path == '/applications' and os.environ.get('FAKE_FORBIDDEN_CREATE') == '1':
        st['log'].pop()  # abgelehnter Versuch ist keine Änderung
        print('ERROR: Forbidden({"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}})', file=sys.stderr); save(); sys.exit(1)
    if method == 'GET' and path.startswith('/applications?'):
        name = path.split("displayName eq '")[1].split("'")[0]
        a = [x for x in st['apps'].values() if x['displayName'] == name]
        out({'value': [{'id': a[0]['id'], 'appId': a[0]['appId']}] if a else []})
    if method == 'POST' and path == '/applications':
        oid, aid = str(uuid.uuid4()), str(uuid.uuid4())
        st['apps'][oid] = {'id': oid, 'appId': aid, 'displayName': body['displayName'], 'api': {}, 'appRoles': []}
        out(st['apps'][oid])
    if path.startswith('/applications/') and path.endswith('/addPassword'):
        out({'secretText': 'GEHEIM~123'})
    if path.startswith('/applications/'):
        oid = path.split('/')[2].split('?')[0]
        if method == 'GET': out(st['apps'][oid])
        if method == 'PATCH':
            app = st['apps'][oid]
            for k, v in body.items():
                if k == 'api': app['api'] = {**app.get('api', {}), **v}
                else: app[k] = v
            out({})
    if method == 'GET' and path.startswith('/servicePrincipals?'):
        if "appId eq '00000003" in path: out({'value': [GRAPH_SP]})
        if 'workiq' in path: out({'value': [WORKIQ_SP] if os.environ.get('FAKE_WORKIQ') == '1' else []})
        aid = path.split("appId eq '")[1].split("'")[0]
        out({'value': [{'id': st['sps'][aid]}] if aid in st['sps'] else []})
    if method == 'POST' and path == '/servicePrincipals':
        st['sps'][body['appId']] = 'sp-' + body['appId'][:8]; out({'id': st['sps'][body['appId']]})
    if method == 'PATCH' and path.startswith('/servicePrincipals/'): out({})
    if method == 'POST' and path.endswith('/appRoleAssignedTo'): st['assign'].append(body); out({})
print(f'fake-az: nicht unterstützt: {args}', file=sys.stderr); sys.exit(1)
