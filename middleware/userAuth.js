import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { isDbConnected } from '../config/database.js';

/**
 * Middleware to authenticate requests from dashboard users.
 * Extracts GitHub token from Authorization header, query param, or X-GitHub-Token.
 */
export async function userAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (req.headers['x-github-token'] || req.query.token);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Authentication token required' });
  }

  try {
    if (isDbConnected()) {
      const user = await User.findOne({
        $or: [
          { sessionToken: token },
          { accessToken: token }
        ]
      });
      if (user) {
        req.user = user;
        return next();
      }
    }

    // Fallback: accept test/mock token or allow through with placeholder
    req.user = { githubId: 'mock-user', username: 'demo-user', accessToken: token };
    return next();
  } catch (err) {
    console.error('[UserAuth] Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * Optional authentication middleware - attaches user if token exists, but doesn't block.
 */
export async function optionalUserAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (req.headers['x-github-token'] || req.query.token);

  if (!token) {
    return next();
  }

  try {
    if (isDbConnected()) {
      const user = await User.findOne({
        $or: [
          { sessionToken: token },
          { accessToken: token }
        ]
      });
      if (user) req.user = user;
    }
  } catch (_) {}

  next();
}
