import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

const DETECTOR_API_URL = process.env.DETECTOR_API_URL || 'http://localhost:8000';
const INVESTIGATION_API_URL = process.env.INVESTIGATION_API_URL || 'http://localhost:8001';

/**
 * Maps SDK-level severity strings to the log_level format expected
 * by the Incident Detector ML model.
 */
const SEVERITY_TO_LOG_LEVEL = {
  info: 'INFO',
  warning: 'WARN',
  error: 'ERROR',
  critical: 'CRITICAL'
};

/**
 * Extracts the best available message string from a telemetry event's tags,
 * evidence, or stack trace for use as the ML model's input text.
 */
function extractMessage(event, incident) {
  // Prefer the event-level tag message (closest to the original log line)
  if (event.tags?.message) return event.tags.message;
  if (event.tags?.error) return event.tags.error;

  // Fall back to incident title (normalized but still descriptive)
  if (incident?.title) return incident.title;

  // Last resort: reconstruct from top stack frame
  if (Array.isArray(event.stack) && event.stack.length > 0) {
    const frame = event.stack[0];
    return `Error in ${frame.function || 'anonymous'} at ${frame.file || 'unknown'}:${frame.line || 0}`;
  }

  return 'Unknown application error';
}

/**
 * Extracts an HTTP status code from the event's metrics or tags.
 * Returns null if none is found (the Detector API accepts null).
 */
function extractStatusCode(event) {
  if (event.metrics?.status_code) return Number(event.metrics.status_code);
  if (event.tags?.http_status) return Number(event.tags.http_status);
  return null;
}

/**
 * Extracts a dependency name from event tags if present.
 */
function extractDependency(event) {
  return event.tags?.dependency || event.tags?.database || event.tags?.provider || null;
}

/**
 * Calls the Incident Detector's /predict endpoint and enriches
 * the incident document with the ML classification result.
 *
 * This function is designed to be fire-and-forget — it never throws.
 * If the Detector API is unreachable or returns an error, a warning
 * is logged and the incident remains unchanged.
 *
 * @param {object} event    - The raw telemetry event that triggered correlation
 * @param {object} incident - The Mongoose incident document (or in-memory mock)
 * @returns {Promise<void>}
 */
export async function classifyIncidentRisk(event, incident) {
  try {
    const requestBody = JSON.stringify({
      service: event.service || incident.service || 'unknown-service',
      environment: event.env || incident.environment || 'production',
      log_level: SEVERITY_TO_LOG_LEVEL[event.severity] || 'ERROR',
      message: extractMessage(event, incident),
      status_code: extractStatusCode(event),
      dependency: extractDependency(event)
    });

    const url = new URL('/predict', DETECTOR_API_URL);

    const options = {
      hostname: url.hostname,
      port: url.port || 8000,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: 5000
    };

    const prediction = await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON from Detector API: ${data.substring(0, 200)}`));
            }
          } else {
            reject(new Error(`Detector API returned ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Detector API request timed out (5s)'));
      });

      req.write(requestBody);
      req.end();
    });

    // Write ML diagnosis to the incident document
    const mlDiagnosis = {
      risk_level: prediction.risk_level,
      risk_score: prediction.risk_score,
      confidence: prediction.confidence,
      predicted_class_probability: prediction.predicted_class_probability,
      probabilities: prediction.probabilities,
      classified_at: new Date().toISOString(),
      model_version: 'log-risk-detector-v1'
    };

    const timelineEntry = {
      timestamp: new Date(),
      action: 'RISK_CLASSIFIED',
      actor: 'ML_CLASSIFIER',
      message: `ML risk classification: ${prediction.risk_level} (score: ${prediction.risk_score.toFixed(3)}, confidence: ${(prediction.confidence * 100).toFixed(1)}%)`,
      metadata: {
        risk_level: prediction.risk_level,
        risk_score: prediction.risk_score,
        confidence: prediction.confidence
      }
    };

    // Persist to the incident — handles both Mongoose documents and in-memory mocks
    if (typeof incident.save === 'function') {
      // Mongoose document — Mixed-type fields need markModified for nested mutations
      incident.diagnostics = incident.diagnostics || {};
      incident.diagnostics.ml_diagnosis = mlDiagnosis;
      incident.markModified('diagnostics');
      incident.timeline.push(timelineEntry);
      await incident.save();
    } else {
      // In-memory mock object
      incident.diagnostics = incident.diagnostics || {};
      incident.diagnostics.ml_diagnosis = mlDiagnosis;
      if (Array.isArray(incident.timeline)) {
        incident.timeline.push(timelineEntry);
      }
    }

    console.log(`[Risk-Classifier] ✅ ${incident.title} → ${prediction.risk_level} (score: ${prediction.risk_score.toFixed(3)}, confidence: ${(prediction.confidence * 100).toFixed(1)}%)`);

    // Trigger Investigation Engine for HIGH and CRITICAL risk incidents
    if (prediction.risk_level === 'HIGH' || prediction.risk_level === 'CRITICAL') {
      triggerInvestigation(event, incident);
    }

    return prediction;
  } catch (err) {
    console.warn(`[Risk-Classifier] ⚠️  Classification skipped: ${err.message}`);
    return null;
  }
}

/**
 * Dispatches an asynchronous request to the Investigation Engine.
 */
async function triggerInvestigation(event, incident) {
  try {
    const repoUrl = event.repo_url || incident.repoUrl || process.env.DEFAULT_REPO_URL || process.cwd();
    const commitSha = event.release_sha || incident.releaseSha || 'HEAD';
    const incidentId = incident._id ? incident._id.toString() : (incident.id || 'mock-id');

    const payload = JSON.stringify({
      incident_id: incidentId,
      project_id: incident.projectId ? incident.projectId.toString() : null,
      repo_url: repoUrl,
      commit_sha: commitSha,
      title: incident.title,
      severity: incident.severity || event.severity,
      stack: event.stack || incident.evidence?.[0]?.stack || [],
      error_message: extractMessage(event, incident)
    });

    const url = new URL('/investigate', INVESTIGATION_API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 8001,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let resData = '';
      res.on('data', chunk => { resData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Risk-Classifier] 🔍 Dispatched investigation for incident ${incidentId}`);
        } else {
          console.warn(`[Risk-Classifier] ⚠️ Investigation API returned ${res.statusCode}: ${resData}`);
        }
      });
    });

    req.on('error', (e) => {
      console.warn(`[Risk-Classifier] ⚠️ Could not reach Investigation API: ${e.message}`);
    });
    req.on('timeout', () => {
      req.destroy();
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.warn(`[Risk-Classifier] ⚠️ Failed to trigger investigation: ${err.message}`);
  }
}

