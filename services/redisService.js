import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const REDIS_BASE_URL = (process.env.REDIS_API_URL || (process.env.KAFKA_GATEWAY_URL ? `${process.env.KAFKA_GATEWAY_URL}/api/v1/redis` : '')).replace(/\/+$/, '');
const REDIS_API_KEY = process.env.REDIS_API_KEY || process.env.KAFKA_GATEWAY_API_KEY || '';

export class RedisService {
  constructor(baseUrl = REDIS_BASE_URL, apiKey = REDIS_API_KEY) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
  }

  /**
   * GET /api/v1/redis/:key
   */
  async get(key) {
    if (!this.baseUrl || !this.apiKey) return null;
    try {
      const url = `${this.baseUrl}/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey
        }
      });

      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text();
        console.warn(`[RedisService] GET ${key} failed (${res.status}): ${text}`);
        return null;
      }

      const data = await res.json();
      return data.value ?? data;
    } catch (err) {
      console.warn(`[RedisService] GET ${key} network error: ${err.message}`);
      return null;
    }
  }

  /**
   * PUT /api/v1/redis/:key
   * Body: { value: string, ttlSeconds: number }
   */
  async put(key, value, ttlSeconds = 86400) {
    if (!this.baseUrl || !this.apiKey) return false;
    try {
      const url = `${this.baseUrl}/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey
        },
        body: JSON.stringify({
          value: typeof value === 'object' ? JSON.stringify(value) : String(value),
          ttlSeconds: Number(ttlSeconds) || 86400
        })
      });

      if (!res.ok) {
        const text = await res.text();
        console.warn(`[RedisService] PUT ${key} failed (${res.status}): ${text}`);
        return false;
      }

      const data = await res.json();
      return data.success !== false;
    } catch (err) {
      console.warn(`[RedisService] PUT ${key} network error: ${err.message}`);
      return false;
    }
  }

  /**
   * DELETE /api/v1/redis/:key
   */
  async delete(key) {
    if (!this.baseUrl || !this.apiKey) return true;
    try {
      const url = `${this.baseUrl}/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: {
          'x-api-key': this.apiKey
        }
      });

      if (res.status === 404) return true;
      if (!res.ok) {
        const text = await res.text();
        console.warn(`[RedisService] DELETE ${key} failed (${res.status}): ${text}`);
        return false;
      }

      const data = await res.json();
      return data.success !== false;
    } catch (err) {
      console.warn(`[RedisService] DELETE ${key} network error: ${err.message}`);
      return false;
    }
  }

  /**
   * Checks if an incident is a duplicate to prevent re-investigating.
   * Keyed by fingerprint primaryHash and/or incident ID.
   */
  async checkAndMarkIncidentAnalysis(incidentKey, incidentId = '', ttlSeconds = 86400) {
    const key = `incident:analyzed:${incidentKey}`;
    const existing = await this.get(key);
    if (existing !== null && existing !== undefined) {
      return { isDuplicate: true, key, value: existing };
    }

    if (incidentId && incidentId !== incidentKey) {
      const idKey = `incident:analyzed:${incidentId}`;
      const existingId = await this.get(idKey);
      if (existingId !== null && existingId !== undefined) {
        return { isDuplicate: true, key: idKey, value: existingId };
      }
      await this.put(idKey, incidentKey, ttlSeconds);
    }

    // Not yet analyzed -> mark it in Redis
    await this.put(key, incidentId || 'analyzing', ttlSeconds);
    return { isDuplicate: false, key, value: null };
  }
}

export const redisService = new RedisService();
