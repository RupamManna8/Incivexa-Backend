import https from 'https';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Serverless Kafka Client (Aiven / Karapace / Confluent REST Proxy v2)
 *
 * Implements high-throughput event producing and consumer polling over
 * HTTP/HTTPS REST APIs without requiring heavy TCP broker connections
 * or ZooKeeper infrastructure.
 */

// Custom agent with keep-alive for high-throughput HTTP REST calls
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: false
});

/**
 * Resolve Serverless Kafka credentials and endpoint from environment
 */
export function getServerlessKafkaConfig() {
  const rawUrl = process.env.KAFKA_AIVEN_URL || process.env.KAFKA_REST_URL;
  if (!rawUrl || rawUrl.trim().length === 0) {
    return null;
  }

  try {
    const cleanUrl = rawUrl.trim();
    const parsed = new URL(cleanUrl);
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    const baseUrl = `${parsed.protocol}//${parsed.host}`;
    const topic = process.env.KAFKA_TOPIC || 'telemetry-events';

    let authHeader = null;
    if (username || password) {
      authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    return {
      enabled: true,
      baseUrl,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      username,
      password,
      authHeader,
      topic
    };
  } catch (err) {
    console.error('[Serverless Kafka] Invalid URL configuration in KAFKA_AIVEN_URL:', err.message);
    return null;
  }
}

/**
 * Execute HTTP/HTTPS REST request to Kafka REST Proxy
 */
async function kafkaRestRequest(targetUrl, method = 'GET', body = null, extraHeaders = {}) {
  const config = getServerlessKafkaConfig();
  if (!config) throw new Error('Serverless Kafka not configured');

  const headers = {
    'Accept': 'application/vnd.kafka.v2+json, application/json',
    'Content-Type': 'application/vnd.kafka.json.v2+json',
    ...extraHeaders
  };

  if (config.authHeader && !headers['Authorization']) {
    headers['Authorization'] = config.authHeader;
  }

  const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      agent: httpsAgent,
      timeout: 8000
    }, (res) => {
      let responseText = '';
      res.on('data', chunk => { responseText += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          if (responseText) json = JSON.parse(responseText);
        } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json || responseText
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Serverless Kafka request timeout'));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Produce a batch of events to Serverless Kafka topic
 *
 * @param {string} topic - Kafka topic name (default: 'telemetry-events')
 * @param {Array<Object>} events - Array of telemetry events
 * @param {string} partitionKey - Partition key (e.g. projectId)
 * @returns {Promise<{ success: boolean, offsets?: Array, error?: string, status?: number }>}
 */
export async function produceServerlessEvents(topic, events, partitionKey = null) {
  const config = getServerlessKafkaConfig();
  if (!config) {
    return { success: false, error: 'Serverless Kafka not configured' };
  }

  const targetTopic = topic || config.topic;
  const endpoint = `${config.baseUrl}/topics/${targetTopic}`;

  const records = events.map(evt => ({
    key: partitionKey || evt.projectId || evt.trace_id || 'default',
    value: evt
  }));

  try {
    const res = await kafkaRestRequest(endpoint, 'POST', { records });

    if (res.status === 200) {
      return { success: true, offsets: res.data?.offsets };
    }

    // Karapace or Aiven returns 404 if topic has not been created yet
    if (res.status === 404) {
      console.warn(`[Serverless Kafka] Topic '${targetTopic}' not found on Aiven cluster. Falling back to direct dispatch.`);
      return { success: false, status: 404, error: `Topic '${targetTopic}' not found` };
    }

    console.warn(`[Serverless Kafka] Produce returned status ${res.status}:`, res.data);
    return { success: false, status: res.status, error: res.data };
  } catch (err) {
    console.warn(`[Serverless Kafka] Produce failed (${err.message}). Falling back to direct dispatch.`);
    return { success: false, error: err.message };
  }
}

/**
 * Check if Serverless Kafka is configured and reachable
 */
export async function checkServerlessKafkaHealth() {
  const config = getServerlessKafkaConfig();
  if (!config) {
    return { configured: false, status: 'disabled' };
  }

  try {
    const res = await kafkaRestRequest(`${config.baseUrl}/topics`, 'GET');
    if (res.status === 200) {
      return {
        configured: true,
        status: 'connected',
        provider: 'aiven-serverless',
        topics: Array.isArray(res.data) ? res.data : []
      };
    }
    return { configured: true, status: 'warning', statusCode: res.status, details: res.data };
  } catch (err) {
    return { configured: true, status: 'unreachable', error: err.message };
  }
}

/**
 * Serverless Kafka Consumer Loop
 *
 * Automatically manages consumer instance lifecycle:
 * 1. Creates consumer instance in consumer group
 * 2. Subscribes to topic
 * 3. Continuously polls for records with backoff
 * 4. Gracefully commits and deletes consumer on shutdown
 */
export class ServerlessKafkaConsumer {
  constructor(options = {}) {
    this.groupId = options.groupId || 'incident-processor-group';
    this.instanceId = options.instanceId || `proc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.topic = options.topic || process.env.KAFKA_TOPIC || 'telemetry-events';
    this.onMessage = options.onMessage || (async () => {});
    this.pollIntervalMs = options.pollIntervalMs || 1000;
    this.isRunning = false;
    this.baseUri = null;
    this.pollingTimer = null;
  }

  async start() {
    const config = getServerlessKafkaConfig();
    if (!config) {
      console.log('[Serverless Consumer] KAFKA_AIVEN_URL not set. Running in direct mode.');
      return;
    }

    this.isRunning = true;
    console.log(`[Serverless Consumer] Initializing consumer group '${this.groupId}' on ${config.baseUrl}...`);

    await this._initializeAndRun();
  }

  async _initializeAndRun() {
    const config = getServerlessKafkaConfig();
    if (!this.isRunning || !config) return;

    try {
      // Step 1: Create Consumer Instance
      const createRes = await kafkaRestRequest(`${config.baseUrl}/consumers/${this.groupId}`, 'POST', {
        name: this.instanceId,
        format: 'json',
        'auto.offset.reset': 'earliest'
      });

      if (createRes.status !== 200) {
        console.warn(`[Serverless Consumer] Create instance returned status ${createRes.status}:`, createRes.data);
        this._scheduleRetry(10000);
        return;
      }

      this.baseUri = createRes.data?.base_uri;
      if (!this.baseUri) {
        this.baseUri = `${config.baseUrl}/consumers/${this.groupId}/instances/${this.instanceId}`;
      }

      console.log(`[Serverless Consumer] Consumer instance created (${this.instanceId}). Subscribing to '${this.topic}'...`);

      // Step 2: Subscribe to topic
      const subRes = await kafkaRestRequest(`${this.baseUri}/subscription`, 'POST', {
        topics: [this.topic]
      });

      if (subRes.status !== 204 && subRes.status !== 200) {
        console.warn(`[Serverless Consumer] Subscription notice (status ${subRes.status}):`, subRes.data);
      } else {
        console.log(`[Serverless Consumer] Subscribed to topic '${this.topic}'. Polling for telemetry events...`);
      }

      // Step 3: Begin Polling Loop
      this._poll();
    } catch (err) {
      console.warn(`[Serverless Consumer] Setup error (${err.message}). Retrying in 10s...`);
      this._scheduleRetry(10000);
    }
  }

  async _poll() {
    if (!this.isRunning || !this.baseUri) return;

    try {
      const recordsRes = await kafkaRestRequest(
        `${this.baseUri}/records`,
        'GET',
        null,
        { 'Accept': 'application/vnd.kafka.json.v2+json' }
      );

      if (recordsRes.status === 200 && Array.isArray(recordsRes.data)) {
        for (const record of recordsRes.data) {
          try {
            await this.onMessage(record.value, record);
          } catch (handlerErr) {
            console.error('[Serverless Consumer] Error processing event:', handlerErr.message);
          }
        }
      } else if (recordsRes.status === 404) {
        // Consumer expired or topic doesn't exist
        console.warn('[Serverless Consumer] Polling notice (404). Re-registering consumer instance...');
        await this._cleanupInstance();
        this._scheduleRetry(5000);
        return;
      }

      // Schedule next poll
      if (this.isRunning) {
        this.pollingTimer = setTimeout(() => this._poll(), this.pollIntervalMs);
      }
    } catch (err) {
      // Network hiccup or temporary timeout
      if (this.isRunning) {
        this.pollingTimer = setTimeout(() => this._poll(), 3000);
      }
    }
  }

  _scheduleRetry(delayMs) {
    if (!this.isRunning) return;
    this.pollingTimer = setTimeout(() => this._initializeAndRun(), delayMs);
  }

  async _cleanupInstance() {
    if (this.baseUri) {
      try {
        await kafkaRestRequest(this.baseUri, 'DELETE');
      } catch (_) {}
      this.baseUri = null;
    }
  }

  async stop() {
    this.isRunning = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    await this._cleanupInstance();
    console.log('[Serverless Consumer] Consumer stopped cleanly.');
  }
}
