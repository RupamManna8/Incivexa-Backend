import mongoose from 'mongoose';

export const UserSchema = new mongoose.Schema({
  githubId: { type: String, sparse: true, index: true },
  username: { type: String, sparse: true },
  displayName: { type: String },
  avatarUrl: { type: String },
  accessToken: { type: String },
  sessionToken: { type: String, sparse: true, index: true },
  email: { type: String, sparse: true, index: true },
  passwordHash: { type: String },
  salt: { type: String },
  role: { type: String, default: 'Incident Commander' },
  company: { type: String },
  authMethod: { type: String, enum: ['oauth', 'token', 'local', 'google'], default: 'local' },
  selectedRepo: {
    name: { type: String },
    fullName: { type: String },
    repoUrl: { type: String },
    defaultBranch: { type: String, default: 'main' },
    isPrivate: { type: Boolean, default: false },
    status: { type: String, enum: ['READY', 'INDEXING', 'INDEXED', 'ERROR'], default: 'READY' },
    indexedCommit: { type: String },
    chunkCount: { type: Number, default: 0 },
    lastIndexedAt: { type: Date }
  }
}, {
  timestamps: true
});

export const User = mongoose.models.User || mongoose.model('User', UserSchema);
