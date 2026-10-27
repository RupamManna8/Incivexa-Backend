import { Router } from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Repository, REPOSITORY_STATUS } from '../models/Repository.js';
import { Project } from '../models/Project.js';
import { User } from '../models/User.js';
import { isDbConnected } from '../config/database.js';
import { extractRepositoryKnowledge } from '../services/repoKnowledgeService.js';

dotenv.config();

export const router = Router();

const HOST = process.env.HOST || 'localhost';
// Unified AI Engine runs on port 8000
const AI_ENGINE_URL = process.env.AI_ENGINE_URL || (process.env.INVESTIGATION_API_URL?.includes(':8001') ? `http://${HOST}:8000` : (process.env.INVESTIGATION_API_URL || `http://${HOST}:8000`));

/**
 * Get active/selected repository for a project
 * GET /api/v1/repositories/active?projectId=...
 */
router.get('/active', async (req, res) => {
  const { projectId } = req.query;

  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.json({ repository: null });
  }

  try {
    if (isDbConnected()) {
      const repo = await Repository.findOne({ projectId: new mongoose.Types.ObjectId(projectId) });
      if (!repo) {
        return res.json({ repository: null });
      }

      if (!repo.dependencyGraph && repo.repoUrl) {
        // Extract knowledge if not yet cached
        try {
          const knowledge = await extractRepositoryKnowledge(repo.repoUrl, { name: repo.name, fullName: repo.fullName });
          if (knowledge && knowledge.dependencyGraph?.nodes?.length > 0) {
            repo.dependencyGraph = knowledge.dependencyGraph;
            repo.chunkCount = knowledge.chunkCount || repo.chunkCount;
            repo.files = knowledge.files || repo.files;
            repo.symbols = knowledge.symbols || repo.symbols;
            await repo.save();
          }
        } catch (e) {
          // ignore extraction error on passive fetch
        }
      }

      return res.json({ repository: repo });
    }
    return res.json({ repository: null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get repository knowledge & dependency graph for a project
 * GET /api/v1/repositories/knowledge?projectId=...
 */
router.get('/knowledge', async (req, res) => {
  const { projectId } = req.query;

  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.json({ success: true, connected: false, knowledge: null });
  }

  try {
    if (isDbConnected()) {
      const repo = await Repository.findOne({ projectId: new mongoose.Types.ObjectId(projectId) });
      if (!repo || !repo.repoUrl) {
        return res.json({ success: true, connected: false, knowledge: null });
      }

      if (repo.dependencyGraph && repo.symbols?.length > 0) {
        return res.json({
          success: true,
          connected: true,
          knowledge: {
            repoUrl: repo.repoUrl,
            name: repo.name,
            defaultBranch: repo.defaultBranch || 'main',
            files: repo.files || [],
            chunkCount: repo.chunkCount || 0,
            symbolsCount: repo.symbols?.length || 0,
            symbols: repo.symbols || [],
            dependencyGraph: repo.dependencyGraph
          }
        });
      }

      // Extract real knowledge from local clone / cache
      const knowledge = await extractRepositoryKnowledge(repo.repoUrl, { name: repo.name, fullName: repo.fullName });
      if (knowledge && knowledge.dependencyGraph?.nodes?.length > 0) {
        repo.dependencyGraph = knowledge.dependencyGraph;
        repo.chunkCount = knowledge.chunkCount || repo.chunkCount;
        repo.files = knowledge.files || repo.files;
        repo.symbols = knowledge.symbols || repo.symbols;
        await repo.save();
      }

      return res.json({ success: true, connected: true, knowledge });
    }
    return res.json({ success: true, connected: false, knowledge: null });
  } catch (err) {
    console.error('[Repository] Knowledge fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Select / Connect a repository for a project, enforcing max 1 repo per project
 * POST /api/v1/repositories/select
 */
router.post('/select', async (req, res) => {
  const { repoUrl, name, fullName, defaultBranch = 'main', projectId, commitSha = 'HEAD' } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required.' });
  }

  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ error: 'A valid projectId is required.' });
  }

  const pid = new mongoose.Types.ObjectId(projectId);

  try {
    if (isDbConnected()) {
      const project = await Project.findById(pid);
      if (!project) {
        return res.status(404).json({ error: 'Project not found.' });
      }

      const repoName = name || repoUrl.split('/').pop().replace('.git', '');
      const repoFullName = fullName || repoUrl;

      // Check if project already has a connected repository (enforce 1 repository rule)
      const existingRepo = await Repository.findOne({ projectId: pid });
      const isReplacement = existingRepo && existingRepo.repoUrl !== repoUrl;

      // Resolve user token for authenticated Git access if private
      let userToken = req.body.accessToken || req.body.pat || null;
      const authHeader = req.headers.authorization;
      if (!userToken && authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const user = await User.findOne({ $or: [{ sessionToken: token }, { accessToken: token }] });
        if (user) {
          userToken = user.accessToken;
        }
      }
      if (!userToken && existingRepo?.accessToken) {
        userToken = existingRepo.accessToken;
      }

      let repoDoc;
      if (isReplacement) {
        // Explicit replacement: Wipe old data, dependency graph, and symbol index
        repoDoc = await Repository.findOneAndUpdate(
          { projectId: pid },
          {
            $set: {
              repoUrl,
              name: repoName,
              fullName: repoFullName,
              defaultBranch,
              isPrivate: Boolean(isPrivate),
              accessToken: userToken,
              status: REPOSITORY_STATUS.INDEXING,
              lastIndexedCommit: null,
              indexedCommits: [],
              chunkCount: 0,
              files: [],
              symbols: [],
              dependencyGraph: null,
              lastError: null
            }
          },
          { new: true }
        );
      } else {
        repoDoc = await Repository.findOneAndUpdate(
          { projectId: pid },
          {
            $set: {
              repoUrl,
              name: repoName,
              fullName: repoFullName,
              defaultBranch,
              isPrivate: Boolean(isPrivate),
              accessToken: userToken || (existingRepo && existingRepo.accessToken),
              status: REPOSITORY_STATUS.INDEXING,
              lastError: null
            }
          },
          { upsert: true, new: true }
        );
      }

      // Update Project record
      await Project.findByIdAndUpdate(pid, { repoUrl, defaultBranch });

      if (userToken) {
        User.updateOne(
          { accessToken: userToken },
          {
            $set: {
              selectedRepo: {
                name: repoDoc.name,
                fullName: repoDoc.fullName,
                repoUrl: repoDoc.repoUrl,
                defaultBranch: repoDoc.defaultBranch,
                status: 'INDEXING',
                indexedCommit: commitSha,
                chunkCount: repoDoc.chunkCount || 0,
                lastIndexedAt: new Date()
              }
            }
          }
        ).catch(() => {});
      }

      // Asynchronously trigger AI Engine indexing
      triggerIndexing(repoUrl, commitSha, pid, userToken).then(async () => {
        // Once cloned, build AST knowledge & dependency graph
        try {
          const knowledge = await extractRepositoryKnowledge(repoUrl, { name: repoName, fullName: repoFullName });
          if (knowledge && knowledge.dependencyGraph?.nodes?.length > 0) {
            await Repository.updateOne(
              { projectId: pid },
              {
                $set: {
                  dependencyGraph: knowledge.dependencyGraph,
                  symbols: knowledge.symbols,
                  files: knowledge.files,
                  chunkCount: knowledge.chunkCount || repoDoc.chunkCount,
                  status: REPOSITORY_STATUS.READY
                }
              }
            );
          }
        } catch (extractErr) {
          console.warn('[Repository] Knowledge extraction notice:', extractErr.message);
        }
      }).catch(err => {
        console.warn('[Repository] AI Engine vector indexing notice:', err.message);
      });

      return res.json({
        success: true,
        message: 'Project created successfully. Codebase indexing has started.',
        repository: repoDoc
      });
    }

    return res.status(503).json({ error: 'Database disconnected' });
  } catch (err) {
    console.error('[Repository] Selection failed:', err.message);
    return res.status(500).json({ error: 'Failed to select repository', details: err.message });
  }
});

/**
 * Disconnect repository from a project
 * POST /api/v1/repositories/disconnect
 */
router.post('/disconnect', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ error: 'Valid projectId is required' });
  }

  const pid = new mongoose.Types.ObjectId(projectId);
  try {
    if (isDbConnected()) {
      await Repository.deleteOne({ projectId: pid });
      await Project.findByIdAndUpdate(pid, { repoUrl: null });
      return res.json({ success: true, message: 'Repository disconnected successfully.' });
    }
    return res.status(503).json({ error: 'Database disconnected' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Manually trigger reindexing for a repository
 * POST /api/v1/repositories/index
 */
router.post('/index', async (req, res) => {
  const { repoUrl, commitSha = 'HEAD', projectId } = req.body;
  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ error: 'Valid projectId is required' });
  }

  const pid = new mongoose.Types.ObjectId(projectId);

  try {
    if (isDbConnected()) {
      const repo = await Repository.findOne({ projectId: pid });
      if (!repo) {
        return res.status(404).json({ error: 'No repository connected to this project.' });
      }

      await Repository.updateOne(
        { projectId: pid },
        { $set: { status: REPOSITORY_STATUS.INDEXING, lastError: null } }
      );

      let userToken = repo.accessToken || null;
      const authHeader = req.headers.authorization;
      if (!userToken && authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const user = await User.findOne({ $or: [{ sessionToken: token }, { accessToken: token }] });
        if (user) userToken = user.accessToken;
      }

      triggerIndexing(repo.repoUrl, commitSha, pid, userToken).then(async () => {
        try {
          const knowledge = await extractRepositoryKnowledge(repo.repoUrl, { name: repo.name, fullName: repo.fullName });
          if (knowledge && knowledge.dependencyGraph?.nodes?.length > 0) {
            await Repository.updateOne(
              { projectId: pid },
              {
                $set: {
                  dependencyGraph: knowledge.dependencyGraph,
                  symbols: knowledge.symbols,
                  files: knowledge.files,
                  chunkCount: knowledge.chunkCount || repo.chunkCount,
                  status: REPOSITORY_STATUS.READY
                }
              }
            );
          }
        } catch (e) {}
      }).catch(err => {
        console.warn('[Repository] Reindex error:', err.message);
      });

      return res.json({
        success: true,
        message: `Codebase vector indexing initiated for ${repo.repoUrl} at ${commitSha}`
      });
    }

    return res.status(503).json({ error: 'Database disconnected' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Check indexing status for a project's repository
 * GET /api/v1/repositories/status?projectId=...
 */
router.get('/status', async (req, res) => {
  const { projectId } = req.query;

  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.json({ repository: null });
  }

  try {
    if (isDbConnected()) {
      const repo = await Repository.findOne({ projectId: new mongoose.Types.ObjectId(projectId) });
      return res.json({ repository: repo || null });
    }
    return res.json({ repository: null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to call AI Engine /index endpoint with auth token and project ID
 */
async function triggerIndexing(repoUrl, commitSha, projectId, userToken = null) {
  try {
    const res = await fetch(`${AI_ENGINE_URL}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo_url: repoUrl,
        commit_sha: commitSha,
        project_id: String(projectId),
        access_token: userToken
      })
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`[Repository] Indexing initiated on AI Engine for ${repoUrl}:`, data);
    } else {
      const errText = await res.text();
      console.warn(`[Repository] AI Engine index returned ${res.status}:`, errText);
      if (isDbConnected()) {
        await Repository.updateOne(
          { projectId },
          { $set: { status: REPOSITORY_STATUS.ERROR, lastError: `AI Engine error (${res.status}): ${errText}` } }
        );
      }
    }
  } catch (err) {
    console.warn(`[Repository] Could not connect to AI Engine at ${AI_ENGINE_URL}: ${err.message}.`);
    if (isDbConnected()) {
      await Repository.updateOne(
        { projectId },
        { $set: { status: REPOSITORY_STATUS.ERROR, lastError: `Connection error: ${err.message}` } }
      );
    }
  }
}
