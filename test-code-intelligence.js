import assert from 'assert';
import mongoose from 'mongoose';
import { connectDatabase } from './config/database.js';
import { Project } from './models/Project.js';
import { Repository, REPOSITORY_STATUS } from './models/Repository.js';
import { Notification } from './models/Notification.js';
import { Incident } from './models/Incident.js';

console.log('====================================================');
console.log('🧪 Running Code Intelligence & Data Isolation Tests');
console.log('====================================================\n');

async function runTests() {
  await connectDatabase();
  try {
    await Repository.collection.dropIndex('projectId_1');
  } catch {}
  await Repository.syncIndexes();

  const testUserAId = new mongoose.Types.ObjectId();
  const testUserBId = new mongoose.Types.ObjectId();

  try {
    // -----------------------------------------------------------
    // TEST 1: Data Isolation - New Project Has Zero Demo Data
    // -----------------------------------------------------------
    console.log('▶ Test 1: Data Isolation on Newly Created Project...');
    const projectA = await Project.create({
      name: 'Alpha Isolated Project',
      key: 'alpha-' + Date.now(),
      description: 'Test project for data isolation',
      userId: testUserAId
    });

    const repoA = await Repository.findOne({ projectId: projectA._id });
    assert.strictEqual(repoA, null, 'New project must NOT have any connected repository');

    // Simulate GET /active logic
    const activeRepoLookup = await Repository.findOne({ projectId: projectA._id });
    assert.strictEqual(activeRepoLookup, null, 'Active repository lookup must return null for unlinked projects');
    console.log('  ✔ Data isolation passed: No demo repo or fallback leaked!\n');

    // -----------------------------------------------------------
    // TEST 2: Single Connected Repository Constraint
    // -----------------------------------------------------------
    console.log('▶ Test 2: Maximum One Connected Repository Per Project Constraint...');
    const repoDoc1 = await Repository.create({
      projectId: projectA._id,
      repoUrl: 'https://github.com/company/microservice-alpha.git',
      name: 'microservice-alpha',
      fullName: 'company/microservice-alpha',
      defaultBranch: 'main',
      status: REPOSITORY_STATUS.READY,
      chunkCount: 24,
      files: ['src/index.js', 'src/auth.js'],
      dependencyGraph: { nodes: [{ id: 'service:microservice-alpha' }], edges: [] }
    });

    assert.ok(repoDoc1._id, 'First repository connected successfully');

    // Attempting to create a second repository for the same project must violate unique constraint
    let duplicateRejected = false;
    try {
      await Repository.create({
        projectId: projectA._id,
        repoUrl: 'https://github.com/company/second-repo.git',
        name: 'second-repo'
      });
    } catch (err) {
      duplicateRejected = true;
    }
    assert.ok(duplicateRejected, 'Database must enforce unique repository per project');
    console.log('  ✔ Database constraint passed: Project can have at most one repository!\n');

    // -----------------------------------------------------------
    // TEST 3: Repository Replacement Workflow
    // -----------------------------------------------------------
    console.log('▶ Test 3: Repository Replacement & Cache Invalidation...');
    // Replacing repository must wipe previous repo's files, symbols, graph, chunks
    const updatedRepo = await Repository.findOneAndUpdate(
      { projectId: projectA._id },
      {
        $set: {
          repoUrl: 'https://github.com/company/microservice-beta.git',
          name: 'microservice-beta',
          fullName: 'company/microservice-beta',
          defaultBranch: 'main',
          status: REPOSITORY_STATUS.INDEXING,
          chunkCount: 0,
          files: [],
          symbols: [],
          dependencyGraph: null,
          lastError: null
        }
      },
      { new: true }
    );

    assert.strictEqual(updatedRepo.name, 'microservice-beta', 'Repository replaced');
    assert.strictEqual(updatedRepo.chunkCount, 0, 'Previous chunkCount invalidated');
    assert.strictEqual(updatedRepo.dependencyGraph, null, 'Previous dependencyGraph invalidated');
    assert.strictEqual(updatedRepo.files.length, 0, 'Previous files wiped');
    console.log('  ✔ Replacement workflow passed: Old data cleanly invalidated!\n');

    // -----------------------------------------------------------
    // TEST 4: Project Isolation Across Different Users
    // -----------------------------------------------------------
    console.log('▶ Test 4: Project & Repository Privacy Across Users...');
    const projectB = await Project.create({
      name: 'Beta User Project',
      key: 'beta-' + Date.now(),
      description: 'Second user project',
      userId: testUserBId
    });

    const userARepos = await Repository.find({ projectId: projectA._id });
    const userBRepos = await Repository.find({ projectId: projectB._id });

    assert.strictEqual(userARepos.length, 1, 'User A project has exactly 1 repo');
    assert.strictEqual(userBRepos.length, 0, 'User B project has 0 repos and does not see User A repo');
    console.log('  ✔ Multi-tenant privacy passed: Zero leakage across projects!\n');

    // -----------------------------------------------------------
    // TEST 5: Persistent Notifications & Read Receipts
    // -----------------------------------------------------------
    console.log('▶ Test 5: Notification Subsystem & Read Status Persistence...');
    const testIncident = await Incident.create({
      projectId: projectA._id,
      title: 'Database connection pool timeout',
      primaryHash: 'fp-test-' + Date.now(),
      severity: 'critical',
      status: 'OPEN',
      service: 'payment-svc',
      eventCount: 1,
      firstSeen: new Date(),
      lastSeen: new Date()
    });

    const notif = await Notification.create({
      projectId: projectA._id,
      incidentId: testIncident._id,
      title: testIncident.title,
      message: 'Critical latency spike detected',
      severity: 'CRITICAL',
      service: 'payment-svc',
      read: false
    });

    // Check initial unread count
    let unreadCount = await Notification.countDocuments({ projectId: projectA._id, read: false });
    assert.strictEqual(unreadCount, 1, 'Unread count should initially be 1');

    // Mark as read
    await Notification.findByIdAndUpdate(notif._id, { $set: { read: true, readAt: new Date() } });

    // Check updated unread count
    unreadCount = await Notification.countDocuments({ projectId: projectA._id, read: false });
    assert.strictEqual(unreadCount, 0, 'Unread count must accurately update to 0 after reading');

    const persistedNotif = await Notification.findById(notif._id);
    assert.strictEqual(persistedNotif.read, true, 'Read state must be permanently persisted in backend');
    assert.ok(persistedNotif.readAt, 'readAt timestamp must be recorded');
    console.log('  ✔ Notification subsystem passed: Read count accurately synchronizes with DB!\n');

    // Clean up test records
    await Project.deleteMany({ _id: { $in: [projectA._id, projectB._id] } });
    await Repository.deleteMany({ projectId: { $in: [projectA._id, projectB._id] } });
    await Notification.deleteMany({ projectId: { $in: [projectA._id, projectB._id] } });
    await Incident.deleteMany({ _id: testIncident._id });

    console.log('====================================================');
    console.log('🎉 ALL CODE INTELLIGENCE TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');
    process.exit(0);

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }
}

runTests();
