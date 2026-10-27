import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Project } from '../models/Project.js';
import { ApiKey } from '../models/ApiKey.js';
import { createApiKey } from '../services/keyService.js';
import { locationService } from '../services/locationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/incident_manager';

export async function cleanDatabase(options = {}) {
  const { preserveProjects = false } = options;
  console.log(`[DBClean] Connecting to MongoDB at ${MONGO_URI}...`);

  let shouldDisconnect = false;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 4000 });
    shouldDisconnect = true;
  }

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  console.log('[DBClean] Found collections:', collectionNames);

  const purgeList = ['telemetryevents', 'events', 'incidents', 'investigations', 'sandbox_jobs', 'sandbox_results', 'stats', 'notifications'];
  if (!preserveProjects) {
    purgeList.push('repositories');
  }

  const stats = {};

  for (const colName of purgeList) {
    if (collectionNames.includes(colName)) {
      const res = await db.collection(colName).deleteMany({});
      stats[colName] = res.deletedCount;
      console.log(`[DBClean] Purged ${res.deletedCount} documents from '${colName}'.`);
    }
  }

  // Deduplicate any orphaned/multiple repositories per project
  if (collectionNames.includes('repositories')) {
    const repos = await db.collection('repositories').find().sort({ updatedAt: -1, _id: -1 }).toArray();
    const seen = new Set();
    for (const r of repos) {
      const key = String(r.projectId);
      if (seen.has(key)) {
        await db.collection('repositories').deleteOne({ _id: r._id });
      } else {
        seen.add(key);
      }
    }
  }

  locationService.clearLiveHits();

  // Retain clean state without hardcoding any demo project
  if (shouldDisconnect) {
    await mongoose.disconnect();
  }

  console.log('[DBClean] Database cleanup completed successfully!');
  return { success: true, purged: stats };
}

// Allow direct CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  cleanDatabase()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[DBClean] Error:', err.message);
      process.exit(1);
    });
}
