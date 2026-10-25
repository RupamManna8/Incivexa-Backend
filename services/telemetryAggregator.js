import mongoose from 'mongoose';
import { Incident } from '../models/Incident.js';
import { isDbConnected } from '../config/database.js';

// Get or register TelemetryEvent model
const EventSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  trace_id: { type: String, required: true },
  service: { type: String, required: true },
  env: { type: String, required: true },
  release_sha: String,
  repo_url: String,
  branch: String,
  severity: { type: String, enum: ['info', 'warning', 'error', 'critical'] },
  stack: Array,
  metrics: Object,
  tags: Object,
  timestamp: { type: Date, default: Date.now, index: true }
});

const TelemetryEvent = mongoose.models.TelemetryEvent || mongoose.model('TelemetryEvent', EventSchema);

/**
 * Helper to compute percentile from array of numbers
 */
function calculatePercentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const valid = arr.filter(n => typeof n === 'number' && !isNaN(n)).sort((a, b) => a - b);
  if (valid.length === 0) return 0;
  const index = Math.ceil((p / 100) * valid.length) - 1;
  return Math.round(valid[Math.max(0, Math.min(index, valid.length - 1))]);
}

/**
 * Helper to parse timeRange into milliseconds & bucket size
 */
function getTimeRangeConfig(timeRange = '24h') {
  switch (timeRange) {
    case '1h':
      return { ms: 60 * 60 * 1000, bucketMinutes: 2, count: 30 };
    case '6h':
      return { ms: 6 * 60 * 60 * 1000, bucketMinutes: 15, count: 24 };
    case '7d':
      return { ms: 7 * 24 * 60 * 60 * 1000, bucketMinutes: 360, count: 28 };
    case '24h':
    default:
      return { ms: 24 * 60 * 60 * 1000, bucketMinutes: 60, count: 24 };
  }
}

/**
 * Helper to construct flexible project and env filters
 */
function buildProjectMatch(projectId, env) {
  const match = {};
  if (projectId && projectId !== 'all') {
    if (mongoose.Types.ObjectId.isValid(projectId)) {
      match.projectId = { $in: [new mongoose.Types.ObjectId(projectId), String(projectId)] };
    } else {
      match.projectId = String(projectId);
    }
  }
  if (env && env !== 'all') {
    match.env = { $regex: new RegExp(`^${env}$`, 'i') };
  }
  return match;
}

/**
 * 1. Get KPI Summary (Health Score, Active Incidents, Error Rate, Availability)
 */
export async function getKpiSummary(projectId, env) {
  if (!isDbConnected()) {
    return {
      appHealthScore: 100,
      appHealthStatus: 'Healthy',
      appHealthTrend: '+0.0%',
      activeIncidents: { total: 0, p0: 0, p1: 0, p2: 0, trend: '0 active' },
      errorRate: { current: 0, trend: '0.00%', trendDirection: 'down' },
      availability: { current: 100, slaTarget: 99.95, period: '30d', status: 'Compliant' }
    };
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const baseMatch = buildProjectMatch(projectId, env);

  // Active Incidents query
  const incidentMatch = {
    ...baseMatch,
    status: { $in: ['OPEN', 'TRIAGING', 'INVESTIGATING', 'DIAGNOSED', 'AWAITING_APPROVAL', 'REMEDIATING', 'ESCALATED'] }
  };

  const [activeIncidentsAgg, telemetryAgg] = await Promise.all([
    Incident.aggregate([
      { $match: incidentMatch },
      { $group: { _id: '$severity', count: { $sum: 1 } } }
    ]),
    TelemetryEvent.aggregate([
      {
        $match: {
          ...baseMatch,
          timestamp: { $gte: oneDayAgo }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          errors: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $in: ['$severity', ['error', 'critical']] },
                    { $gte: [{ $toInt: '$tags.http_status' }, 400] }
                  ]
                },
                1,
                0
              ]
            }
          },
          serverErrors5xx: {
            $sum: {
              $cond: [
                { $gte: [{ $toInt: '$tags.http_status' }, 500] },
                1,
                0
              ]
            }
          }
        }
      }
    ])
  ]);

  let p0 = 0, p1 = 0, p2 = 0;
  for (const item of activeIncidentsAgg) {
    const sev = (item._id || '').toLowerCase();
    if (sev === 'critical') p0 += item.count;
    else if (sev === 'error' || sev === 'high') p1 += item.count;
    else p2 += item.count;
  }
  const totalActive = p0 + p1 + p2;

  const tel = telemetryAgg[0] || { total: 0, errors: 0, serverErrors5xx: 0 };
  const totalEvents = tel.total;
  const errorEvents = tel.errors;
  const errorRate = totalEvents > 0 ? (errorEvents / totalEvents) * 100 : 0;
  const availability = totalEvents > 0 ? Math.max(0, 100 - (tel.serverErrors5xx / totalEvents) * 100) : 100;

  // Calculate dynamic health score
  let healthScore = 100;
  healthScore -= p0 * 20;
  healthScore -= p1 * 8;
  healthScore -= p2 * 2;
  healthScore -= Math.min(30, errorRate * 5);
  healthScore = Math.max(0, Math.min(100, healthScore));

  const healthStatus = healthScore >= 90 ? 'Healthy' : healthScore >= 75 ? 'Degraded' : 'Critical';

  return {
    appHealthScore: Number(healthScore.toFixed(1)),
    appHealthStatus: healthStatus,
    appHealthTrend: totalActive === 0 ? '+0.5%' : `-${(totalActive * 0.8).toFixed(1)}%`,
    activeIncidents: {
      total: totalActive,
      p0,
      p1,
      p2,
      trend: totalActive === 0 ? '0 active · optimal' : `${totalActive} active · triage active`
    },
    errorRate: {
      current: Number(errorRate.toFixed(2)),
      trend: errorRate > 0.5 ? '+0.12%' : '-0.02%',
      trendDirection: errorRate > 0.5 ? 'up' : 'down'
    },
    availability: {
      current: Number(availability.toFixed(2)),
      slaTarget: 99.95,
      period: '30d',
      status: availability >= 99.95 ? 'Compliant' : 'Degraded'
    }
  };
}

/**
 * 2. Get Traffic & Latency Time Series
 */
export async function getTrafficTimeSeries(projectId, timeRange = '24h', env) {
  const config = getTimeRangeConfig(timeRange);
  const since = new Date(Date.now() - config.ms);

  if (!isDbConnected()) {
    return generateEmptyTimeSeries(config);
  }

  const baseMatch = buildProjectMatch(projectId, env);
  const match = {
    ...baseMatch,
    timestamp: { $gte: since }
  };

  const rawEvents = await TelemetryEvent.aggregate([
    { $match: match },
    {
      $project: {
        timestamp: 1,
        duration: { $ifNull: ['$metrics.duration_ms', 0] },
        isError: {
          $cond: [
            {
              $or: [
                { $in: ['$severity', ['error', 'critical']] },
                { $gte: [{ $toInt: '$tags.http_status' }, 400] }
              ]
            },
            1,
            0
          ]
        }
      }
    }
  ]);

  if (rawEvents.length === 0) {
    return generateEmptyTimeSeries(config);
  }

  // Group events into time buckets
  const bucketMs = config.bucketMinutes * 60 * 1000;
  const buckets = {};
  const startTime = since.getTime();
  const now = Date.now();

  for (let t = startTime; t <= now; t += bucketMs) {
    const key = Math.floor(t / bucketMs) * bucketMs;
    buckets[key] = { requests: 0, errors: 0, latencies: [] };
  }

  for (const ev of rawEvents) {
    const evTime = new Date(ev.timestamp).getTime();
    const key = Math.floor(evTime / bucketMs) * bucketMs;
    if (!buckets[key]) {
      buckets[key] = { requests: 0, errors: 0, latencies: [] };
    }
    buckets[key].requests += 1;
    if (ev.isError) buckets[key].errors += 1;
    if (typeof ev.duration === 'number') buckets[key].latencies.push(ev.duration);
  }

  const points = [];
  let totalRequests = 0;
  let totalErrors = 0;
  const allP95 = [];
  const allP99 = [];

  const sortedKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  for (const k of sortedKeys) {
    const b = buckets[k];
    const date = new Date(k);
    const timeLabel = config.bucketMinutes < 60
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : `${date.getHours().toString().padStart(2, '0')}:00`;

    const p95 = calculatePercentile(b.latencies, 95);
    const p99 = calculatePercentile(b.latencies, 99);

    totalRequests += b.requests;
    totalErrors += b.errors;
    if (p95 > 0) allP95.push(p95);
    if (p99 > 0) allP99.push(p99);

    points.push({
      time: timeLabel,
      requests: b.requests,
      p95Latency: p95,
      p99Latency: p99,
      errors: b.errors
    });
  }

  const lastPoint = points.length > 0 ? points[points.length - 1] : null;
  const avgP95 = allP95.length > 0 ? Math.round(allP95.reduce((a, b) => a + b, 0) / allP95.length) : 0;
  const avgP99 = allP99.length > 0 ? Math.round(allP99.reduce((a, b) => a + b, 0) / allP99.length) : 0;
  const errorRatePercent = totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(2) : '0.00';

  return {
    timeRange,
    environment: env || 'production',
    points,
    summary: {
      totalRequests,
      currentRps: lastPoint && lastPoint.requests > 0
        ? Number((lastPoint.requests / Math.max(1, (config.bucketMinutes || 60) * 60)).toFixed(2))
        : (totalRequests > 0 ? Number((totalRequests / Math.max(1, config.ms / 1000)).toFixed(2)) : 0),
      avgP95,
      avgP99,
      totalErrors,
      errorRatePercent
    }
  };
}

function generateEmptyTimeSeries(config) {
  const points = [];
  const now = Date.now();
  const bucketMs = config.bucketMinutes * 60 * 1000;
  const start = now - config.ms;

  for (let t = start; t <= now; t += bucketMs) {
    const date = new Date(t);
    const timeLabel = config.bucketMinutes < 60
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : `${date.getHours().toString().padStart(2, '0')}:00`;

    points.push({
      time: timeLabel,
      requests: 0,
      p95Latency: 0,
      p99Latency: 0,
      errors: 0
    });
  }

  return {
    timeRange: '24h',
    environment: 'production',
    points,
    summary: {
      totalRequests: 0,
      currentRps: 0,
      avgP95: 0,
      avgP99: 0,
      totalErrors: 0,
      errorRatePercent: '0.00'
    }
  };
}

/**
 * 3. Get HTTP Status Distribution
 */
export async function getHttpStatusDistribution(projectId, env) {
  if (!isDbConnected()) {
    return {
      total: 0,
      distribution: [
        { codeGroup: '2xx Success', count: 0, percent: 0, color: '#16A34A' },
        { codeGroup: '3xx Redirection', count: 0, percent: 0, color: '#0284C7' },
        { codeGroup: '4xx Client Error', count: 0, percent: 0, color: '#EA580C' },
        { codeGroup: '5xx Server Error', count: 0, percent: 0, color: '#DC2626' }
      ],
      recent5xxBreakdown: []
    };
  }

  const match = buildProjectMatch(projectId, env);

  const [statusAgg, recent5xxAgg] = await Promise.all([
    TelemetryEvent.aggregate([
      { $match: match },
      {
        $project: {
          statusCode: {
            $toInt: {
              $ifNull: ['$tags.http_status', { $ifNull: ['$tags.statusCode', 200] }]
            }
          }
        }
      },
      {
        $group: {
          _id: {
            $switch: {
              branches: [
                { case: { $and: [{ $gte: ['$statusCode', 200] }, { $lt: ['$statusCode', 300] }] }, then: '2xx' },
                { case: { $and: [{ $gte: ['$statusCode', 300] }, { $lt: ['$statusCode', 400] }] }, then: '3xx' },
                { case: { $and: [{ $gte: ['$statusCode', 400] }, { $lt: ['$statusCode', 500] }] }, then: '4xx' },
                { case: { $gte: ['$statusCode', 500] }, then: '5xx' }
              ],
              default: '2xx'
            }
          },
          count: { $sum: 1 }
        }
      }
    ]),
    TelemetryEvent.aggregate([
      {
        $match: {
          ...match,
          $or: [
            { 'tags.http_status': { $regex: '^5' } },
            { severity: 'critical' },
            { 'tags.statusCode': { $gte: 500 } }
          ]
        }
      },
      {
        $group: {
          _id: {
            code: { $ifNull: ['$tags.http_status', '500'] },
            service: { $ifNull: ['$service', 'gateway'] }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ])
  ]);

  let total = 0;
  const counts = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };

  for (const s of statusAgg) {
    if (counts[s._id] !== undefined) {
      counts[s._id] = s.count;
      total += s.count;
    }
  }

  const distribution = [
    {
      codeGroup: '2xx Success',
      count: counts['2xx'],
      percent: total > 0 ? Number(((counts['2xx'] / total) * 100).toFixed(2)) : 0,
      color: '#16A34A'
    },
    {
      codeGroup: '3xx Redirection',
      count: counts['3xx'],
      percent: total > 0 ? Number(((counts['3xx'] / total) * 100).toFixed(2)) : 0,
      color: '#0284C7'
    },
    {
      codeGroup: '4xx Client Error',
      count: counts['4xx'],
      percent: total > 0 ? Number(((counts['4xx'] / total) * 100).toFixed(2)) : 0,
      color: '#EA580C'
    },
    {
      codeGroup: '5xx Server Error',
      count: counts['5xx'],
      percent: total > 0 ? Number(((counts['5xx'] / total) * 100).toFixed(2)) : 0,
      color: '#DC2626'
    }
  ];

  const recent5xxBreakdown = recent5xxAgg.map(r => ({
    code: `HTTP ${r._id.code}`,
    service: r._id.service,
    count: r.count
  }));

  return {
    total,
    distribution,
    recent5xxBreakdown
  };
}

/**
 * 4. Get HTTP Method Distribution
 */
export async function getHttpMethodDistribution(projectId, env) {
  const methodColors = {
    GET: '#2563EB',
    POST: '#16A34A',
    PUT: '#D97706',
    DELETE: '#DC2626',
    PATCH: '#9333EA',
    OPTIONS: '#6B7280',
    HEAD: '#4B5563'
  };

  if (!isDbConnected()) {
    return {
      methods: []
    };
  }

  const match = buildProjectMatch(projectId, env);

  const agg = await TelemetryEvent.aggregate([
    { $match: match },
    {
      $project: {
        method: {
          $toUpper: {
            $ifNull: ['$tags.http_method', { $ifNull: ['$tags.method', 'GET'] }]
          }
        },
        duration: { $ifNull: ['$metrics.duration_ms', 0] }
      }
    },
    {
      $group: {
        _id: '$method',
        count: { $sum: 1 },
        avgLatency: { $avg: '$duration' }
      }
    },
    { $sort: { count: -1 } }
  ]);

  const total = agg.reduce((sum, item) => sum + item.count, 0);

  if (total === 0) {
    return {
      methods: []
    };
  }

  const methods = agg.map(item => ({
    method: item._id,
    count: item.count,
    percent: Number(((item.count / total) * 100).toFixed(1)),
    avgLatency: Math.round(item.avgLatency || 0),
    color: methodColors[item._id] || '#6B7280'
  }));

  return { methods };
}

/**
 * 5. Get Top Endpoints & Health
 */
export async function getTopEndpoints(projectId, env) {
  if (!isDbConnected()) {
    return { endpoints: [] };
  }

  const match = buildProjectMatch(projectId, env);

  const agg = await TelemetryEvent.aggregate([
    { $match: match },
    {
      $project: {
        path: { $ifNull: ['$tags.http_path', { $ifNull: ['$tags.path', '/'] }] },
        method: { $toUpper: { $ifNull: ['$tags.http_method', 'GET'] } },
        duration: { $ifNull: ['$metrics.duration_ms', 0] },
        isError: {
          $cond: [
            {
              $or: [
                { $in: ['$severity', ['error', 'critical']] },
                { $gte: [{ $toInt: '$tags.http_status' }, 400] }
              ]
            },
            1,
            0
          ]
        }
      }
    },
    {
      $group: {
        _id: { path: '$path', method: '$method' },
        count: { $sum: 1 },
        latencies: { $push: '$duration' },
        errorCount: { $sum: '$isError' }
      }
    },
    { $sort: { count: -1 } },
    { $limit: 15 }
  ]);

  const endpoints = agg.map(item => {
    const count = item.count;
    const errorCount = item.errorCount;
    const errorRate = count > 0 ? errorCount / count : 0;
    const p95Latency = calculatePercentile(item.latencies, 95);
    const rps = Math.max(1, Math.round(count / 60)); // approximated RPS over active period

    let status = 'Healthy';
    if (errorRate > 0.05 || p95Latency > 500) {
      status = 'Critical';
    } else if (errorRate > 0.01 || p95Latency > 150) {
      status = 'Degraded';
    }

    return {
      path: item._id.path,
      method: item._id.method,
      rps,
      p95Latency,
      errorRate: Number(errorRate.toFixed(4)),
      status
    };
  });

  return { endpoints };
}
