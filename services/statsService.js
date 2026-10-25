import mongoose from 'mongoose';
import { Incident } from '../models/Incident.js';
import { Stats } from '../models/Stats.js';
import { isDbConnected } from '../config/database.js';
import { locationService } from './locationService.js';
import {
  getKpiSummary,
  getTrafficTimeSeries,
  getHttpStatusDistribution,
  getHttpMethodDistribution,
  getTopEndpoints
} from './telemetryAggregator.js';

export {
  getKpiSummary,
  getTrafficTimeSeries,
  getHttpStatusDistribution,
  getHttpMethodDistribution,
  getTopEndpoints
};

/**
 * Get geography and ingress distribution for analytics
 */
export async function getGeographyStats(env = 'production', projectId = null) {
  return await locationService.getGeoDistribution(env, projectId);
}

/**
 * Get real-time stats for a project by running a MongoDB aggregation pipeline.
 * Falls back to pre-computed Stats collection when available.
 */
export async function getProjectStats(projectId) {
  if (!isDbConnected() || !mongoose.Types.ObjectId.isValid(projectId)) {
    return getEmptyStats();
  }

  const pid = new mongoose.Types.ObjectId(projectId);

  const [severityAgg, statusAgg, recentCount] = await Promise.all([
    Incident.aggregate([
      { $match: { projectId: pid } },
      { $group: { _id: '$severity', count: { $sum: 1 }, totalEvents: { $sum: '$eventCount' } } }
    ]),
    Incident.aggregate([
      { $match: { projectId: pid } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Incident.countDocuments({ projectId: pid, lastSeen: { $gte: new Date(Date.now() - 3600000) } })
  ]);

  const bySeverity = {};
  let totalEvents = 0;
  for (const s of severityAgg) {
    bySeverity[s._id] = s.count;
    totalEvents += s.totalEvents;
  }

  const byStatus = {};
  for (const s of statusAgg) {
    byStatus[s._id] = s.count;
  }

  // Compute MTTR for resolved incidents
  const resolvedIncidents = await Incident.find(
    { projectId: pid, status: 'RESOLVED' },
    { firstSeen: 1, updatedAt: 1 }
  ).lean().limit(100);

  let mttrMinutes = null;
  if (resolvedIncidents.length > 0) {
    const totalMs = resolvedIncidents.reduce((sum, inc) => {
      return sum + ((inc.updatedAt || inc.firstSeen) - inc.firstSeen);
    }, 0);
    mttrMinutes = Math.round(totalMs / resolvedIncidents.length / 60000);
  }

  return {
    totalIncidents: Object.values(bySeverity).reduce((a, b) => a + b, 0),
    totalEvents,
    activeLastHour: recentCount,
    bySeverity,
    byStatus,
    mttrMinutes
  };
}

/**
 * Get global platform overview stats.
 */
export async function getGlobalStats() {
  if (!isDbConnected()) return getEmptyStats();

  const [total, activeLastHour, bySeverity] = await Promise.all([
    Incident.countDocuments(),
    Incident.countDocuments({ lastSeen: { $gte: new Date(Date.now() - 3600000) } }),
    Incident.aggregate([
      { $group: { _id: '$severity', count: { $sum: 1 } } }
    ])
  ]);

  const severityMap = {};
  for (const s of bySeverity) severityMap[s._id] = s.count;

  return { totalIncidents: total, activeLastHour, bySeverity: severityMap };
}

function getEmptyStats() {
  return {
    totalIncidents: 0,
    totalEvents: 0,
    activeLastHour: 0,
    bySeverity: {},
    byStatus: {},
    mttrMinutes: null
  };
}
