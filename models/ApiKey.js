import mongoose from 'mongoose';
import crypto from 'crypto';

const ApiKeySchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  prefix: { type: String, required: true },
  hashedKey: { type: String, required: true, unique: true, index: true },
  label: { type: String, default: 'Default Key' },
  permissions: { type: [String], default: ['ingest'] },
  status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE', index: true },
  lastUsedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null }
}, {
  timestamps: true
});

/**
 * Generates a new API key: aim_live_<32 hex chars>
 * Returns { rawKey, prefix, hashedKey } — rawKey is shown once and never stored.
 */
export function generateApiKey() {
  const rawKey = `aim_live_${crypto.randomBytes(32).toString('hex')}`;
  const prefix = rawKey.substring(0, 13);
  const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
  return { rawKey, prefix, hashedKey };
}

/**
 * Hashes a raw API key for lookup.
 */
export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export const ApiKey = mongoose.models.ApiKey || mongoose.model('ApiKey', ApiKeySchema);
