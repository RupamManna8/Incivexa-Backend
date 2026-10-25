import crypto from 'crypto';
import mongoose from 'mongoose';
import { ApiKey, generateApiKey, hashApiKey } from '../models/ApiKey.js';
import { isDbConnected } from '../config/database.js';

/**
 * Creates a new API key for a project.
 * Returns the raw key (shown once) and persists the hashed version.
 */
export async function createKey(projectId, label = 'Default Key') {
  const { rawKey, prefix, hashedKey } = generateApiKey();

  if (isDbConnected()) {
    await ApiKey.create({
      projectId: new mongoose.Types.ObjectId(projectId),
      prefix,
      hashedKey,
      label,
      permissions: ['ingest'],
      status: 'ACTIVE'
    });
  }

  return { rawKey, prefix, label };
}

export const createApiKey = createKey;

/**
 * Revokes an API key by its ID or prefix.
 */
export async function revokeKey(keyIdOrPrefix, maybePrefix) {
  if (!isDbConnected()) return { success: false, message: 'Database not connected' };

  let query = {};
  if (maybePrefix) {
    // Called as revokeKey(projectId, keyPrefix)
    query = { projectId: keyIdOrPrefix, prefix: maybePrefix, status: 'ACTIVE' };
  } else if (mongoose.Types.ObjectId.isValid(keyIdOrPrefix)) {
    query = { _id: new mongoose.Types.ObjectId(keyIdOrPrefix) };
  } else {
    query = { prefix: keyIdOrPrefix };
  }

  const result = await ApiKey.updateOne(query, { $set: { status: 'REVOKED' } });
  return result.modifiedCount > 0;
}

export const revokeApiKey = revokeKey;

/**
 * Lists all API keys for a project (showing only prefix, not full key).
 */
export async function listKeys(projectId) {
  if (!isDbConnected() || !mongoose.Types.ObjectId.isValid(projectId)) return [];
  return ApiKey.find({ projectId: new mongoose.Types.ObjectId(projectId) })
    .select('prefix label status permissions lastUsedAt createdAt expiresAt')
    .lean();
}

export const listApiKeys = listKeys;

/**
 * Rotates a project's API key: revokes old, generates new.
 */
export async function rotateKey(projectId) {
  if (isDbConnected()) {
    await ApiKey.updateMany({ projectId, status: 'ACTIVE' }, { $set: { status: 'REVOKED' } });
  }
  return createKey(projectId, 'Rotated Key');
}
