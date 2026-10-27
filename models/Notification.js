import mongoose from 'mongoose';

export const NotificationSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  incidentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident', required: false, default: null, index: true },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  severity: { type: String, enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'], default: 'INFO', index: true },
  service: { type: String, default: 'backend' },
  read: { type: Boolean, default: false, index: true },
  readAt: { type: Date, default: null }
}, {
  timestamps: true
});

NotificationSchema.index({ projectId: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.models.Notification || mongoose.model('Notification', NotificationSchema);
