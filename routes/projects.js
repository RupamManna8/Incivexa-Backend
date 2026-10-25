import { Router } from 'express';
import mongoose from 'mongoose';
import { Project } from '../models/Project.js';
import { ApiKey } from '../models/ApiKey.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/keyService.js';
import { isDbConnected } from '../config/database.js';
import { optionalUserAuth } from '../middleware/userAuth.js';

export const router = Router();

// In-memory fallback if Mongo is offline
let inMemoryProjects = [];

/**
 * List projects for the authenticated user
 * GET /api/v1/projects
 */
router.get('/', optionalUserAuth, async (req, res) => {
  try {
    if (isDbConnected()) {
      if (!req.user || !req.user._id) {
        return res.json({ projects: [] });
      }

      let query;
      // Demo operator sees demo projects
      if (req.user.email === 'alex.vance@sentinel-ops.io' || req.user.username === 'alex_vance_sre') {
        query = {
          $or: [
            { userId: req.user._id },
            { name: 'demo-repo' }
          ]
        };
      } else {
        // Normal user only sees their own projects
        query = { userId: req.user._id };
      }

      const projects = await Project.find(query).sort({ createdAt: -1 }).lean();
      return res.json({ projects });
    }

    if (!req.user || !req.user._id) {
      return res.json({ projects: [] });
    }
    const filtered = inMemoryProjects.filter(p => String(p.userId) === String(req.user._id));
    return res.json({ projects: filtered });
  } catch (err) {
    console.error('[Projects] List error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Create a new project
 * POST /api/v1/projects
 */
router.post('/', optionalUserAuth, async (req, res) => {
  const { name, description = '', repoUrl = '', rateLimit } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  const userId = req.user?._id || null;

  try {
    if (isDbConnected()) {
      // Generate unique key identifier
      const projectKey = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30) + '-' + Math.random().toString(36).slice(2, 7);

      const project = await Project.create({
        name: name.trim(),
        key: projectKey,
        description,
        repoUrl,
        userId,
        rateLimit: {
          bucketCapacity: rateLimit?.bucketCapacity || 500,
          refillRate: rateLimit?.refillRate || 200
        }
      });

      // Automatically generate first API Key for this project
      const apiKeyResult = await createApiKey(project._id, 'Default Ingestion Key');

      return res.status(201).json({
        success: true,
        project,
        apiKey: apiKeyResult
      });
    }

    // In-memory fallback
    const mockId = 'mock-' + Date.now();
    const newProject = {
      _id: mockId,
      name: name.trim(),
      key: 'testkey',
      description,
      repoUrl,
      userId: userId || 'mock-user',
      createdAt: new Date()
    };
    inMemoryProjects.push(newProject);
    return res.status(201).json({
      success: true,
      project: newProject,
      apiKey: {
        rawKey: 'aim_live_mock_' + Math.random().toString(36).slice(2, 10),
        prefix: 'aim_live_mock',
        name: 'Default Ingestion Key'
      }
    });
  } catch (err) {
    console.error('[Projects] Create error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get project details by ID
 * GET /api/v1/projects/:projectId
 */
router.get('/:projectId', async (req, res) => {
  const { projectId } = req.params;

  try {
    if (isDbConnected() && mongoose.Types.ObjectId.isValid(projectId)) {
      const project = await Project.findById(projectId).lean();
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }
      return res.json({ project });
    }

    const item = inMemoryProjects.find(p => p._id === projectId || p.key === projectId);
    if (!item) {
      return res.status(404).json({ error: 'Project not found' });
    }
    return res.json({ project: item });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Update project
 * PUT /api/v1/projects/:projectId
 */
router.put('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { name, description, repoUrl, rateLimit } = req.body;

  try {
    if (isDbConnected() && mongoose.Types.ObjectId.isValid(projectId)) {
      const update = {};
      if (name) update.name = name.trim();
      if (description !== undefined) update.description = description;
      if (repoUrl !== undefined) update.repoUrl = repoUrl;
      if (rateLimit) update.rateLimit = rateLimit;

      const project = await Project.findByIdAndUpdate(projectId, { $set: update }, { new: true });
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }
      return res.json({ success: true, project });
    }

    const item = inMemoryProjects.find(p => p._id === projectId);
    if (item) {
      if (name) item.name = name;
      if (description !== undefined) item.description = description;
      return res.json({ success: true, project: item });
    }
    return res.status(404).json({ error: 'Project not found' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Delete project
 * DELETE /api/v1/projects/:projectId
 */
router.delete('/:projectId', async (req, res) => {
  const { projectId } = req.params;

  try {
    if (isDbConnected() && mongoose.Types.ObjectId.isValid(projectId)) {
      await Project.findByIdAndDelete(projectId);
      await ApiKey.deleteMany({ projectId });
      return res.json({ success: true, message: 'Project deleted' });
    }

    inMemoryProjects = inMemoryProjects.filter(p => p._id !== projectId);
    return res.json({ success: true, message: 'Project deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * List API keys for project
 * GET /api/v1/projects/:projectId/keys
 */
router.get('/:projectId/keys', async (req, res) => {
  const { projectId } = req.params;

  try {
    const keys = await listApiKeys(projectId);
    return res.json({ keys });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Generate a new API key for project
 * POST /api/v1/projects/:projectId/keys
 */
router.post('/:projectId/keys', async (req, res) => {
  const { projectId } = req.params;
  const { name = 'API Key' } = req.body;

  try {
    const newKey = await createApiKey(projectId, name);
    return res.status(201).json({ success: true, apiKey: newKey });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Revoke an API key
 * DELETE /api/v1/projects/:projectId/keys/:keyId
 */
router.delete('/:projectId/keys/:keyId', async (req, res) => {
  const { keyId } = req.params;

  try {
    const revoked = await revokeApiKey(keyId);
    if (!revoked) {
      return res.status(404).json({ error: 'API key not found' });
    }
    return res.json({ success: true, message: 'API key revoked' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to seed the default project in MongoDB if empty
 */
export async function seedDefaultProject() {
  // Retained as no-op: Clean state is preserved so new users go through project onboarding.
}
