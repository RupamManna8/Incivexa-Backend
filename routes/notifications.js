import { Router } from 'express';
import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';
import { Incident } from '../models/Incident.js';
import { isDbConnected } from '../config/database.js';

export const router = Router();

/**
 * List all notifications for a project with unread count
 * GET /api/v1/notifications?projectId=...
 */
router.get('/', async (req, res) => {
  const { projectId } = req.query;

  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.json({ notifications: [], unreadCount: 0 });
  }

  const pid = new mongoose.Types.ObjectId(projectId);

  try {
    if (isDbConnected()) {
      // 1. Sync: Check for any open CRITICAL or HIGH incidents that need a notification record
      const openSevereIncidents = await Incident.find({
        projectId: pid,
        status: { $ne: 'RESOLVED' },
        severity: { $in: ['CRITICAL', 'HIGH', 'critical', 'high'] }
      }).limit(50).lean();

      if (openSevereIncidents.length > 0) {
        const existingNotifs = await Notification.find({
          projectId: pid,
          incidentId: { $in: openSevereIncidents.map(i => i._id) }
        }).lean();

        const existingIncidentIds = new Set(existingNotifs.map(n => String(n.incidentId)));

        const missing = openSevereIncidents.filter(inc => !existingIncidentIds.has(String(inc._id)));
        if (missing.length > 0) {
          const toInsert = missing.map(inc => ({
            projectId: pid,
            incidentId: inc._id,
            title: inc.title || 'High severity anomaly detected',
            message: inc.evidence?.[0]?.message || inc.title || 'Elevated anomaly detected',
            severity: (inc.severity || 'HIGH').toUpperCase(),
            service: inc.service || 'backend',
            read: false,
            createdAt: inc.lastSeen || inc.createdAt || new Date()
          }));
          await Notification.insertMany(toInsert, { ordered: false }).catch(() => {});
        }
      }

      // 2. Fetch all notifications
      const notifications = await Notification.find({ projectId: pid })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      const unreadCount = notifications.filter(n => !n.read).length;

      return res.json({ notifications, unreadCount });
    }

    return res.json({ notifications: [], unreadCount: 0 });
  } catch (err) {
    console.error('[Notifications] Fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Mark a single notification as read
 * PATCH /api/v1/notifications/:id/read
 */
router.patch('/:id/read', async (req, res) => {
  const { id } = req.params;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Valid notification ID required' });
  }

  try {
    if (isDbConnected()) {
      const notif = await Notification.findByIdAndUpdate(
        id,
        { $set: { read: true, readAt: new Date() } },
        { new: true }
      );

      if (!notif) {
        return res.status(404).json({ error: 'Notification not found' });
      }

      // Compute updated unread count for this project
      const unreadCount = await Notification.countDocuments({
        projectId: notif.projectId,
        read: false
      });

      return res.json({ success: true, notification: notif, unreadCount });
    }

    return res.json({ success: true, unreadCount: 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Mark all notifications for a project as read
 * POST /api/v1/notifications/read-all
 */
router.post('/read-all', async (req, res) => {
  const { projectId } = req.body;

  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ error: 'Valid projectId required' });
  }

  const pid = new mongoose.Types.ObjectId(projectId);

  try {
    if (isDbConnected()) {
      await Notification.updateMany(
        { projectId: pid, read: false },
        { $set: { read: true, readAt: new Date() } }
      );

      return res.json({ success: true, unreadCount: 0 });
    }

    return res.json({ success: true, unreadCount: 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
