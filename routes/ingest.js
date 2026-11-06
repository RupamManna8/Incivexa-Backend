import { Router } from 'express';
import { Kafka } from 'kafkajs';
import dotenv from 'dotenv';
import { validateEvent } from '../shared/contracts.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { processEvent } from '../processor/worker.js';
import { correlateEvent } from '../processor/correlator.js';

import { getServerlessKafkaConfig, produceServerlessEvents } from '../services/serverlessKafka.js';

dotenv.config();

export const router = Router();

const serverlessKafkaConfig = getServerlessKafkaConfig();
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_ENABLED = process.env.KAFKA_ENABLED !== 'false';
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || 'telemetry-events';

let producer = null;
if (serverlessKafkaConfig) {
  console.log(`[Ingest] Serverless Kafka enabled (${serverlessKafkaConfig.baseUrl}).`);
} else if (KAFKA_ENABLED) {
  const kafka = new Kafka({
    clientId: 'incident-gateway',
    brokers: KAFKA_BROKERS,
    retry: { initialRetryTime: 300, retries: 5 }
  });
  producer = kafka.producer();
  producer.connect()
    .then(() => console.log('[Ingest] Kafka Producer connected.'))
    .catch(err => console.warn('[Ingest] Kafka Producer connection notice:', err.message));
}

/**
 * POST /api/v1/projects/:projectId/ingest
 * High-throughput telemetry ingestion endpoint.
 * Validates events → rate limits → Kafka produce → 202 Accepted.
 */
router.post('/:projectId/ingest', authMiddleware, async (req, res) => {
  const { projectId } = req.params;

  if (!checkRateLimit(projectId)) {
    return res.status(429).json({ error: 'Too Many Requests: Rate limit exceeded' });
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const validEvents = [];
  const validationErrors = [];

  for (const rawEvent of events) {
    const { valid, errors } = validateEvent(rawEvent);
    if (!valid) {
      validationErrors.push({ event: rawEvent, errors });
    } else {
      rawEvent.projectId = projectId;
      if (!rawEvent.tags) rawEvent.tags = {};
      if (!rawEvent.tags.client_ip && !rawEvent.tags.ip) {
        const callerIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip || '127.0.0.1';
        rawEvent.tags.client_ip = callerIp;
      }
      validEvents.push(rawEvent);
    }
  }

  if (validEvents.length === 0) {
    return res.status(400).json({ error: 'Bad Request: No valid events', details: validationErrors });
  }

  try {
    let dispatchedToServerless = false;

    if (serverlessKafkaConfig) {
      const result = await produceServerlessEvents(null, validEvents, projectId);
      if (result.success) {
        dispatchedToServerless = true;
      } else {
        console.warn('[Ingest] Serverless produce fallback triggered:', result.error);
      }
    }

    if (!dispatchedToServerless) {
      if (KAFKA_ENABLED && producer) {
        const messages = validEvents.map(event => ({
          key: projectId,
          value: JSON.stringify(event)
        }));
        await producer.send({ topic: KAFKA_TOPIC, messages });
      } else {
        for (const event of validEvents) {
          await processEvent(event);
        }
      }
    }

    return res.status(202).json({
      status: 'accepted',
      acceptedCount: validEvents.length,
      rejectedCount: validationErrors.length,
      errors: validationErrors.length > 0 ? validationErrors : undefined
    });
  } catch (err) {
    console.error('[Ingest] Processing error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
