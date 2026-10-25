import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/incident_manager';

/**
 * Connect to MongoDB with tuned connection pool for high throughput.
 * - maxPoolSize: 50 concurrent connections (default is 5)
 * - minPoolSize: 10 warm connections for consistent latency
 */
export async function connectDatabase() {
  if (mongoose.connection.readyState >= 1) {
    return mongoose.connection;
  }

  try {
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 50,
      minPoolSize: 10,
      serverSelectionTimeoutMS: 3000,
      socketTimeoutMS: 10000
    });
    console.log(`[Database] Connected to MongoDB (pool: 50).`);
    return mongoose.connection;
  } catch (err) {
    console.warn(`[Database] MongoDB connection failed. Running in standalone mode: ${err.message}`);
    return null;
  }
}

export function isDbConnected() {
  return mongoose.connection.readyState === 1;
}
