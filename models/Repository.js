import mongoose from 'mongoose';

export const REPOSITORY_STATUS = {
  READY: 'READY',
  CLONING: 'CLONING',
  INDEXING: 'INDEXING',
  ERROR: 'ERROR'
};

export const RepositorySchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  repoUrl: { type: String, required: true, index: true },
  name: { type: String, default: '' },
  fullName: { type: String, default: '' },
  localClonePath: { type: String, default: null },
  defaultBranch: { type: String, default: 'main' },
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

RepositorySchema.index({ projectId: 1, repoUrl: 1 }, { unique: true });

export const Repository = mongoose.models.Repository || mongoose.model('Repository', RepositorySchema);
