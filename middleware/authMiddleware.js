import mongoose from 'mongoose';
import { Project } from '../models/Project.js';
import { ApiKey, hashApiKey } from '../models/ApiKey.js';
import { isDbConnected } from '../config/database.js';

/**
 * Middleware to authenticate ingestion requests using Bearer API key.
 * Validates the key against ApiKey collection (O(1) indexed lookup),
 * falling back to the legacy Project.key field for backwards compatibility.
 */
export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header' });
  }

  const tokenKey = authHeader.substring(7);
  const { projectId } = req.params;

  try {
    if (isDbConnected()) {
      // First try: O(1) lookup via hashed API key
      const hashed = hashApiKey(tokenKey);
      const apiKey = await ApiKey.findOne({ hashedKey: hashed, status: 'ACTIVE' });
      if (apiKey) {
        apiKey.lastUsedAt = new Date();
        apiKey.save().catch(() => {});
        req.project = { _id: apiKey.projectId };
        return next();
      }

      // Fallback: Legacy Project.key field lookup
      if (mongoose.Types.ObjectId.isValid(projectId)) {
        const project = await Project.findOne({ _id: projectId, key: tokenKey });
        if (project) {
          req.project = project;
          return next();
        }
      }
    } else {
      // Standalone mock mode
      if (tokenKey === 'testkey') {
        req.project = { _id: projectId, name: 'Mock Project', key: 'testkey' };
        return next();
      }
    }

    return res.status(403).json({ error: 'Forbidden: Invalid API Key or Project ID' });
  } catch (err) {
    console.error('[AuthMiddleware] Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
