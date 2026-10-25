import mongoose from 'mongoose';
import { Kafka } from 'kafkajs';
import dotenv from 'dotenv';
import { connectDatabase, isDbConnected } from '../config/database.js';
import { correlateEvent } from './correlator.js';
import { getServerlessKafkaConfig, ServerlessKafkaConsumer } from '../services/serverlessKafka.js';

dotenv.config();

const serverlessKafkaConfig = getServerlessKafkaConfig();
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_ENABLED = process.env.KAFKA_ENABLED !== 'false';

// Mongoose Schema for raw Telemetry Event
const EventSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.Mixed, required: true, index: true },
  trace_id: { type: String, required: true },
  service: { type: String, required: true },
  env: { type: String, required: true },
  release_sha: String,
  repo_url: String,
  branch: String,
  severity: { type: String, enum: ['info', 'warning', 'error', 'critical'] },
  stack: Array,
  metrics: Object,
  tags: Object,
  location: Object,
  timestamp: { type: Date, default: Date.now }
}, { strict: false });

// TTL index to automatically purge old records after 30 days
EventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const TelemetryEvent = mongoose.models.TelemetryEvent || mongoose.model('TelemetryEvent', EventSchema);

let consumer = null;
if (KAFKA_ENABLED) {
  const kafka = new Kafka({
    clientId: 'incident-processor',
    brokers: KAFKA_BROKERS,
    retry: { initialRetryTime: 100, retries: 2 }
  });
  consumer = kafka.consumer({ groupId: 'incident-processor-group' });
}

/**
 * Main event processing loop
 */
export async function processEvent(eventData) {
  try {
    const eventObj = typeof eventData === 'string' ? JSON.parse(eventData) : eventData;

    if (eventObj.timestamp) {
      eventObj.timestamp = new Date(eventObj.timestamp);
    }

    // Correlate and deduplicate into Incident (this resolves and attaches eventObj.location)
    const { incident, isNew, fingerprint } = await correlateEvent(eventObj);

    if (isDbConnected()) {
      const dbEvent = new TelemetryEvent(eventObj);
      await dbEvent.save();
    }

    const actionLabel = isNew ? 'Opened NEW Incident' : `Correlated (Count: ${incident.eventCount})`;
    console.log(`[Worker] ${actionLabel} -> [${incident.title}] (Hash: ${fingerprint.primaryHash}, Status: ${incident.status})`);
    return { incident, isNew };
  } catch (err) {
    console.error('[Worker] Error processing/correlating event:', err.message);
  }
}

export async function startWorker() {
  await connectDatabase();

  if (serverlessKafkaConfig) {
    console.log(`[Worker] Serverless Kafka configured (${serverlessKafkaConfig.baseUrl}). Starting REST consumer...`);
    const serverlessConsumer = new ServerlessKafkaConsumer({
      onMessage: async (eventData) => {
        await processEvent(eventData);
      }
    });
    await serverlessConsumer.start();
    return serverlessConsumer;
  }

  if (KAFKA_ENABLED && consumer) {
    try {
      consumer.on(consumer.events.CRASH, async (event) => {
        console.error('[Worker] Kafka Consumer crashed:', event.payload.error.message);
        console.warn('[Worker] Scheduling re-connection in 10 seconds...');
        try {
          await consumer.disconnect();
        } catch (_) {}
        setTimeout(startWorker, 10000);
      });

      await consumer.connect();
      console.log('[Worker] Connected to Kafka Consumer.');

      await consumer.subscribe({ topic: 'telemetry-events', fromBeginning: true });
      console.log('[Worker] Subscribed to topic: telemetry-events');

      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const value = message.value.toString();
          await processEvent(value);
        }
      });
    } catch (err) {
      console.error('[Worker] Kafka Consumer connection error:', err.message);
      console.warn('[Worker] Running in standby mode. Retrying Kafka connection in 10s...');
      try {
        await consumer.stop();
        await consumer.disconnect();
      } catch (_) {}
      setTimeout(startWorker, 10000);
    }
  } else {
    console.log('[Worker] Kafka disabled. Processor in direct dispatch mode.');
  }
}

// Auto-start if executed directly
if (process.argv[1] && process.argv[1].endsWith('worker.js')) {
  startWorker();
}
