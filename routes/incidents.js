import { Router } from 'express';
import mongoose from 'mongoose';
import { Incident, INCIDENT_STATUS } from '../models/Incident.js';
import { Investigation } from '../models/Investigation.js';
import { getInMemoryIncidents } from '../processor/correlator.js';
import { isDbConnected } from '../config/database.js';

export const router = Router({ mergeParams: true });

/**
 * 1. List Incidents for a Project
 * GET /api/v1/projects/:projectId/incidents (or GET /api/v1/incidents?projectId=...)
 */
router.get('/', async (req, res) => {
  const projectId = req.params.projectId || req.query.projectId;
  const { status, severity, service, limit = 50, page = 1 } = req.query;

  try {
    if (isDbConnected()) {
      if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
        const filter = { projectId: new mongoose.Types.ObjectId(projectId) };
        if (status) filter.status = status;
        if (severity) filter.severity = severity;
        if (service) filter.service = service;

        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const incidents = await Incident.find(filter)
          .sort({ lastSeen: -1 })
          .skip(skip)
          .limit(parseInt(limit, 10))
          .lean();

        const total = await Incident.countDocuments(filter);

        return res.json({
          incidents,
          pagination: { total, page: parseInt(page, 10), limit: parseInt(limit, 10) }
        });
      }

      return res.json({
        incidents: [],
        pagination: { total: 0, page: 1, limit: parseInt(limit, 10) }
      });
    }

    if (!projectId) {
      return res.json({
        incidents: [],
        pagination: { total: 0, page: 1, limit: parseInt(limit, 10) }
      });
    }

    // In-memory fallback
    let list = getInMemoryIncidents(projectId);
    if (status) list = list.filter(i => i.status === status);
    if (severity) list = list.filter(i => i.severity === severity);
    if (service) list = list.filter(i => i.service === service);

    return res.json({
      incidents: list,
      pagination: { total: list.length, page: 1, limit: 50 }
    });
  } catch (err) {
    console.error('[Incidents] List error:', err);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * 2. Get Single Incident Details
 * GET /api/v1/projects/:projectId/incidents/:incidentId
 */
router.get('/:incidentId', async (req, res) => {
  const projectId = req.params.projectId || req.query.projectId;
  const { incidentId } = req.params;

  try {
    if (isDbConnected() && mongoose.Types.ObjectId.isValid(incidentId)) {
      const query = { _id: incidentId };
      if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
        query.projectId = new mongoose.Types.ObjectId(projectId);
      }
      const incident = await Incident.findOne(query).lean();

      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }
      return res.json(incident);
    }

    // In-memory fallback
    const list = getInMemoryIncidents(projectId || '64f01234567890abcdef1234');
    const item = list.find(i => i._id === incidentId || i.primaryHash === incidentId);
    if (!item) {
      return res.status(404).json({ error: 'Incident not found' });
    }
    return res.json(item);
  } catch (err) {
    console.error('[Incidents] Get by ID error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * 3. Transition Incident Status
 * PATCH /api/v1/projects/:projectId/incidents/:incidentId/status
 */
router.patch('/:incidentId/status', async (req, res) => {
  const projectId = req.params.projectId || req.query.projectId;
  const { incidentId } = req.params;
  const { status, note, actor = 'USER' } = req.body;

  if (!status || !INCIDENT_STATUS[status]) {
    return res.status(400).json({
      error: 'Bad Request',
      message: `Invalid status. Must be one of: ${Object.values(INCIDENT_STATUS).join(', ')}`
    });
  }

  try {
    if (isDbConnected() && mongoose.Types.ObjectId.isValid(incidentId)) {
      const query = { _id: incidentId };
      if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
        query.projectId = new mongoose.Types.ObjectId(projectId);
      }
      const incident = await Incident.findOne(query);

      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      const prevStatus = incident.status;
      incident.status = status;
      incident.timeline.push({
        timestamp: new Date(),
        action: 'STATUS_CHANGED',
        actor,
        message: note || `Status changed from ${prevStatus} to ${status}`,
        metadata: { prevStatus, newStatus: status }
      });

      await incident.save();

      if (status === 'RESOLVED' && mongoose.models.Notification) {
        await mongoose.models.Notification.updateMany(
          { incidentId: incident._id },
          { $set: { read: true, readAt: new Date() } }
        ).catch(() => {});
      }

      return res.json({ success: true, incident });
    }

    // In-memory fallback
    const list = getInMemoryIncidents(projectId || '64f01234567890abcdef1234');
    const item = list.find(i => i._id === incidentId || i.primaryHash === incidentId);
    if (!item) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    const prevStatus = item.status;
    item.status = status;
    item.timeline.push({
      timestamp: new Date(),
      action: 'STATUS_CHANGED',
      actor,
      message: note || `Status changed from ${prevStatus} to ${status}`,
      metadata: { prevStatus, newStatus: status }
    });

    return res.json({ success: true, incident: item });
  } catch (err) {
    console.error('[Incidents] Transition status error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * 4. Get Investigation for an Incident
 * GET /api/v1/projects/:projectId/incidents/:incidentId/investigation
 */
router.get('/:incidentId/investigation', async (req, res) => {
  const { incidentId } = req.params;
  try {
    if (isDbConnected() && mongoose.Types.ObjectId.isValid(incidentId)) {
      const investigation = await Investigation.findOne({ incidentId: new mongoose.Types.ObjectId(incidentId) })
        .sort({ createdAt: -1 })
        .lean();

      if (!investigation) {
        return res.status(404).json({ error: 'Investigation not found for this incident' });
      }
      return res.json(investigation);
    }
    return res.status(404).json({ error: 'Database not connected or invalid incident ID' });
  } catch (err) {
    console.error('[Incidents] Get investigation error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
