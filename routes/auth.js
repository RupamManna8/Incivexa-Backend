import { Router } from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { User } from '../models/User.js';
import { isDbConnected } from '../config/database.js';

dotenv.config();

export const router = Router();

// In-memory sessions store if Mongo is offline
const inMemoryUsers = new Map();
let currentInMemoryUser = null;

const HOST = process.env.HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8080;
const FRONTEND_URL = (process.env.FRONTEND_URL || `http://${HOST}:5173`).trim().replace(/\/+$/, '');

// Cryptographic helpers
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function generateToken() {
  return 'aim_sess_' + crypto.randomBytes(32).toString('hex');
}

function sanitizeUser(user) {
  if (!user) return null;
  const obj = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  delete obj.passwordHash;
  delete obj.salt;
  obj.githubConnected = Boolean(
    obj.accessToken && (
      obj.accessToken.startsWith('gh') ||
      obj.accessToken.startsWith('aim_gh_')
    )
  );
  return obj;
}

/**
 * Helper to fetch GitHub user details using token
 */
async function fetchGitHubProfile(token) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Autonomous-Incident-Manager',
      'Accept': 'application/vnd.github+json'
    }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub Authentication Failed (${response.status}): ${errText}`);
  }

  return response.json();
}

/**
 * Register with Email and Password
 * POST /api/v1/auth/register
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role = 'Incident Commander', company = '' } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid work email is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const displayName = (name && name.trim()) || normalizedEmail.split('@')[0];
    const username = normalizedEmail.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_');

    const salt = generateSalt();
    const passwordHash = hashPassword(password, salt);
    const sessionToken = generateToken();

    const userData = {
      email: normalizedEmail,
      username,
      displayName,
      role,
      company: company.trim(),
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`,
      passwordHash,
      salt,
      sessionToken,
      authMethod: 'local'
    };

    if (isDbConnected()) {
      const existing = await User.findOne({ email: normalizedEmail });
      if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      const user = await User.create(userData);
      return res.status(201).json({
        success: true,
        user: sanitizeUser(user),
        token: sessionToken,
        message: 'Account created successfully'
      });
    }

    // In-memory fallback
    if (inMemoryUsers.has(normalizedEmail)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const memUser = { ...userData, _id: 'mem_' + Date.now(), selectedRepo: null };
    inMemoryUsers.set(normalizedEmail, memUser);
    inMemoryUsers.set(sessionToken, memUser);
    currentInMemoryUser = memUser;

    return res.status(201).json({
      success: true,
      user: sanitizeUser(memUser),
      token: sessionToken,
      message: 'Account created successfully (local)'
    });
  } catch (err) {
    console.error('[Auth] Registration error:', err);
    return res.status(500).json({ error: 'Failed to create account.', details: err.message });
  }
});

/**
 * Sign In with Email and Password
 * POST /api/v1/auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (isDbConnected()) {
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials. User not found.' });
      }

      if (!user.passwordHash || !user.salt) {
        return res.status(400).json({
          error: 'This account was created via OAuth. Please sign in with GitHub or Google.'
        });
      }

      const inputHash = hashPassword(password, user.salt);
      if (inputHash !== user.passwordHash) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const sessionToken = generateToken();
      user.sessionToken = sessionToken;
      await user.save();

      return res.json({
        success: true,
        user: sanitizeUser(user),
        token: sessionToken,
        message: 'Signed in successfully'
      });
    }

    // In-memory fallback check
    const memUser = inMemoryUsers.get(normalizedEmail);
    if (!memUser) {
      return res.status(401).json({ error: 'Invalid credentials. User not found.' });
    }
    const inputHash = hashPassword(password, memUser.salt);
    if (inputHash !== memUser.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const sessionToken = generateToken();
    memUser.sessionToken = sessionToken;
    inMemoryUsers.set(sessionToken, memUser);
    currentInMemoryUser = memUser;

    return res.json({
      success: true,
      user: sanitizeUser(memUser),
      token: sessionToken,
      message: 'Signed in successfully'
    });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    return res.status(500).json({ error: 'Failed to sign in.', details: err.message });
  }
});

/**
 * Instant 1-Click SRE Demo Login
 * POST /api/v1/auth/demo
 */
router.post('/demo', async (req, res) => {
  try {
    const sessionToken = 'aim_demo_' + crypto.randomBytes(16).toString('hex');
    const demoData = {
      username: 'IncivexaTester',
      displayName: 'IncivexaTester',
      email: 'incivexa-tester@gmail.com',
      role: 'Staff SRE & Incident Commander',
      company: 'Incivexa Engineering',
      avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=IncivexaTester',
      sessionToken,
      authMethod: 'local',
      selectedRepo: {
        name: 'demo-repo',
        fullName: 'incivexa/demo-repo',
        repoUrl: 'demo-repo',
        defaultBranch: 'main',
        status: 'INDEXED',
        chunkCount: 42
      }
    };

    if (isDbConnected()) {
      let user = await User.findOne({ $or: [{ email: demoData.email }, { username: demoData.username }] });
      if (user) {
        user.sessionToken = sessionToken;
        user.displayName = demoData.displayName;
        user.username = demoData.username;
        user.email = demoData.email;
        user.role = demoData.role;
        user.company = demoData.company;
        user.avatarUrl = demoData.avatarUrl;
        user.selectedRepo = demoData.selectedRepo;
        await user.save();
      } else {
        user = await User.create(demoData);
      }

      // Link demo-repo project to this authentic user account
      const { Project } = await import('../models/Project.js');
      await Project.updateMany(
        { name: 'demo-repo' },
        { $set: { userId: user._id, repoUrl: 'demo-repo', defaultBranch: 'main' } }
      ).catch(() => {});

      return res.json({
        success: true,
        user: sanitizeUser(user),
        token: sessionToken,
        message: 'Connected as IncivexaTester (Lead SRE)'
      });
    }

    // In-memory
    const memUser = { ...demoData, _id: 'demo-user-id' };
    inMemoryUsers.set(sessionToken, memUser);
    inMemoryUsers.set(demoData.email, memUser);
    currentInMemoryUser = memUser;

    return res.json({
      success: true,
      user: sanitizeUser(memUser),
      token: sessionToken,
      message: 'Connected as Demo Operator'
    });
  } catch (err) {
    console.error('[Auth] Demo login error:', err);
    return res.status(500).json({ error: 'Failed to initialize demo session.' });
  }
});

/**
 * Google OAuth Initiator
 * GET /api/v1/auth/google
 */
router.get('/google', (req, res) => {
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();

  // If real Google Client ID is configured, redirect to Google Accounts
  if (googleClientId && googleClientId !== 'your_google_client_id') {
    const rawRedirect = process.env.GOOGLE_REDIRECT_URI?.trim() || `http://${HOST}:${GATEWAY_PORT}/api/v1/auth/google/callback`;
    const redirectUri = encodeURIComponent(rawRedirect);
    const scope = encodeURIComponent('openid email profile');
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleClientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`);
  }

  // Seamless developer fallback: create instant verified Google SRE profile and redirect to dashboard
  const googleToken = 'aim_google_' + crypto.randomBytes(24).toString('hex');
  const googleProfile = {
    username: 'marcus_chen_sre',
    displayName: 'Marcus Chen',
    email: 'marcus.chen@googlemail.com',
    role: 'Infrastructure Architect & SRE Lead',
    company: 'Enterprise Core Services',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    sessionToken: googleToken,
    accessToken: googleToken,
    authMethod: 'google',
    selectedRepo: {
      name: 'production-fleet',
      fullName: 'org/production-fleet',
      repoUrl: 'https://github.com/org/production-fleet',
      defaultBranch: 'main',
      status: 'INDEXED',
      chunkCount: 289
    }
  };

  if (isDbConnected()) {
    User.findOneAndUpdate(
      { email: googleProfile.email },
      { $set: googleProfile },
      { upsert: true, new: true }
    ).catch(e => console.error('[Auth] Google upsert error:', e));
  } else {
    inMemoryUsers.set(googleToken, googleProfile);
    currentInMemoryUser = googleProfile;
  }

  console.log('[Auth] Google OAuth: Redirecting with session token');
  return res.redirect(`${FRONTEND_URL}/#token=${googleToken}&auth=google`);
});

/**
 * Google OAuth Callback
 * GET /api/v1/auth/google/callback
 */
router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || `http://${HOST}:${GATEWAY_PORT}/api/v1/auth/google/callback`;

  if (!code || !clientId || !clientSecret) {
    const fallbackToken = 'aim_google_' + crypto.randomBytes(24).toString('hex');
    return res.redirect(`${FRONTEND_URL}/#token=${fallbackToken}&auth=google`);
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || 'Failed to exchange Google OAuth code');
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();

    const sessionToken = 'aim_google_' + crypto.randomBytes(24).toString('hex');
    const userData = {
      email: profile.email,
      username: profile.email.split('@')[0],
      displayName: profile.name || profile.email.split('@')[0],
      avatarUrl: profile.picture,
      role: 'SRE Operator',
      sessionToken,
      accessToken: tokenData.access_token,
      authMethod: 'google'
    };

    if (isDbConnected()) {
      await User.findOneAndUpdate(
        { email: profile.email },
        { $set: userData },
        { upsert: true, new: true }
      );
    } else {
      inMemoryUsers.set(sessionToken, userData);
      currentInMemoryUser = userData;
    }

    return res.redirect(`${FRONTEND_URL}/#token=${sessionToken}&auth=google`);
  } catch (err) {
    console.error('[Auth] Google OAuth Error:', err);
    return res.redirect(`${FRONTEND_URL}/#error=${encodeURIComponent(err.message)}`);
  }
});

/**
 * Authenticate via GitHub Personal Access Token (PAT)
 * POST /api/v1/auth/token
 */
router.post('/token', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'GitHub Personal Access Token is required.' });
  }

  try {
    const ghUser = await fetchGitHubProfile(token);
    const sessionToken = 'aim_gh_' + crypto.randomBytes(24).toString('hex');

    const userData = {
      githubId: String(ghUser.id),
      username: ghUser.login,
      displayName: ghUser.name || ghUser.login,
      avatarUrl: ghUser.avatar_url,
      email: ghUser.email || `${ghUser.login}@users.noreply.github.com`,
      accessToken: token,
      sessionToken,
      role: 'Principal SRE',
      authMethod: 'token'
    };

    if (isDbConnected()) {
      let user = await User.findOne({ githubId: String(ghUser.id) });
      if (user) {
        user.accessToken = token;
        user.sessionToken = sessionToken;
        user.username = ghUser.login;
        user.displayName = ghUser.name || ghUser.login;
        user.avatarUrl = ghUser.avatar_url;
        await user.save();
      } else {
        user = await User.create(userData);
      }
      return res.json({ success: true, user: sanitizeUser(user), token: sessionToken });
    }

    // In-memory fallback
    const memUser = { ...userData, _id: 'mock-user-id', selectedRepo: null };
    inMemoryUsers.set(sessionToken, memUser);
    inMemoryUsers.set(token, memUser);
    currentInMemoryUser = memUser;
    return res.json({ success: true, user: sanitizeUser(memUser), token: sessionToken });

  } catch (err) {
    console.error('[Auth] Token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid GitHub Token', details: err.message });
  }
});

/**
 * Get current authenticated user profile (via session token or GitHub token)
 * GET /api/v1/auth/me
 */
router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;

  if (!token) {
    if (currentInMemoryUser) return res.json({ user: sanitizeUser(currentInMemoryUser) });
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    // 1. Check MongoDB for sessionToken or accessToken
    if (isDbConnected()) {
      const user = await User.findOne({
        $or: [
          { sessionToken: token },
          { accessToken: token }
        ]
      });
      if (user) return res.json({ user: sanitizeUser(user) });
    }

    // 2. Check in-memory session store
    if (inMemoryUsers.has(token)) {
      return res.json({ user: sanitizeUser(inMemoryUsers.get(token)) });
    }

    if (currentInMemoryUser && (currentInMemoryUser.sessionToken === token || currentInMemoryUser.accessToken === token)) {
      return res.json({ user: sanitizeUser(currentInMemoryUser) });
    }

    // 3. Fallback: if token looks like GitHub PAT (starts with ghp_ or github_pat_), verify with GitHub
    if (token.startsWith('ghp_') || token.startsWith('github_pat_')) {
      const ghUser = await fetchGitHubProfile(token);
      const user = {
        githubId: String(ghUser.id),
        username: ghUser.login,
        displayName: ghUser.name || ghUser.login,
        avatarUrl: ghUser.avatar_url,
        email: ghUser.email || '',
        role: 'Site Reliability Engineer',
        authMethod: 'token',
        selectedRepo: currentInMemoryUser?.selectedRepo || null
      };
      return res.json({ user });
    }

    return res.status(401).json({ error: 'Session expired or invalid token' });
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid', details: err.message });
  }
});

/**
 * Check OAuth configuration status
 * GET /api/v1/auth/config
 */
router.get('/config', (req, res) => {
  const ghClientId = process.env.GITHUB_CLIENT_ID?.trim();
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();

  return res.json({
    githubConfigured: Boolean(ghClientId && ghClientId !== 'your_github_client_id'),
    googleConfigured: Boolean(googleClientId && googleClientId !== 'your_google_client_id'),
    githubClientId: ghClientId || null,
    googleClientId: googleClientId || null
  });
});

/**
 * GitHub OAuth URL generator
 * GET /api/v1/auth/github
 */
router.get('/github', (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const sessionToken = req.query.sessionToken || '';

  if (!clientId || clientId === 'your_github_client_id') {
    // Dev fallback for smooth local testing
    const devToken = 'aim_gh_demo_' + crypto.randomBytes(16).toString('hex');
    const ghDevUser = {
      username: 'sarah_connor_devops',
      displayName: 'Sarah Connor',
      email: 's.connor@cyberdyne-ops.io',
      role: 'Principal DevOps Architect',
      company: 'Cyberdyne Systems Infrastructure',
      avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80',
      sessionToken: sessionToken || devToken,
      accessToken: devToken,
      authMethod: 'oauth',
      selectedRepo: null
    };

    if (isDbConnected()) {
      User.findOneAndUpdate(
        { email: ghDevUser.email },
        { $set: ghDevUser },
        { upsert: true, new: true }
      ).catch(() => {});
    } else {
      inMemoryUsers.set(ghDevUser.sessionToken, ghDevUser);
      currentInMemoryUser = ghDevUser;
    }

    return res.redirect(`${FRONTEND_URL}/#token=${ghDevUser.sessionToken}&auth=github`);
  }

  const rawRedirect = process.env.GITHUB_REDIRECT_URI?.trim() || `http://${HOST}:${GATEWAY_PORT}/api/v1/auth/github/callback`;
  const redirectUri = encodeURIComponent(rawRedirect);
  const scope = encodeURIComponent('repo,read:user,user:email');
  const stateParam = sessionToken ? `&state=${encodeURIComponent(sessionToken)}` : '';
  return res.redirect(`https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}${stateParam}`);
});

/**
 * GitHub OAuth Callback
 * GET /api/v1/auth/github/callback
 */
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();

  if (!code || !clientId || !clientSecret) {
    return res.status(400).send('Missing OAuth configuration or authorization code.');
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code
      })
    });

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      throw new Error(tokenData.error_description || 'Failed to obtain access token');
    }

    const ghUser = await fetchGitHubProfile(accessToken);
    const sessionToken = state || ('aim_gh_' + crypto.randomBytes(24).toString('hex'));

    const userData = {
      githubId: String(ghUser.id),
      username: ghUser.login,
      displayName: ghUser.name || ghUser.login,
      avatarUrl: ghUser.avatar_url,
      email: ghUser.email || `${ghUser.login}@users.noreply.github.com`,
      accessToken,
      sessionToken,
      role: 'Principal SRE',
      authMethod: 'oauth'
    };

    if (isDbConnected()) {
      if (state) {
        // Link GitHub token to the existing active session
        await User.findOneAndUpdate(
          { $or: [{ sessionToken: state }, { accessToken: state }] },
          {
            $set: {
              accessToken,
              githubId: String(ghUser.id),
              avatarUrl: ghUser.avatar_url,
              displayName: ghUser.name || ghUser.login,
              username: ghUser.login
            }
          }
        );
      } else {
        await User.findOneAndUpdate(
          { githubId: String(ghUser.id) },
          { $set: userData },
          { upsert: true, new: true }
        );
      }
    } else {
      inMemoryUsers.set(sessionToken, userData);
      inMemoryUsers.set(accessToken, userData);
      currentInMemoryUser = { ...userData, _id: 'mock-oauth-user', selectedRepo: null };
    }

    console.log(`[Auth] User @${ghUser.login} authenticated via GitHub OAuth.`);
    return res.redirect(`${FRONTEND_URL}/#token=${sessionToken}&auth=github_connected`);
  } catch (err) {
    console.error('[Auth] OAuth Callback Error:', err);
    return res.status(500).send(`Authentication error: ${err.message}`);
  }
});

/**
 * Connect GitHub PAT to existing user session
 * POST /api/v1/auth/github/connect
 */
router.post('/github/connect', async (req, res) => {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'GitHub Personal Access Token is required.' });
  }

  try {
    const ghUser = await fetchGitHubProfile(token);

    if (isDbConnected()) {
      let user = null;
      if (sessionToken) {
        user = await User.findOne({
          $or: [{ sessionToken }, { accessToken: sessionToken }]
        });
      }

      if (user) {
        user.accessToken = token;
        user.githubId = String(ghUser.id);
        user.username = ghUser.login;
        if (!user.avatarUrl) user.avatarUrl = ghUser.avatar_url;
        await user.save();
        return res.json({ success: true, user: sanitizeUser(user), message: 'GitHub connected successfully' });
      }

      // If user wasn't found by sessionToken, update by githubId or create
      user = await User.findOneAndUpdate(
        { githubId: String(ghUser.id) },
        {
          $set: {
            accessToken: token,
            githubId: String(ghUser.id),
            username: ghUser.login,
            displayName: ghUser.name || ghUser.login,
            avatarUrl: ghUser.avatar_url,
            email: ghUser.email || `${ghUser.login}@users.noreply.github.com`,
            authMethod: 'token'
          }
        },
        { upsert: true, new: true }
      );
      return res.json({ success: true, user: sanitizeUser(user), message: 'GitHub connected successfully' });
    }

    if (currentInMemoryUser) {
      currentInMemoryUser.accessToken = token;
      currentInMemoryUser.githubId = String(ghUser.id);
      currentInMemoryUser.username = ghUser.login;
      return res.json({ success: true, user: sanitizeUser(currentInMemoryUser), message: 'GitHub connected successfully' });
    }

    return res.status(400).json({ error: 'Unable to link GitHub credentials' });
  } catch (err) {
    console.error('[Auth] GitHub Connect error:', err.message);
    return res.status(400).json({ error: 'Invalid GitHub token: ' + err.message });
  }
});

/**
 * Disconnect GitHub from existing session
 * POST /api/v1/auth/github/disconnect
 */
router.post('/github/disconnect', async (req, res) => {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (isDbConnected() && sessionToken) {
    const user = await User.findOneAndUpdate(
      { $or: [{ sessionToken }, { accessToken: sessionToken }] },
      { $unset: { accessToken: 1, selectedRepo: 1 } },
      { new: true }
    );
    return res.json({ success: true, user: sanitizeUser(user), message: 'GitHub disconnected' });
  }

  if (currentInMemoryUser) {
    delete currentInMemoryUser.accessToken;
    delete currentInMemoryUser.selectedRepo;
    return res.json({ success: true, user: sanitizeUser(currentInMemoryUser), message: 'GitHub disconnected' });
  }

  return res.json({ success: true, message: 'GitHub disconnected' });
});

/**
 * Logout
 * POST /api/v1/auth/logout
 */
router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.body.token;

  if (token) {
    inMemoryUsers.delete(token);
    if (isDbConnected()) {
      try {
        await User.updateOne({ sessionToken: token }, { $unset: { sessionToken: 1 } });
      } catch (_) {}
    }
  }

  currentInMemoryUser = null;
  return res.json({ success: true, message: 'Logged out successfully' });
});
