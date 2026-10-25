import mongoose from 'mongoose';

export const INCIDENT_STATUS = {
  OPEN: 'OPEN',
  TRIAGING: 'TRIAGING',
  INVESTIGATING: 'INVESTIGATING',
  DIAGNOSED: 'DIAGNOSED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  REMEDIATING: 'REMEDIATING',
  RESOLVED: 'RESOLVED',
  ESCALATED: 'ESCALATED'
};

export const INCIDENT_SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

const TimelineEntrySchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  action: { type: String, required: true },
  actor: { type: String, default: 'SYSTEM' },
  message: { type: String, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const EvidenceSampleSchema = new mongoose.Schema({
  trace_id: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  message: String,
  stack: Array,
  tags: Object,
  metrics: Object,
  location: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

export const IncidentSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  primaryHash: { type: String, required: true, index: true },
  title: { type: String, required: true },
  service: { type: String, required: true, index: true },
  environment: { type: String, default: 'production' },
  releaseSha: { type: String, default: 'unknown' },
  repoUrl: { type: String, default: null },
  investigationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Investigation', default: null },
  status: {
    type: String,
    enum: Object.values(INCIDENT_STATUS),
    default: INCIDENT_STATUS.OPEN,
    index: true
  },
  severity: {
    type: String,
    enum: Object.values(INCIDENT_SEVERITY),
    default: INCIDENT_SEVERITY.ERROR
  },
  eventCount: { type: Number, default: 1 },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now, index: true },
  timeline: [TimelineEntrySchema],
  evidence: [EvidenceSampleSchema],
  diagnostics: { type: mongoose.Schema.Types.Mixed, default: {} },
  remediation: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: true
});

// Compound indexes for fast correlation lookup and dashboard querying
IncidentSchema.index({ projectId: 1, primaryHash: 1, status: 1 });
IncidentSchema.index({ projectId: 1, updatedAt: -1 });

export const Incident = mongoose.models.Incident || mongoose.model('Incident', IncidentSchema);
