import mongoose from 'mongoose';

const StatsSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  period: { type: String, enum: ['hourly', 'daily'], required: true },
  timestamp: { type: Date, required: true },
  incidentCount: { type: Number, default: 0 },
  criticalCount: { type: Number, default: 0 },
  highCount: { type: Number, default: 0 },
  mediumCount: { type: Number, default: 0 },
  lowCount: { type: Number, default: 0 },
  resolvedCount: { type: Number, default: 0 },
  totalEvents: { type: Number, default: 0 },
  mttrMinutes: { type: Number, default: null }
}, {
  timestamps: true
});

StatsSchema.index({ projectId: 1, period: 1, timestamp: -1 });

export const Stats = mongoose.models.Stats || mongoose.model('Stats', StatsSchema);
