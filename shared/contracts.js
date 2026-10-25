import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, useDefaults: true });

export const EventEnvelopeSchema = {
  type: 'object',
  properties: {
    trace_id: { type: 'string' },
    service: { type: 'string' },
    env: { type: 'string' },
    release_sha: { type: ['string', 'null'] },
    repo_url: { type: ['string', 'null'] },
    branch: { type: ['string', 'null'] },
    severity: { type: 'string', enum: ['info', 'warning', 'error', 'critical'] },
    stack: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          column: { type: 'integer' },
          function: { type: 'string' }
        },
        required: ['file', 'line']
      }
    },
    metrics: { type: 'object' },
    tags: { type: 'object' },
    timestamp: { type: 'string' }
  },
  required: ['trace_id', 'service', 'env', 'severity']
};

const validateEventEnvelope = ajv.compile(EventEnvelopeSchema);

/**
 * Validates an event payload against the EventEnvelopeSchema.
 * @param {object} payload - The event payload to validate.
 * @returns {{ valid: boolean, errors: null|Array }}
 */
export function validateEvent(payload) {
  const valid = validateEventEnvelope(payload);
  return {
    valid,
    errors: valid ? null : validateEventEnvelope.errors
  };
}
