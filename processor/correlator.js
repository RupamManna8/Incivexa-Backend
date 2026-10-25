import mongoose from 'mongoose';
import { computeFingerprint } from '../shared/fingerprint.js';
import { Incident, INCIDENT_STATUS } from '../models/Incident.js';
import { classifyIncidentRisk } from './riskClassifier.js';
import { locationService } from '../services/locationService.js';

// 15-minute sliding deduplication window
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

// In-memory fallback cache when MongoDB is running in offline/mock mode
const inMemoryIncidents = new Map();

const SEVERITY_RANK = {
  info: 1,
  warning: 2,
  error: 3,
  critical: 4
};

/**
 * Correlates an incoming telemetry event with existing active incidents
 * or opens a new canonical Incident record.
 * 
 * @param {object} event - Raw validated telemetry event
 * @returns {Promise<{ incident: object, isNew: boolean, fingerprint: object }>}
 */
export async function correlateEvent(event) {
  const fingerprint = computeFingerprint(event);
  const { primaryHash, title } = fingerprint;
  const projectId = event.projectId || '64f01234567890abcdef1234';
  const eventTime = event.timestamp ? new Date(event.timestamp) : new Date();
  const windowThreshold = new Date(eventTime.getTime() - DEDUPE_WINDOW_MS);

  // Extract client IP & resolve geographic origin using LocationService
  const clientIp = event.tags?.client_ip || event.tags?.ip || '127.0.0.1';
  let locationData = null;
  if (clientIp) {
    locationData = await locationService.FetchLocationWithIP(clientIp).catch(() => null);
    if (locationData) {
      locationService.recordGeoHit(locationData, event.metrics?.duration_ms || 25, event.severity === 'error' || event.severity === 'critical');
      event.location = locationData;
    }
  }

  const evidenceItem = {
    trace_id: event.trace_id,
    timestamp: eventTime,
    message: event.tags?.message || event.tags?.error || title,
    stack: event.stack || [],
    tags: event.tags || {},
    metrics: event.metrics || {},
    location: locationData
  };

  // Case A: MongoDB is connected
  if (mongoose.connection.readyState === 1) {
    try {
      // Find active incident within the deduplication window
      let incident = await Incident.findOne({
        projectId: new mongoose.Types.ObjectId(projectId),
        primaryHash,
        status: { $ne: INCIDENT_STATUS.RESOLVED },
        lastSeen: { $gte: windowThreshold }
      });

      if (incident) {
        // --- Existing Incident: Correlate & Aggregate ---
        incident.eventCount += 1;
        incident.lastSeen = eventTime;

        // Upgrade severity if incoming event is higher priority
        const currentRank = SEVERITY_RANK[incident.severity] || 2;
        const incomingRank = SEVERITY_RANK[event.severity] || 2;
        let severityUpgraded = false;
        if (incomingRank > currentRank) {
          incident.severity = event.severity;
          severityUpgraded = true;
          incident.timeline.push({
            timestamp: eventTime,
            action: 'SEVERITY_UPGRADED',
            actor: 'CORRELATOR',
            message: `Severity elevated to ${event.severity} due to incoming high-priority alert`,
            metadata: { trace_id: event.trace_id }
          });
        }

        // Surge alert milestones
        if ([10, 50, 100, 500, 1000].includes(incident.eventCount)) {
          incident.timeline.push({
            timestamp: eventTime,
            action: 'EVENT_SURGE',
            actor: 'CORRELATOR',
            message: `Event storm milestone reached: ${incident.eventCount} occurrences correlated`,
            metadata: { count: incident.eventCount }
          });
        }

        // Keep evidence buffer bounded (max 10 samples)
        if (incident.evidence.length < 10) {
          incident.evidence.push(evidenceItem);
        }

        await incident.save();

        // Re-classify risk when severity escalates or if not yet classified
        let prediction = incident.diagnostics?.ml_diagnosis || null;
        if (severityUpgraded || !prediction) {
          prediction = await classifyIncidentRisk(event, incident).catch(() => null);
        }

        const resObj = { incident, isNew: false, fingerprint };
        logMonitoredError(event, incident, false, fingerprint, prediction || incident.diagnostics?.ml_diagnosis, locationData);
        return resObj;

      } else {
        // --- New Incident: Initialize ---
        const newIncident = new Incident({
          projectId: new mongoose.Types.ObjectId(projectId),
          primaryHash,
          title,
          service: event.service || 'unknown-service',
          environment: event.env || 'production',
          releaseSha: event.release_sha || 'unknown',
          repoUrl: event.repo_url || null,
          status: INCIDENT_STATUS.OPEN,
          severity: event.severity || 'error',
          eventCount: 1,
          firstSeen: eventTime,
          lastSeen: eventTime,
          timeline: [
            {
              timestamp: eventTime,
              action: 'INCIDENT_CREATED',
              actor: 'CORRELATOR',
              message: `Incident created from telemetry fingerprint ${primaryHash}`,
              metadata: { trace_id: event.trace_id, initialError: evidenceItem.message }
            }
          ],
          evidence: [evidenceItem]
        });

        await newIncident.save();

        // Classify risk with ML model
        const prediction = await classifyIncidentRisk(event, newIncident).catch(() => null);

        const resObj = { incident: newIncident, isNew: true, fingerprint };
        logMonitoredError(event, newIncident, true, fingerprint, prediction || newIncident.diagnostics?.ml_diagnosis, locationData);
        return resObj;
      }
    } catch (err) {
      console.error('[Correlator] DB correlation error, falling back to in-memory:', err.message);
    }
  }

  // Case B: Standalone / Mock fallback mode
  const key = `${projectId}:${primaryHash}`;
  const existing = inMemoryIncidents.get(key);

  let result;
  if (existing && existing.status !== INCIDENT_STATUS.RESOLVED && (eventTime - existing.lastSeen) <= DEDUPE_WINDOW_MS) {
    existing.eventCount += 1;
    existing.lastSeen = eventTime;

    // Upgrade severity if incoming event is higher priority
    const currentRank = SEVERITY_RANK[existing.severity] || 2;
    const incomingRank = SEVERITY_RANK[event.severity] || 2;
    let severityUpgraded = false;
    if (incomingRank > currentRank) {
      existing.severity = event.severity;
      severityUpgraded = true;
      existing.timeline.push({
        timestamp: eventTime,
        action: 'SEVERITY_UPGRADED',
        actor: 'CORRELATOR',
        message: `Severity elevated to ${event.severity} due to incoming high-priority alert`,
        metadata: { trace_id: event.trace_id }
      });
    }

    // Surge milestone
    if ([10, 50, 100, 500, 1000].includes(existing.eventCount)) {
      existing.timeline.push({
        timestamp: eventTime,
        action: 'EVENT_SURGE',
        actor: 'CORRELATOR',
        message: `Event storm milestone reached: ${existing.eventCount} occurrences correlated`,
        metadata: { count: existing.eventCount }
      });
    }

    if (existing.evidence.length < 10) existing.evidence.push(evidenceItem);

    let prediction = existing.diagnostics?.ml_diagnosis || null;
    if (severityUpgraded || !prediction) {
      prediction = await classifyIncidentRisk(event, existing).catch(() => null);
    }

    result = { incident: existing, isNew: false, fingerprint };
    logMonitoredError(event, result.incident, result.isNew, result.fingerprint, prediction || existing.diagnostics?.ml_diagnosis, locationData);
    return result;
  } else {
    const mockIncident = {
      _id: `mock-inc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      projectId,
      primaryHash,
      title,
      service: event.service || 'unknown-service',
      environment: event.env || 'production',
      releaseSha: event.release_sha || 'unknown',
      repoUrl: event.repo_url || null,
      status: INCIDENT_STATUS.OPEN,
      severity: event.severity || 'error',
      eventCount: 1,
      firstSeen: eventTime,
      lastSeen: eventTime,
      timeline: [
        {
          timestamp: eventTime,
          action: 'INCIDENT_CREATED',
          actor: 'CORRELATOR',
          message: `Incident created from telemetry fingerprint ${primaryHash}`,
          metadata: { trace_id: event.trace_id }
        }
      ],
      evidence: [evidenceItem]
    };
    inMemoryIncidents.set(key, mockIncident);

    const prediction = await classifyIncidentRisk(event, mockIncident).catch(() => null);
    result = { incident: mockIncident, isNew: true, fingerprint };
    logMonitoredError(event, result.incident, result.isNew, result.fingerprint, prediction, locationData);
    return result;
  }
}

/**
 * Pretty-prints incoming monitored telemetry errors to the backend console
 */
function logMonitoredError(event, incident, isNew, fingerprint, prediction, locationData) {
  const severity = (event.severity || incident.severity || 'error').toLowerCase();
  const severityBadge = {
    critical: '🚨 [CRITICAL]',
    error: '❌ [ERROR]',
    warning: '⚠️ [WARNING]',
    info: 'ℹ️ [INFO]'
  }[severity] || '❌ [ERROR]';

  const actionTag = isNew 
    ? '🔥 NEW INCIDENT OPENED' 
    : `🔄 CORRELATED (Occurrence #${incident.eventCount})`;

  const message = event.tags?.message || event.tags?.error || incident.title || 'Unknown telemetry event';
  const service = event.service || incident.service || 'unknown-service';
  const env = event.env || incident.environment || 'production';
  const traceId = event.trace_id || 'N/A';
  const hash = fingerprint?.primaryHash || incident.primaryHash || 'N/A';

  console.log('\n=================== 📊 BACKEND INCIDENT MONITOR ===================');
  console.log(`${severityBadge} ${actionTag}`);
  console.log(`📍 Service:     ${service} [${env}]`);
  console.log(`📌 Error:       ${message}`);
  console.log(`🆔 Trace ID:    ${traceId}`);
  console.log(`🔑 Fingerprint: ${hash}`);
  console.log(`📋 Incident:    ${incident.title} (Status: ${incident.status})`);

  // --- Display Origin Geo from LocationService ---
  const geo = locationData || incident.evidence?.[incident.evidence.length - 1]?.location;
  if (geo) {
    const city = geo.city_name || geo.city || 'New Delhi';
    const region = geo.region_name || geo.region || 'Delhi NCR';
    const country = geo.country_name || geo.country || 'India';
    const ip = geo.ip || event.tags?.client_ip || event.tags?.ip || '127.0.0.1';
    console.log(`🌍 Origin Geo:  ${city}, ${region} (${country}) [IP: ${ip}]`);
  }

  // --- Display ML Risk Classifier Model Prediction ---
  const ml = prediction || incident.diagnostics?.ml_diagnosis;
  if (ml) {
    const riskBadge = {
      CRITICAL: '🚨 CRITICAL',
      HIGH: '⚠️ HIGH',
      MEDIUM: '⚡ MEDIUM',
      LOW: '✅ LOW'
    }[ml.risk_level] || ml.risk_level;

    console.log(`🧠 ML Model:    ${riskBadge} (Risk Score: ${Number(ml.risk_score).toFixed(3)}, Confidence: ${(Number(ml.confidence) * 100).toFixed(1)}%)`);
    if (ml.probabilities) {
      const probStr = Object.entries(ml.probabilities)
        .map(([k, v]) => `${k}: ${(Number(v) * 100).toFixed(1)}%`)
        .join(' | ');
      console.log(`📊 Prob Model:  ${probStr}`);
    }
    if (ml.risk_level === 'HIGH' || ml.risk_level === 'CRITICAL') {
      console.log(`🤖 Auto-Action: Triggered Autonomous AST Investigation (Qwen3-Coder 30B)`);
    } else {
      console.log(`🛡️ Auto-Action: Telemetry Stream Monitored (Within safe thresholds)`);
    }
  }

  if (event.tags && Object.keys(event.tags).length > 0) {
    const extraTags = Object.entries(event.tags)
      .filter(([k]) => k !== 'message' && k !== 'error')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    if (extraTags) {
      console.log(`🏷️ Tags:        ${extraTags}`);
    }
  }

  if (event.stack && Array.isArray(event.stack) && event.stack.length > 0) {
    const topFrame = event.stack[0];
    const frameStr = typeof topFrame === 'string' 
      ? topFrame 
      : `${topFrame.function || '<anonymous>'} (${topFrame.file || 'unknown'}:${topFrame.line || 0}:${topFrame.column || 0})`;
    console.log(`🔍 Stack Top:   ${frameStr}`);
  } else if (typeof event.stack === 'string' && event.stack.trim().length > 0) {
    const topLine = event.stack.trim().split('\n')[0];
    console.log(`🔍 Stack Top:   ${topLine}`);
  }
  console.log('===================================================================\n');
}

/**
 * Gets active in-memory incidents (used for mock API testing)
 */
export function getInMemoryIncidents(projectId) {
  return Array.from(inMemoryIncidents.values()).filter(inc => !projectId || inc.projectId === projectId);
}
