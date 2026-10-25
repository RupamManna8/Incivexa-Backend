import mongoose from 'mongoose';

export const INVESTIGATION_STATUS = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
};

export const CONFIDENCE_LEVEL = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE'
};

export const InvestigationSchema = new mongoose.Schema({
  incidentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, index: true },
  repoUrl: { type: String, required: true },
  commitSha: { type: String, required: true },
  status: {
    type: String,
    enum: Object.values(INVESTIGATION_STATUS),
    default: INVESTIGATION_STATUS.PENDING,
    index: true
  },
  targetLocation: {
    filePath: { type: String },
    functionName: { type: String },
    startLine: { type: Number },
    endLine: { type: Number }
  },
  executionTrace: [{
    file: { type: String },
    function: { type: String },
    line: { type: Number },
    snippet: { type: String }
  }],
  evidence: [{
    type: { type: String, enum: ['FACT', 'HYPOTHESIS'], required: true },
    description: { type: String, required: true },
    source: { type: String }
  }],
  rootCauseAnalysis: {
    summary: { type: String },
    mechanism: { type: String },
    contributingFactors: [{ type: String }]
  },
  confidence: {
    type: String,
    enum: Object.values(CONFIDENCE_LEVEL),
    default: CONFIDENCE_LEVEL.MEDIUM
  },
  confidenceScore: { type: Number, min: 0, max: 1, default: 0.5 },
  suggestedFix: {
    description: { type: String },
    diff: { type: String },
    affectedFiles: [{ type: String }]
  },
  relatedTests: [{ type: String }],
  error: { type: String, default: null },
  completedAt: { type: Date }
}, {
  timestamps: true
});

InvestigationSchema.index({ incidentId: 1, commitSha: 1 });

export const Investigation = mongoose.models.Investigation || mongoose.model('Investigation', InvestigationSchema);
