import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDatabase, isDbConnected } from './config/database.js';
import { router as authRouter } from './routes/auth.js';
import { router as githubRouter } from './routes/github.js';
import { router as repositoriesRouter } from './routes/repositories.js';
import { router as projectsRouter, seedDefaultProject } from './routes/projects.js';
import { router as ingestRouter } from './routes/ingest.js';
import { router as incidentsRouter } from './routes/incidents.js';
import { router as statsRouter } from './routes/stats.js';
import { router as servicesRouter } from './routes/services.js';
import { router as sandboxRouter } from './routes/sandbox.js';
import { cleanDatabase } from './scripts/clean-db.js';
import { startStatsRollupScheduler } from './processor/statsRollup.js';
import { startWorker } from './processor/worker.js';

import { getServerlessKafkaConfig } from './services/serverlessKafka.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const PORT = process.env.GATEWAY_PORT || process.env.PORT || 8080;
const HOST = process.env.HOST || 'localhost';
const serverlessConfig = getServerlessKafkaConfig();
const KAFKA_ENABLED = process.env.KAFKA_ENABLED !== 'false';

const app = express();

// Global CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-GitHub-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// JSON body parser
app.use(express.json({ limit: '10mb' }));

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    backend: 'online',
    host: HOST,
    port: PORT,
    mongo: isDbConnected() ? 'connected' : 'standalone-mock',
    kafka: serverlessConfig ? 'serverless-aiven' : (KAFKA_ENABLED ? 'enabled' : 'disabled')
  });
});

// Mount Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/github', githubRouter);
app.use('/api/v1/repositories', repositoriesRouter);

// Projects & Keys
app.use('/api/v1/projects', projectsRouter);

// Telemetry Ingestion (Hot Path)
app.use('/api/v1/projects', ingestRouter);

// Incident Management REST APIs
app.use('/api/v1/projects/:projectId/incidents', incidentsRouter);
app.use('/api/v1/incidents', incidentsRouter);

// Stats & Metrics
app.use('/api/v1/projects/:projectId/stats', statsRouter);
app.use('/api/v1/stats', statsRouter);

// Engine & Services Health Probe
app.use('/api/v1/services', servicesRouter);

// Sandbox Execution APIs
app.use('/api/sandbox', sandboxRouter);
app.use('/sandbox', sandboxRouter);

// Database Cleanup API Endpoint
app.post('/api/v1/db/clean', async (req, res) => {
  try {
    const result = await cleanDatabase(req.body);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[Backend] Unhandled Error:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

/**
 * Server Lifecycle Management
 */
async function startServer() {
  // Connect to Database
  await connectDatabase();
  await seedDefaultProject();

  // Start HTTP Server
  const server = app.listen(PORT, () => {
    console.log(`[Main Backend] Online and listening on http://${HOST}:${PORT}`);
  });

  // Start background processors
  if (serverlessConfig || KAFKA_ENABLED) {
    startWorker().catch(err => console.warn('[Backend] Background worker notice:', err.message));
  }
  startStatsRollupScheduler(60000);

  return server;
}

startServer();

export default app;
