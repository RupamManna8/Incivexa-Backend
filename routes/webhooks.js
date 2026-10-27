import { Router } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { Repository, REPOSITORY_STATUS } from '../models/Repository.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { isDbConnected } from '../config/database.js';
import { extractRepositoryKnowledge } from '../services/repoKnowledgeService.js';

dotenv.config();

export const router = Router();

const HOST = process.env.HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8080;
const AI_ENGINE_URL = process.env.AI_ENGINE_URL || (process.env.INVESTIGATION_API_URL?.includes(':8001') ? `http://${HOST}:8000` : (process.env.INVESTIGATION_API_URL || `http://${HOST}:8000`));
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'aim_whsec_' + crypto.createHash('sha256').update(process.env.JWT_SECRET || 'incivexa_key').digest('hex').slice(0, 16);

function getWebhookUrl() {
  const base = process.env.PUBLIC_WEBHOOK_URL || process.env.FRONTEND_URL?.replace(/:\d+$/, `:${GATEWAY_PORT}`) || `http://${HOST}:${GATEWAY_PORT}`;
  return `${base.replace(/\/+$/, '')}/api/v1/webhooks/github`;
}

/**
 * Verify GitHub HMAC SHA-256 signature
 */
function verifySignature(req, secret) {
  const signature = req.headers['x-hub-signature-256'];
  if (!secret) return true; // If no secret configured, bypass check
  if (!signature) return false;

  try {
    const payload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch (err) {
    return false;
  }
}

/**
 * Main GitHub Webhook Ingest Endpoint
 * POST /api/v1/webhooks/github
 */
router.post('/github', async (req, res) => {
  const event = req.headers['x-github-event'] || req.headers['x-event-key'] || 'push';
  const delivery = req.headers['x-github-delivery'] || ('deliv_' + Date.now());

  console.log(`[Webhook] Incoming GitHub event: ${event} (Delivery: ${delivery})`);

  // Handle GitHub Ping
  if (event === 'ping') {
    const zen = req.body?.zen || 'Non-blocking incident intelligence.';
    const hookId = req.body?.hook_id;
    console.log(`[Webhook] Ping received: ${zen}`);
    return res.status(200).json({
      status: 'PONG',
      message: 'GitHub Webhook successfully connected & validated.',
      zen,
      hookId
    });
  }

  // Handle push / commit update events
  if (event === 'push') {
    const repoInfo = req.body.repository;
    if (!repoInfo) {
      return res.status(400).json({ error: 'Missing repository in webhook payload' });
    }

    const repoFullName = repoInfo.full_name || '';
    const repoName = repoInfo.name || '';
    const ref = req.body.ref || 'refs/heads/main';
    const branch = ref.replace('refs/heads/', '');
    const after = req.body.after || (req.body.head_commit && req.body.head_commit.id);
    const headCommit = req.body.head_commit || (req.body.commits && req.body.commits[req.body.commits.length - 1]);
    const pusher = req.body.pusher || req.body.sender || {};

    if (!isDbConnected()) {
      return res.status(503).json({ error: 'Database disconnected' });
    }

    // Find all matching repositories across projects
    const filter = {
      $or: [
        { fullName: repoFullName },
        { name: repoName }
      ]
    };
    if (repoFullName) {
      filter.$or.push({ repoUrl: { $regex: new RegExp(repoFullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } });
    }

    const repos = await Repository.find(filter);

    if (!repos.length) {
      console.log(`[Webhook] Push received for ${repoFullName || repoName}, but no matching connected project was found.`);
      return res.status(200).json({
        status: 'IGNORED',
        message: 'No project currently associated with this repository.'
      });
    }

    const commitInfo = {
      sha: after || ('commit_' + Date.now().toString(16)),
      message: headCommit?.message || 'Codebase update pushed to remote',
      author: headCommit?.author?.name || pusher?.name || 'Developer',
      branch,
      timestamp: headCommit?.timestamp ? new Date(headCommit.timestamp) : new Date(),
      addedCount: headCommit?.added?.length || 0,
      modifiedCount: headCommit?.modified?.length || 0,
      removedCount: headCommit?.removed?.length || 0,
      modifiedFiles: (headCommit?.modified || []).slice(0, 15)
    };

    console.log(`[Webhook] Processing push on ${repoFullName} [${branch}] commit: ${commitInfo.sha.slice(0, 7)} by ${commitInfo.author}`);

    // Update each matched project repository
    for (const repo of repos) {
      try {
        // 1. Update Repository tracking status and latestCommit
        await Repository.updateOne(
          { _id: repo._id },
          {
            $set: {
              latestCommit: commitInfo,
              lastWebhookEventAt: new Date(),
              status: REPOSITORY_STATUS.INDEXING
            }
          }
        );

        // 2. Add Persistent Notification
        await Notification.create({
          projectId: repo.projectId,
          title: `Code Update: ${repo.name} (${branch})`,
          message: `Commit ${commitInfo.sha.slice(0, 7)} pushed by ${commitInfo.author}: "${commitInfo.message.slice(0, 80)}". Re-indexing codebase...`,
          severity: 'INFO',
          service: repo.name,
          read: false
        });

        // 3. Asynchronously trigger AI Engine indexing
        const tokenToUse = repo.accessToken;
        fetch(`${AI_ENGINE_URL}/index`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo_url: repo.repoUrl,
            commit_sha: commitInfo.sha,
            project_id: String(repo.projectId),
            access_token: tokenToUse
          })
        }).then(async () => {
          // Re-extract knowledge and update dependency graph
          try {
            const knowledge = await extractRepositoryKnowledge(repo.repoUrl, { name: repo.name, fullName: repo.fullName });
            if (knowledge && knowledge.dependencyGraph?.nodes?.length > 0) {
              await Repository.updateOne(
                { _id: repo._id },
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
          } catch (kErr) {
            console.warn('[Webhook] Knowledge extraction notice:', kErr.message);
          }
        }).catch(idxErr => {
          console.warn('[Webhook] Vector indexing trigger notice:', idxErr.message);
        });

      } catch (repoErr) {
        console.error(`[Webhook] Error updating repo ${repo._id}:`, repoErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      status: 'PROCESSED',
      event: 'push',
      commit: commitInfo.sha,
      affectedProjects: repos.length
    });
  }

  // Handle Release Event
  if (event === 'release') {
    const repoInfo = req.body.repository;
    const release = req.body.release;
    console.log(`[Webhook] Release event received for ${repoInfo?.full_name}: ${release?.tag_name || release?.name}`);
    return res.status(200).json({ status: 'PROCESSED', event: 'release', tag: release?.tag_name });
  }

  return res.status(200).json({ status: 'ACKNOWLEDGED', event });
});

/**
 * Webhook Configuration Details for Project
 * GET /api/v1/webhooks/config?projectId=...
 */
router.get('/config', async (req, res) => {
  const { projectId } = req.query;
  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ error: 'Valid projectId is required.' });
  }

  try {
    let repo = null;
    if (isDbConnected()) {
      repo = await Repository.findOne({ projectId: new mongoose.Types.ObjectId(projectId) });
    }

    const secret = repo?.webhookSecret || GITHUB_WEBHOOK_SECRET;
    const webhookUrl = getWebhookUrl();

    return res.json({
      success: true,
      webhookUrl,
      secret,
      contentType: 'application/json',
      events: ['push', 'release'],
      isConfigured: Boolean(repo?.webhookId || repo?.lastWebhookEventAt),
      webhookId: repo?.webhookId || null,
      lastWebhookEventAt: repo?.lastWebhookEventAt || null,
      latestCommit: repo?.latestCommit || null,
      isPrivate: repo?.isPrivate || false
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Auto-Register Webhook on GitHub Repository
 * POST /api/v1/webhooks/register
 */
router.post('/register', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ error: 'Valid projectId is required.' });
  }

  const pid = new mongoose.Types.ObjectId(projectId);

  try {
    if (!isDbConnected()) {
      return res.status(503).json({ error: 'Database disconnected' });
    }

    const repo = await Repository.findOne({ projectId: pid });
    if (!repo) {
      return res.status(404).json({ error: 'No repository connected to this project.' });
    }

    // Resolve GitHub Token
    let token = repo.accessToken;
    const authHeader = req.headers.authorization;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      const user = await User.findOne({ $or: [{ sessionToken: authHeader.slice(7) }, { accessToken: authHeader.slice(7) }] });
      token = user?.accessToken;
    }

    if (!token) {
      return res.status(401).json({ error: 'GitHub authentication or Personal Access Token with repo scope is required to register webhooks.' });
    }

    // Determine owner and repo name from fullName or repoUrl
    let fullName = repo.fullName;
    if (!fullName || !fullName.includes('/')) {
      const parts = repo.repoUrl.replace(/\.git$/, '').split('/');
      fullName = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }

    const webhookUrl = getWebhookUrl();
    const webhookSecret = repo.webhookSecret || GITHUB_WEBHOOK_SECRET;

    console.log(`[Webhook] Registering webhook for ${fullName} at ${webhookUrl}...`);

    const ghResponse = await fetch(`https://api.github.com/repos/${fullName}/hooks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Autonomous-Incident-Manager',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push', 'release'],
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: webhookSecret,
          insecure_ssl: '0'
        }
      })
    });

    const data = await ghResponse.json();

    if (!ghResponse.ok) {
      // Check if hook already exists
      if (data.errors && JSON.stringify(data.errors).includes('already exists')) {
        await Repository.updateOne(
          { _id: repo._id },
          { $set: { webhookSecret, lastWebhookEventAt: repo.lastWebhookEventAt || new Date() } }
        );
        return res.json({
          success: true,
          message: 'Webhook was already registered on this GitHub repository and is active.',
          webhookUrl,
          alreadyExisted: true
        });
      }
      return res.status(ghResponse.status).json({
        error: 'GitHub API rejected webhook registration',
        details: data.message || data
      });
    }

    await Repository.updateOne(
      { _id: repo._id },
      { $set: { webhookId: String(data.id), webhookSecret } }
    );

    return res.json({
      success: true,
      message: 'GitHub Webhook successfully registered! Pushes will automatically trigger AST re-indexing and commit tracking.',
      webhookId: data.id,
      webhookUrl
    });

  } catch (err) {
    console.error('[Webhook] Auto-register error:', err.message);
    return res.status(500).json({ error: 'Failed to auto-register webhook', details: err.message });
  }
});

/**
 * Simulate a Git Push Webhook Event
 * POST /api/v1/webhooks/simulate
 * Enables immediate local and automated validation of push tracking & auto-indexing.
 */
router.post('/simulate', async (req, res) => {
  const {
    projectId,
    commitSha = 'sim_' + crypto.randomBytes(6).toString('hex'),
    commitMessage = 'Refactor checkout retry loop and connection timeout handling',
    author = 'DevOps Engineer',
    branch = 'main',
    modifiedFiles = ['services/checkout.js', 'config/database.js']
  } = req.body;

  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ error: 'Valid projectId is required.' });
  }

  const pid = new mongoose.Types.ObjectId(projectId);

  try {
    if (!isDbConnected()) {
      return res.status(503).json({ error: 'Database disconnected' });
    }

    const repo = await Repository.findOne({ projectId: pid });
    if (!repo) {
      return res.status(404).json({ error: 'No repository connected to this project.' });
    }

    const simulatedPayload = {
      ref: `refs/heads/${branch}`,
      after: commitSha,
      repository: {
        name: repo.name,
        full_name: repo.fullName || repo.name,
        clone_url: repo.repoUrl,
        html_url: repo.repoUrl.replace(/\.git$/, '')
      },
      head_commit: {
        id: commitSha,
        message: commitMessage,
        author: { name: author, email: `${author.toLowerCase().replace(/\s+/g, '.')}@incivexa.internal` },
        timestamp: new Date().toISOString(),
        modified: modifiedFiles,
        added: [],
        removed: []
      },
      pusher: { name: author }
    };

    // Forward through local webhook handler
    const commitInfo = {
      sha: commitSha,
      message: commitMessage,
      author,
      branch,
      timestamp: new Date(),
      addedCount: 0,
      modifiedCount: modifiedFiles.length,
      removedCount: 0,
      modifiedFiles
    };

    // 1. Update Repository
    await Repository.updateOne(
      { _id: repo._id },
      {
        $set: {
          latestCommit: commitInfo,
          lastWebhookEventAt: new Date(),
          status: REPOSITORY_STATUS.INDEXING
        }
      }
    );

    // 2. Add Notification
    const notif = await Notification.create({
      projectId: repo.projectId,
      title: `Git Push: ${repo.name} (${branch})`,
      message: `Commit ${commitSha.slice(0, 7)} pushed by ${author}: "${commitMessage.slice(0, 80)}". Re-indexing codebase...`,
      severity: 'INFO',
      service: repo.name,
      read: false
    });

    // 3. Trigger AI Engine
    fetch(`${AI_ENGINE_URL}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo_url: repo.repoUrl,
        commit_sha: commitSha,
        project_id: String(repo.projectId),
        access_token: repo.accessToken
      })
    }).then(async () => {
      try {
        const knowledge = await extractRepositoryKnowledge(repo.repoUrl, { name: repo.name, fullName: repo.fullName });
        if (knowledge && knowledge.dependencyGraph?.nodes?.length > 0) {
          await Repository.updateOne(
            { _id: repo._id },
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
      } catch (kErr) {}
    }).catch(() => {});

    return res.json({
      success: true,
      message: 'Simulated Git push event processed successfully! Code intelligence re-indexing initiated.',
      commit: commitInfo,
      notification: notif
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
