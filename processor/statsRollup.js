import mongoose from 'mongoose';
import { Incident } from '../models/Incident.js';
import { Project } from '../models/Project.js';
import { Stats } from '../models/Stats.js';
import { isDbConnected } from '../config/database.js';

/**
 * Roll up incident statistics for all projects into the pre-computed Stats collection.
 */
export async function runStatsRollup() {
  if (!isDbConnected()) return;

  try {
    const projects = await Project.find({}, { _id: 1 }).lean();
    const now = new Date();
    const roundedHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());

    for (const project of projects) {
      const pid = project._id;

      const [severityCounts, resolvedIncidents, activeEvents] = await Promise.all([
        Incident.aggregate([
          { $match: { projectId: pid } },
          { $group: { _id: '$severity', count: { $sum: 1 }, events: { $sum: '$eventCount' } } }
        ]),
        Incident.find({ projectId: pid, status: 'RESOLVED' }, { firstSeen: 1, updatedAt: 1 }).lean().limit(100),
        Incident.aggregate([
          { $match: { projectId: pid, lastSeen: { $gte: new Date(Date.now() - 3600000) } } },
          { $group: { _id: null, totalEvents: { $sum: '$eventCount' } } }
        ])
      ]);

      const counts = { low: 0, medium: 0, high: 0, critical: 0 };
      let totalIncidents = 0;
      let totalEvents = 0;

      for (const s of severityCounts) {
        const sev = (s._id || '').toLowerCase();
        if (counts[sev] !== undefined) counts[sev] = s.count;
        totalIncidents += s.count;
        totalEvents += s.events || 0;
      }

      let mttrMinutes = 0;
      if (resolvedIncidents.length > 0) {
        const totalDuration = resolvedIncidents.reduce((sum, inc) => {
          return sum + ((inc.updatedAt || inc.firstSeen) - inc.firstSeen);
        }, 0);
        mttrMinutes = Math.round(totalDuration / resolvedIncidents.length / 60000);
      }

      const activeEventRate = activeEvents[0]?.totalEvents || 0;

      await Stats.findOneAndUpdate(
        { projectId: pid, period: 'hourly', timestamp: roundedHour },
        {
          $set: {
            incidentCount: totalIncidents,
            criticalCount: counts.critical,
            highCount: counts.high,
            mediumCount: counts.medium,
            lowCount: counts.low,
            mttrMinutes,
            activeEventRate,
            resolvedCount: resolvedIncidents.length
          }
        },
        { upsert: true, new: true }
      );
    }
  } catch (err) {
    console.error('[StatsRollup] Error during stats aggregation:', err.message);
  }
}

/**
 * Starts background timer for rollup every 60 seconds
 */
export function startStatsRollupScheduler(intervalMs = 60000) {
  const timer = setInterval(runStatsRollup, intervalMs);
  runStatsRollup().catch(() => {});
  return timer;
}
