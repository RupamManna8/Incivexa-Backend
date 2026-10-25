import dotenv from 'dotenv';
import { checkServerlessKafkaHealth } from './serverlessKafka.js';

dotenv.config();

const HOST = process.env.HOST || 'localhost';

const SERVICES = {
  'ai-engine': { url: `http://${HOST}:8000/health`, name: 'Python AI Engine' },
  'sdk-service': { url: `http://${HOST}:3001/health`, name: 'SDK Demo Service' },
  'dashboard': { url: `http://${HOST}:5173`, name: 'Frontend Dashboard' }
};

/**
 * Probes all registered services and returns their health status.
 */
export async function getServicesHealth() {
  const results = {};

  await Promise.all(
    Object.entries(SERVICES).map(async ([key, svc]) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(svc.url, { signal: controller.signal });
        clearTimeout(timeout);
        results[key] = { name: svc.name, status: res.ok ? 'online' : 'degraded', statusCode: res.status };
      } catch (err) {
        results[key] = { name: svc.name, status: 'offline', error: err.message };
      }
    })
  );

  // Probe Serverless Kafka
  try {
    const kafkaHealth = await checkServerlessKafkaHealth();
    if (kafkaHealth.configured) {
      results['kafka'] = {
        name: 'Serverless Kafka (Aiven Cloud)',
        status: kafkaHealth.status === 'connected' ? 'online' : (kafkaHealth.status === 'warning' ? 'degraded' : 'offline'),
        provider: 'aiven-serverless',
        topics: kafkaHealth.topics || [],
        details: kafkaHealth
      };
    }
  } catch (err) {
    results['kafka'] = {
      name: 'Serverless Kafka (Aiven Cloud)',
      status: 'offline',
      error: err.message
    };
  }

  return results;
}

