import mongoose from 'mongoose';
import { extractRepositoryKnowledge } from '../services/repoKnowledgeService.js';
import { Repository, REPOSITORY_STATUS } from '../models/Repository.js';
import { Project } from '../models/Project.js';
import { User } from '../models/User.js';

async function syncDemoRepo() {
  await mongoose.connect('mongodb://localhost:27017/incident_manager');
  console.log('[Sync] Connected to MongoDB.');

  const demoProject = await Project.findOne({ name: 'demo-repo' });
  if (!demoProject) {
    console.error('[Sync] demo-repo project not found.');
    await mongoose.disconnect();
    return;
  }

  console.log(`[Sync] Found demo-repo project: ${demoProject._id}`);

  // Extract codebase knowledge
  const knowledge = await extractRepositoryKnowledge('demo-repo', {
    name: 'demo-repo',
    fullName: 'incivexa/demo-repo'
  });

  console.log(`[Sync] Knowledge extracted: ${knowledge.files?.length || 0} files, ${knowledge.symbols?.length || 0} symbols, ${knowledge.chunkCount || 0} chunks.`);

  // Upsert into repositories collection
  const repo = await Repository.findOneAndUpdate(
    { projectId: demoProject._id },
    {
      $set: {
        repoUrl: 'demo-repo',
        name: 'demo-repo',
        fullName: 'incivexa/demo-repo',
        defaultBranch: 'main',
        isPrivate: false,
        status: REPOSITORY_STATUS.READY,
        chunkCount: knowledge.chunkCount || 42,
        files: knowledge.files || [],
        symbols: knowledge.symbols || [],
        dependencyGraph: knowledge.dependencyGraph || null,
        localClonePath: 'demo-repo',
        lastIndexedCommit: '04b82778dd371d715dfd5e4e0a34c09377682dc6'
      }
    },
    { upsert: true, new: true }
  );

  console.log(`[Sync] Repository document updated with full codebase intelligence: ${repo._id}`);

  // Ensure demo user exists and is linked
  const user = await User.findOneAndUpdate(
    { email: 'incivexa-tester@gmail.com' },
    {
      $set: {
        username: 'IncivexaTester',
        displayName: 'IncivexaTester',
        email: 'incivexa-tester@gmail.com',
        role: 'Staff SRE & Incident Commander',
        company: 'Incivexa Engineering',
        avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=IncivexaTester',
        authMethod: 'local',
        selectedRepo: {
          name: 'demo-repo',
          fullName: 'incivexa/demo-repo',
          repoUrl: 'demo-repo',
          defaultBranch: 'main',
          status: 'READY',
          chunkCount: knowledge.chunkCount || 42
        }
      }
    },
    { upsert: true, new: true }
  );

  console.log(`[Sync] Demo user synchronized: ${user.username} (${user.email})`);

  // Link project to user
  await Project.updateOne(
    { _id: demoProject._id },
    { $set: { userId: user._id, repoUrl: 'demo-repo', defaultBranch: 'main' } }
  );

  console.log('[Sync] Demo project linked to IncivexaTester.');
  await mongoose.disconnect();
}

syncDemoRepo().catch(console.error);

