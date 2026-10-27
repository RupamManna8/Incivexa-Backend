import { Router } from 'express';
import { User } from '../models/User.js';
import { isDbConnected } from '../config/database.js';

export const router = Router();

/**
 * Helper to resolve the user's authentic GitHub access token.
 * Supports direct GitHub tokens (PAT, gho_), Bearer session tokens, or query tokens.
 */
async function resolveGitHubToken(req) {
  let token = req.headers['x-github-token'] || req.query.token;
  const authHeader = req.headers.authorization;
  if (!token && authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }
  if (!token) return null;

  // Direct GitHub tokens (PAT or GitHub OAuth token)
  if (token.startsWith('ghp_') || token.startsWith('github_pat_') || token.startsWith('gho_')) {
    return token;
  }

  // Look up user from database by session token or token
  try {
    if (isDbConnected()) {
      const user = await User.findOne({
        $or: [
          { sessionToken: token },
          { accessToken: token }
        ]
      });
      if (user?.accessToken) {
        return user.accessToken;
      }
    }
  } catch (err) {
    console.warn('[GitHub] User token lookup notice:', err.message);
  }

  return token;
}

/**
 * List all repositories for the authenticated GitHub user
 * GET /api/v1/github/repos
 */
router.get('/repos', async (req, res) => {
  const token = await resolveGitHubToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: GitHub token or connected account required' });
  }

  // Handle local dev demo token
  if (token.startsWith('aim_gh_demo')) {
    return res.json({
      repositories: [
        {
          id: 101,
          name: 'payment-gateway',
          fullName: 'org/payment-gateway',
          owner: 'org',
          htmlUrl: 'https://github.com/org/payment-gateway',
          cloneUrl: 'https://github.com/org/payment-gateway.git',
          defaultBranch: 'main',
          isPrivate: false,
          description: 'Production payment gateway and checkout microservice',
          updatedAt: new Date().toISOString()
        },
        {
          id: 102,
          name: 'order-service',
          fullName: 'org/order-service',
          owner: 'org',
          htmlUrl: 'https://github.com/org/order-service',
          cloneUrl: 'https://github.com/org/order-service.git',
          defaultBranch: 'main',
          isPrivate: true,
          description: 'High-throughput transactional order execution engine',
          updatedAt: new Date().toISOString()
        }
      ],
      count: 2
    });
  }

  try {
    const response = await fetch('https://api.github.com/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Autonomous-Incident-Manager',
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'GitHub API error', details: errText });
    }

    const repos = await response.json();
    const formatted = repos.map(r => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      owner: r.owner?.login,
      htmlUrl: r.html_url,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch || 'main',
      isPrivate: Boolean(r.private),
      visibility: r.private ? 'private' : 'public',
      description: r.description || '',
      updatedAt: r.updated_at
    }));

    return res.json({ repositories: formatted, count: formatted.length });

  } catch (err) {
    console.error('[GitHub] Error fetching repositories:', err.message);
    return res.status(500).json({ error: 'Failed to fetch repositories from GitHub', details: err.message });
  }
});

/**
 * Get branches for a specific repository
 * GET /api/v1/github/repos/:owner/:repo/branches
 */
router.get('/repos/:owner/:repo/branches', async (req, res) => {
  const token = await resolveGitHubToken(req);
  const { owner, repo } = req.params;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: GitHub token required' });
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Autonomous-Incident-Manager',
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch branches' });
    }

    const branches = await response.json();
    return res.json({ branches: branches.map(b => ({ name: b.name, sha: b.commit?.sha })) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
