import mongoose from 'mongoose';

export const REPOSITORY_STATUS = {
  NOT_CONNECTED: 'NOT_CONNECTED',
  QUEUED: 'QUEUED',
  CLONING: 'CLONING',
  INDEXING: 'INDEXING',
  READY: 'READY',
  ERROR: 'ERROR'
};

export const RepositorySchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  repoUrl: { type: String, required: true },
  name: { type: String, default: '' },
  fullName: { type: String, default: '' },
  localClonePath: { type: String, default: null },
  defaultBranch: { type: String, default: 'main' },
  isPrivate: { type: Boolean, default: false },
  accessToken: { type: String, default: null },
  webhookId: { type: String, default: null },
  webhookSecret: { type: String, default: null },
  lastWebhookEventAt: { type: Date, default: null },
  latestCommit: { type: mongoose.Schema.Types.Mixed, default: null },
  lastIndexedCommit: { type: String, default: null },
  indexedCommits: [{ type: String }],
  chunkCount: { type: Number, default: 0 },
  files: [{ type: String }],
  symbols: [{ type: mongoose.Schema.Types.Mixed }],
  dependencyGraph: { type: mongoose.Schema.Types.Mixed, default: null },
  status: {
    type: String,
    enum: Object.values(REPOSITORY_STATUS),
    default: REPOSITORY_STATUS.READY
  },
  lastError: { type: String, default: null }
}, {
  timestamps: true
});

export const Repository = mongoose.models.Repository || mongoose.model('Repository', RepositorySchema);
