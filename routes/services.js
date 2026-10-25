import { Router } from 'express';
import { getServicesHealth } from '../services/serviceRegistry.js';

export const router = Router();

/**
 * Health probe across all engines and microservices
 * GET /api/v1/services/health
 */
router.get('/health', async (req, res) => {
  try {
    const health = await getServicesHealth();
    return res.json({ services: health });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
