// =============================================================================
// Balance Scout – Azure-Infrastruktur (Region: Schweiz Nord)
//
// Bereitgestellt wird:
//  - Virtuelles Netz mit getrennten Subnetzen (Container Apps, PostgreSQL)
//  - Azure Container Apps (Server, mind. 1 Instanz wegen Live-Ereignissen)
//  - Azure Database for PostgreSQL Flexible Server 16 – NUR privat erreichbar
//  - Azure Files für Belegdateien (ZRS, nur TLS 1.2)
//  - Key Vault (RBAC) für Geheimnisse
//  - Container Registry
//  - Optional: Azure AI Foundry (Azure OpenAI) in der Schweiz, ohne Schlüssel (nur Entra)
//  - Log Analytics (Protokolle 90 Tage)
// Zugriff des Servers auf Registry, Key Vault und KI über verwaltete Identität.
// =============================================================================

targetScope = 'resourceGroup'

@description('Kurzname, wird in Ressourcennamen verwendet (Kleinbuchstaben/Ziffern)')
@minLength(3)
@maxLength(12)
param prefix string = 'balscout'

@description('Azure-Region (Daten bleiben in der Schweiz)')
@allowed(['switzerlandnorth', 'switzerlandwest'])
param location string = 'switzerlandnorth'

@description('Container-Image, z. B. balscoutacr.azurecr.io/balance-scout-server:0.3.0. Leer = Platzhalter-Image für die Erstbereitstellung.')
param serverImage string = ''

@description('Entra-Tenant-ID')
param tenantId string = subscription().tenantId

@description('Application-ID-URI der Server-API (Audience), z. B. api://balance-scout')
param apiAudience string

@description('Client-ID der Server-API-App-Registrierung (zusätzliche Audience und für On-Behalf-Of)')
param apiClientId string

@description('Client-Secret der Server-API-App (für On-Behalf-Of zu Copilot/SharePoint). Wird im Key Vault abgelegt.')
@secure()
param apiClientSecret string

@description('Administrator-Benutzername der Datenbank')
param dbAdminUser string = 'bsbadmin'

@description('Administrator-Passwort der Datenbank (mind. 16 Zeichen)')
@secure()
@minLength(16)
param dbAdminPassword string

@description('Datenbank-SKU (Burstable genügt für kleine Teams)')
param dbSku string = 'Standard_B2s'
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param dbTier string = 'Burstable'

@description('Microsoft 365 Copilot aktivieren (erfordert Copilot-Lizenzen und Work IQ im Tenant)')
param enableM365Copilot bool = true
@allowed(['workiq', 'graph-beta'])
param m365CopilotVariant string = 'workiq'

@description('SharePoint-Dokumentbibliothek (Drive-ID) für Belege; leer = Funktion aus')
param sharePointDriveId string = ''

@description('Azure AI Foundry (Azure OpenAI) bereitstellen')
param deployAzureOpenAI bool = true
@description('Modellname für Belegauswertung/OCR (muss in der Region verfügbar sein)')
param openAiModelName string = 'gpt-4.1'
param openAiModelVersion string = '2025-04-14'
@description('Bereitstellungstyp: DataZone/Global können Daten ausserhalb der Schweiz verarbeiten – für Revisionsdaten "Standard" (regional) wählen.')
@allowed(['Standard', 'DataZoneStandard', 'GlobalStandard'])
param openAiSkuName string = 'Standard'
param openAiCapacity int = 30

@description('Optionale IP-Bereiche (CIDR), die den Server erreichen dürfen, z. B. Kanzlei-Standorte/VPN. Leer = alle (Anmeldung schützt trotzdem).')
param allowedIpRanges array = []

@description('Benutzer-UPNs mit Admin-Rechten – nur relevant ohne Entra-App-Rollen (Übergang)')
param adminUsers string = ''

var suffix = uniqueString(resourceGroup().id)
var names = {
  identity: '${prefix}-id'
  vnet: '${prefix}-vnet'
  logs: '${prefix}-logs'
  acr: take('${prefix}acr${suffix}', 50)
  kv: take('${prefix}-kv-${suffix}', 24)
  storage: take('${prefix}st${suffix}', 24)
  pg: '${prefix}-pg-${suffix}'
  env: '${prefix}-env'
  app: '${prefix}-server'
  openai: '${prefix}-ai-${suffix}'
}
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var image = empty(serverImage) ? placeholderImage : serverImage
var tags = { application: 'balance-scout', dataResidency: 'CH' }

// ---------------- Identität ----------------
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: names.identity
  location: location
  tags: tags
}

// ---------------- Netzwerk ----------------
resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: names.vnet
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.40.2.0/28'
          delegations: [{ name: 'pg', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}

resource pgDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${names.pg}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource pgDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: pgDns
  name: 'vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}

// ---------------- Protokolle ----------------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: names.logs
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 90 }
}

// ---------------- Registry ----------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: names.acr
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: { adminUserEnabled: false, publicNetworkAccess: 'Enabled' }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, identity.id, 'acrpull')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

// ---------------- Key Vault ----------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: names.kv
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, identity.id, 'kv-secrets-user')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource secretDbUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'database-url'
  properties: {
    value: 'postgresql://${dbAdminUser}:${uriComponent(dbAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/balancescout'
  }
}

resource secretApiClient 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'entra-client-secret'
  properties: { value: apiClientSecret }
}

// ---------------- Datenbank (nur privat) ----------------
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: names.pg
  location: location
  tags: tags
  sku: { name: dbSku, tier: dbTier }
  properties: {
    version: '16'
    administratorLogin: dbAdminUser
    administratorLoginPassword: dbAdminPassword
    storage: { storageSizeGB: 64, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 35, geoRedundantBackup: 'Disabled' }
    network: {
      delegatedSubnetResourceId: '${vnet.id}/subnets/postgres'
      privateDnsZoneArmResourceId: pgDns.id
      publicNetworkAccess: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
  }
  dependsOn: [pgDnsLink]
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'balancescout'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource pgTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'require_secure_transport'
  properties: { value: 'on', source: 'user-override' }
}

// ---------------- Dateiablage ----------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: names.storage
  location: location
  tags: tags
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: true // nötig für Azure-Files-Einbindung in Container Apps
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { shareDeleteRetentionPolicy: { enabled: true, days: 30 } }
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'belege'
  properties: { shareQuota: 1024, enabledProtocols: 'SMB' }
}

// ---------------- Azure AI Foundry (optional) ----------------
resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' = if (deployAzureOpenAI) {
  name: names.openai
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: names.openai
    disableLocalAuth: true // nur Entra-Anmeldung, keine Schlüssel
    publicNetworkAccess: 'Enabled'
  }
}

resource openaiDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (deployAzureOpenAI) {
  parent: openai
  name: openAiModelName
  sku: { name: openAiSkuName, capacity: openAiCapacity }
  properties: { model: { format: 'OpenAI', name: openAiModelName, version: openAiModelVersion } }
}

resource openaiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployAzureOpenAI) {
  scope: openai
  name: guid(names.openai, identity.id, 'openai-user')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  }
}

// ---------------- Container Apps ----------------
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: names.env
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
    vnetConfiguration: { infrastructureSubnetId: '${vnet.id}/subnets/apps', internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    zoneRedundant: false
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: 'belege'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

var aiEnv = concat(
  [
    { name: 'M365_COPILOT_ENABLED', value: string(enableM365Copilot) }
    { name: 'M365_COPILOT_VARIANT', value: m365CopilotVariant }
  ],
  deployAzureOpenAI
    ? [
        { name: 'AZURE_FOUNDRY_ENDPOINT', value: openai!.properties.endpoint }
        { name: 'AZURE_FOUNDRY_DEPLOYMENT', value: openAiModelName }
        { name: 'AZURE_MANAGED_IDENTITY_CLIENT_ID', value: identity.properties.clientId }
      ]
    : [],
  empty(sharePointDriveId) ? [] : [{ name: 'SHAREPOINT_DRIVE_ID', value: sharePointDriveId }]
)

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: names.app
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
        ipSecurityRestrictions: [for (cidr, i) in allowedIpRanges: { name: 'erlaubt-${i}', ipAddressRange: cidr, action: 'Allow' }]
      }
      registries: empty(serverImage) ? [] : [{ server: acr.properties.loginServer, identity: identity.id }]
      secrets: [
        { name: 'database-url', keyVaultUrl: secretDbUrl.properties.secretUri, identity: identity.id }
        { name: 'entra-client-secret', keyVaultUrl: secretApiClient.properties.secretUri, identity: identity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'server'
          image: image
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: concat(
            [
              { name: 'NODE_ENV', value: 'production' }
              { name: 'PORT', value: '8080' }
              { name: 'DATABASE_URL', secretRef: 'database-url' }
              { name: 'DATABASE_SSL', value: 'require' }
              { name: 'STORAGE_DIR', value: '/data/files' }
              { name: 'AUTH_MODE', value: 'entra' }
              { name: 'ENTRA_TENANT_ID', value: tenantId }
              { name: 'ENTRA_API_AUDIENCE', value: '${apiAudience},${apiClientId}' }
              { name: 'ENTRA_CLIENT_ID', value: apiClientId }
              { name: 'ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
              { name: 'ADMIN_USERS', value: adminUsers }
              { name: 'AI_TIMEZONE', value: 'Europe/Zurich' }
            ],
            aiEnv
          )
          volumeMounts: [{ volumeName: 'belege', mountPath: '/data/files' }]
          probes: empty(serverImage)
            ? []
            : [
                { type: 'Liveness', httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 30, failureThreshold: 3 }
                { type: 'Readiness', httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 10, initialDelaySeconds: 5 }
              ]
        }
      ]
      volumes: [{ name: 'belege', storageType: 'AzureFile', storageName: envStorage.name }]
      // mind. 1 Instanz: Live-Ereignisse (SSE) und LISTEN/NOTIFY brauchen eine laufende Instanz
      scale: { minReplicas: 1, maxReplicas: 3, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }] }
    }
  }
  dependsOn: [acrPull, kvSecretsUser, pgDb, pgTls]
}

output serverUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output containerAppName string = app.name
output keyVaultName string = kv.name
output managedIdentityClientId string = identity.properties.clientId
output openAiEndpoint string = deployAzureOpenAI ? openai!.properties.endpoint : ''
output postgresHost string = pg.properties.fullyQualifiedDomainName
