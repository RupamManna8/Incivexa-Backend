import { Router } from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Repository, REPOSITORY_STATUS } from '../models/Repository.js';
import { User } from '../models/User.js';
import { isDbConnected } from '../config/database.js';
import { extractRepositoryKnowledge } from '../services/repoKnowledgeService.js';

dotenv.config();

export const router = Router();

const HOST = process.env.HOST || 'localhost';
const AI_ENGINE_URL = process.env.AI_ENGINE_URL || process.env.INVESTIGATION_API_URL || `http://${HOST}:8000`;

// In-memory fallback
let inMemoryActiveRepo = {
  name: 'demo-payment-app',
  fullName: 'demo/demo-payment-app',
  repoUrl: './demo-repo',
  defaultBranch: 'main',
  status: REPOSITORY_STATUS.READY,
  indexedCommit: 'HEAD',
  chunkCount: 18,
  files: ['src/server.js', 'src/order_service.js', 'package.json']
};

/**
 * Get active/selected repository
 * GET /api/v1/repositories/active
 */
router.get('/active', async (req, res) => {
  const { projectId } = req.query;

  try {
    if (isDbConnected()) {
      let repo = null;
      if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
        repo = await Repository.findOne({ projectId: new mongoose.Types.ObjectId(projectId) }).sort({ updatedAt: -1 });
      }
      if (!repo) {
        repo = await Repository.findOne().sort({ updatedAt: -1 });
      }

      if (repo && !repo.dependencyGraph) {
        // Extract on-demand if not yet extracted
        const knowledge = await extractRepositoryKnowledge(repo.repoUrl, { name: repo.name, fullName: repo.fullName });
        repo.dependencyGraph = knowledge.dependencyGraph;
        repo.chunkCount = knowledge.chunkCount || repo.chunkCount;
        repo.files = knowledge.files || repo.files;
        repo.symbols = knowledge.symbols || repo.symbols;
        await repo.save();
      }

      return res.json({ repository: repo || null });
    }
    return res.json({ repository: inMemoryActiveRepo });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get repository knowledge & dependency graph
 * GET /api/v1/repositories/knowledge
 */
router.get('/knowledge', async (req, res) => {
  const { projectId, repoUrl } = req.query;

  try {
    let repo = null;
    if (isDbConnected()) {
      if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
        repo = await Repository.findOne({ projectId: new mongoose.Types.ObjectId(projectId) }).sort({ updatedAt: -1 });
      } else if (repoUrl) {
        repo = await Repository.findOne({ repoUrl }).sort({ updatedAt: -1 });
      }
      if (!repo) {
        repo = await Repository.findOne().sort({ updatedAt: -1 });
      }
    }

    const targetUrl = repo?.repoUrl || repoUrl || './demo-repo';
    const targetName = repo?.name || 'demo-payment-app';

    let knowledge = null;
    if (repo && repo.dependencyGraph && repo.symbols?.length > 0) {
      knowledge = {
        repoUrl: repo.repoUrl,
        name: repo.name || targetName,
        defaultBranch: repo.defaultBranch || 'main',
        files: repo.files || [],
        chunkCount: repo.chunkCount || 0,
        symbolsCount: repo.symbols?.length || 0,
        symbols: repo.symbols || [],
        dependencyGraph: repo.dependencyGraph
      };
    } else {
      knowledge = await extractRepositoryKnowledge(targetUrl, { name: targetName });
      if (isDbConnected() && repo) {
        repo.dependencyGraph = knowledge.dependencyGraph;
        repo.chunkCount = knowledge.chunkCount;
        repo.files = knowledge.files;
        repo.symbols = knowledge.symbols;
        await repo.save();
      }
    }

    return res.json({ success: true, knowledge });
  } catch (err) {
    console.error('[Repository] Knowledge extraction error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Select a repository for analysis, extract knowledge, and trigger codebase indexing
 * POST /api/v1/repositories/select
 */
router.post('/select', async (req, res) => {
  const { repoUrl, name, fullName, defaultBranch = 'main', isPrivate = false, projectId, commitSha = 'HEAD' } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required.' });
  }

  const effectiveProjectId = (projectId && mongoose.Types.ObjectId.isValid(projectId))
    ? new mongoose.Types.ObjectId(projectId)
    : new mongoose.Types.ObjectId('64f01234567890abcdef1234');

  try {
    // 1. Immediately extract knowledge, AST symbols, and dependency graph
    const knowledge = await extractRepositoryKnowledge(repoUrl, { name, fullName });

    let repoDoc = null;

    if (isDbConnected()) {
      repoDoc = await Repository.findOneAndUpdate(
        { projectId: effectiveProjectId, repoUrl },
        {
          $set: {
            name: name || knowledge.name || repoUrl.split('/').pop().replace('.git', ''),
            fullName: fullName || repoUrl,
            defaultBranch,
            status: REPOSITORY_STATUS.READY,
            lastIndexedCommit: commitSha,
            chunkCount: knowledge.chunkCount,
            files: knowledge.files,
            symbols: knowledge.symbols,
            dependencyGraph: knowledge.dependencyGraph,
            lastError: null
          },
          $addToSet: { indexedCommits: commitSha }
        },
        { upsert: true, new: true }
      );

      // Update active user's selectedRepo if session token is provided
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        await User.updateOne(
          { $or: [{ sessionToken: token }, { accessToken: token }] },
          {
            $set: {
              selectedRepo: {
                name: repoDoc.name,
                fullName: repoDoc.fullName,
                repoUrl: repoDoc.repoUrl,
                defaultBranch: repoDoc.defaultBranch,
                status: 'INDEXED',
                indexedCommit: commitSha,
                chunkCount: knowledge.chunkCount,
                lastIndexedAt: new Date()
              }
            }
          }
        );
      }
    } else {
      inMemoryActiveRepo = {
        name: name || knowledge.name || repoUrl.split('/').pop().replace('.git', ''),
        fullName: fullName || repoUrl,
        repoUrl,
        defaultBranch,
        status: REPOSITORY_STATUS.READY,
        indexedCommit: commitSha,
        chunkCount: knowledge.chunkCount,
        files: knowledge.files,
        symbols: knowledge.symbols,
        dependencyGraph: knowledge.dependencyGraph
      };
      repoDoc = inMemoryActiveRepo;
    }

    // Trigger Python AI Engine codebase vector indexing in background
    triggerIndexing(repoUrl, commitSha, effectiveProjectId).catch(err => {
      console.warn('[Repository] AI Engine vector indexing notice:', err.message);
    });

    return res.json({
      success: true,
      message: 'Repository linked, knowledge extracted, and dependency graph generated.',
      repository: repoDoc,
      knowledge
    });

  } catch (err) {
    console.error('[Repository] Selection failed:', err.message);
    return res.status(500).json({ error: 'Failed to select repository', details: err.message });
  }
});

/**
 * Manually trigger indexing for a repository
 * POST /api/v1/repositories/index
 */
router.post('/index', async (req, res) => {
  const { repoUrl, commitSha = 'HEAD', projectId } = req.body;
  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required' });
  }

  try {
    const effectiveProjectId = (projectId && mongoose.Types.ObjectId.isValid(projectId))
      ? new mongoose.Types.ObjectId(projectId)
      : new mongoose.Types.ObjectId('64f01234567890abcdef1234');

    if (isDbConnected()) {
      await Repository.updateOne(
        { projectId: effectiveProjectId, repoUrl },
        { $set: { status: REPOSITORY_STATUS.INDEXING } }
      );
    } else {
      inMemoryActiveRepo.status = REPOSITORY_STATUS.INDEXING;
    }

    triggerIndexing(repoUrl, commitSha, effectiveProjectId);

    return res.json({
      success: true,
      message: `Codebase vector indexing initiated for ${repoUrl} at ${commitSha}`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Check indexing status for a repository
 * GET /api/v1/repositories/status
 */
router.get('/status', async (req, res) => {
  const { repoUrl, projectId } = req.query;

  try {
    if (isDbConnected() && repoUrl && projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      const repo = await Repository.findOne({ projectId: new mongoose.Types.ObjectId(projectId), repoUrl });
      if (repo) return res.json({ repository: repo });
    }
    return res.json({ repository: inMemoryActiveRepo });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to call AI Engine /index endpoint
 */
async function triggerIndexing(repoUrl, commitSha, projectId) {
  try {
    const res = await fetch(`${AI_ENGINE_URL}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo_url: repoUrl,
        commit_sha: commitSha
      })
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`[Repository] Indexing initiated on AI Engine for ${repoUrl}:`, data);

      if (isDbConnected()) {
        await Repository.updateOne(
          { projectId, repoUrl },
          {
            $set: {
              status: REPOSITORY_STATUS.READY,
              lastIndexedCommit: commitSha,
              lastError: null
            },
            $addToSet: { indexedCommits: commitSha }
          }
        );
      } else {
        inMemoryActiveRepo.status = REPOSITORY_STATUS.READY;
        inMemoryActiveRepo.indexedCommit = commitSha;
      }
    } else {
      const errText = await res.text();
      console.warn(`[Repository] AI Engine index returned ${res.status}:`, errText);
    }
  } catch (err) {
    console.warn(`[Repository] Could not connect to AI Engine at ${AI_ENGINE_URL}: ${err.message}. Indexing will occur on demand during investigation.`);
  }
}
