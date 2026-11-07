import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';
import { loadAiConfig } from './ai/config.js';
import { buildRegistry } from './ai/registry.js';
import { PgEventBus } from './lib/events.js';
import { SharePointUploader } from './lib/sharepoint.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);

const ai = buildRegistry(loadAiConfig());
const events = new PgEventBus(db, msg => console.warn(msg));
await events.start();
const sharePoint =
  config.SHAREPOINT_DRIVE_ID && ai.tokens
    ? new SharePointUploader({ driveId: config.SHAREPOINT_DRIVE_ID, rootFolder: config.SHAREPOINT_ROOT_FOLDER, graphBaseUrl: config.GRAPH_BASE_URL }, ai.tokens)
    : null;

const app = await buildApp(config, db, { ai, events, sharePoint });
app.log.info(`Anmeldung: ${config.authMode}`);
for (const p of ai.problems) app.log.warn(`KI-Anbieter ${p.provider} unvollständig konfiguriert: ${p.message}`);
app.log.info(`KI-Anbieter aktiv: ${[...ai.registry.keys()].join(', ') || 'keine'}`);
app.log.info(`SharePoint-Ablage: ${sharePoint ? 'aktiv' : 'nicht konfiguriert'}`);
await app.listen({ port: config.PORT, host: config.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await events.stop();
    await db.end();
    process.exit(0);
  });
}
