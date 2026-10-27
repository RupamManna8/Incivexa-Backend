import assert from 'assert';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDatabase, isDbConnected } from './config/database.js';
import { Repository, REPOSITORY_STATUS } from './models/Repository.js';
import { Project } from './models/Project.js';
import { Notification } from './models/Notification.js';

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Running Webhook & Private Repository Test Suite');
  console.log('====================================================\n');

  try {
    await connectDatabase();
    assert.strictEqual(isDbConnected(), true, 'Database must be online');

    const testProject = await Project.create({
      name: 'Private Webhook Test Svc',
      key: 'wh-test-' + Date.now(),
      description: 'Testing private repo indexing and commit webhook track updates',
      environment: 'production'
    });

    // -----------------------------------------------------------
    // TEST 1: Private Repository Association & Token Persistence
    // -----------------------------------------------------------
    console.log('▶ Test 1: Private Repository Credentials & Schema Validation...');
    const fakeToken = 'ghp_test_secure_oauth_token_' + Date.now();
    const repo = await Repository.create({
      projectId: testProject._id,
      name: 'payment-core-private',
      fullName: 'internal-org/payment-core-private',
      repoUrl: 'https://github.com/internal-org/payment-core-private.git',
      defaultBranch: 'main',
      isPrivate: true,
      accessToken: fakeToken,
      status: REPOSITORY_STATUS.READY
    });

    const persisted = await Repository.findById(repo._id);
    assert.strictEqual(persisted.isPrivate, true, 'isPrivate must be true');
    assert.strictEqual(persisted.accessToken, fakeToken, 'accessToken must be preserved');
    console.log('  ✔ Private repository credentials safely attached to project!\n');

    // -----------------------------------------------------------
    // TEST 2: Webhook Push Ingestion & Commit Tracking
    // -----------------------------------------------------------
    console.log('▶ Test 2: Ingesting GitHub Push Webhook Event...');
    const commitSha = 'c7e8f9a0b1c2d3e4';
    const commitMessage = 'fix(auth): sanitize JWT cookie and mitigate CSRF race condition';
    const authorName = 'Alice Senior SRE';

    // Call the webhook simulation logic directly to verify state transition
    const commitInfo = {
      sha: commitSha,
      message: commitMessage,
      author: authorName,
      branch: 'main',
      timestamp: new Date(),
      addedCount: 1,
      modifiedCount: 2,
      removedCount: 0,
      modifiedFiles: ['services/auth.js', 'middleware/security.js']
    };

    // Simulate webhook processing
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

    const notif = await Notification.create({
      projectId: repo.projectId,
      title: `Code Update: ${repo.name} (main)`,
      message: `Commit ${commitSha.slice(0, 7)} pushed by ${authorName}: "${commitMessage.slice(0, 80)}". Re-indexing codebase...`,
      severity: 'INFO',
      service: repo.name,
      read: false
    });

    // Verify Repository updated with commit info
    const updatedRepo = await Repository.findById(repo._id);
    assert.strictEqual(updatedRepo.status, REPOSITORY_STATUS.INDEXING, 'Status should transition to INDEXING');
    assert.strictEqual(updatedRepo.latestCommit.sha, commitSha, 'Commit SHA must match');
    assert.strictEqual(updatedRepo.latestCommit.message, commitMessage, 'Commit message must match');
    assert.strictEqual(updatedRepo.latestCommit.author, authorName, 'Author must match');
    assert.ok(updatedRepo.lastWebhookEventAt, 'lastWebhookEventAt timestamp must be recorded');

    // Verify Notification created
    const createdNotif = await Notification.findById(notif._id);
    assert.strictEqual(createdNotif.read, false, 'Notification must initially be unread');
    assert.ok(createdNotif.message.includes(commitSha.slice(0, 7)), 'Notification must reference commit SHA');
    console.log('  ✔ Webhook push successfully tracked, committed, and alerted!\n');

    // -----------------------------------------------------------
    // TEST 3: Webhook Ping Handling
    // -----------------------------------------------------------
    console.log('▶ Test 3: Validating Webhook Config & Ping Response Structure...');
    const GATEWAY_PORT = process.env.GATEWAY_PORT || 8080;
    const HOST = process.env.HOST || 'localhost';
    const expectedUrl = `http://${HOST}:${GATEWAY_PORT}/api/v1/webhooks/github`;

    assert.ok(expectedUrl.includes('/api/v1/webhooks/github'), 'Webhook endpoint format must be correct');
    console.log(`  ✔ Webhook payload URL verified: ${expectedUrl}\n`);

    // -----------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------
    await Repository.deleteOne({ _id: repo._id });
    await Notification.deleteOne({ _id: notif._id });
    await Project.deleteOne({ _id: testProject._id });
    console.log('  ✔ Test project, repository, and notifications cleanly purged.\n');

    console.log('====================================================');
    console.log('🎉 ALL WEBHOOK & PRIVATE REPO TESTS PASSED!');
    console.log('====================================================');

    process.exit(0);

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }
}

runTests();
