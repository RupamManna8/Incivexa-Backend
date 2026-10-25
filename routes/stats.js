import { Router } from 'express';
import {
  getProjectStats,
  getGlobalStats,
  getGeographyStats,
  getKpiSummary,
  getTrafficTimeSeries,
  getHttpStatusDistribution,
  getHttpMethodDistribution,
  getTopEndpoints
} from '../services/statsService.js';

export const router = Router({ mergeParams: true });

/**
 * Helper to extract projectId
 */
function resolveProjectId(req) {
  return req.params.projectId || req.query.projectId || null;
}

/**
 * Get geography and ingress distribution for analytics
 * GET /api/v1/stats/geography
 * GET /api/v1/projects/:projectId/stats/geography
 */
router.get('/geography', async (req, res) => {
  const projectId = resolveProjectId(req);
  const env = req.query.env || 'production';
  try {
    const geography = await getGeographyStats(env, projectId);
    return res.json({ success: true, geography });
  } catch (err) {
    console.error('[Stats] Geography error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get KPI Summary (Health score, active incidents, error rate, availability)
 * GET /api/v1/stats/kpi
 * GET /api/v1/projects/:projectId/stats/kpi
 */
router.get('/kpi', async (req, res) => {
  const projectId = resolveProjectId(req);
  const env = req.query.env || 'production';
  try {
    const kpi = await getKpiSummary(projectId, env);
    return res.json({ success: true, kpi });
  } catch (err) {
    console.error('[Stats] KPI error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get Traffic & Latency time series
 * GET /api/v1/stats/traffic
 * GET /api/v1/projects/:projectId/stats/traffic
 */
router.get('/traffic', async (req, res) => {
  const projectId = resolveProjectId(req);
  const range = req.query.range || '24h';
  const env = req.query.env || 'production';
  try {
    const traffic = await getTrafficTimeSeries(projectId, range, env);
    return res.json({ success: true, traffic });
  } catch (err) {
    console.error('[Stats] Traffic error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get HTTP Status Distribution
 * GET /api/v1/stats/http-status
 * GET /api/v1/projects/:projectId/stats/http-status
 */
router.get('/http-status', async (req, res) => {
  const projectId = resolveProjectId(req);
  const env = req.query.env || 'production';
  try {
    const httpStatus = await getHttpStatusDistribution(projectId, env);
    return res.json({ success: true, httpStatus });
  } catch (err) {
    console.error('[Stats] HTTP Status error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get HTTP Method Distribution
 * GET /api/v1/stats/http-methods
 * GET /api/v1/projects/:projectId/stats/http-methods
 */
router.get('/http-methods', async (req, res) => {
  const projectId = resolveProjectId(req);
  const env = req.query.env || 'production';
  try {
    const httpMethods = await getHttpMethodDistribution(projectId, env);
    return res.json({ success: true, httpMethods });
  } catch (err) {
    console.error('[Stats] HTTP Methods error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get Top Endpoints & Health
 * GET /api/v1/stats/top-endpoints
 * GET /api/v1/projects/:projectId/stats/top-endpoints
 */
router.get('/top-endpoints', async (req, res) => {
  const projectId = resolveProjectId(req);
  const env = req.query.env || 'production';
  try {
    const data = await getTopEndpoints(projectId, env);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Stats] Top Endpoints error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get stats for a project
 * GET /api/v1/projects/:projectId/stats
 */
router.get('/', async (req, res) => {
  const projectId = req.params.projectId || req.query.projectId;

  try {
    const stats = await getProjectStats(projectId);
    return res.json({ stats });
  } catch (err) {
    console.error('[Stats] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get global platform stats across all projects
 * GET /api/v1/stats/system
 */
router.get('/system', async (req, res) => {
  try {
    const stats = await getGlobalStats();
    return res.json({ stats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
