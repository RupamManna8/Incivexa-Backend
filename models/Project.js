import mongoose from 'mongoose';

const ProjectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  key: { type: String, required: true, index: true },
  description: { type: String, default: '' },
  repoUrl: { type: String, default: null },
  defaultBranch: { type: String, default: 'main' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  settings: {
    rateLimitPerSec: { type: Number, default: 200 },
    retentionDays: { type: Number, default: 30 }
  },
  createdAt: { type: Date, default: Date.now }
});

ProjectSchema.index({ key: 1 }, { unique: true });

export const Project = mongoose.models.Project || mongoose.model('Project', ProjectSchema);
