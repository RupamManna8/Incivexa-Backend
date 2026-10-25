import crypto from 'crypto';

/**
 * Normalization & Log Template Mining Engine
 * Collapses noisy dynamic parameters (line numbers, UUIDs, IDs, IPs, timestamps)
 * into stable, deterministic hashes.
 */

// Regex patterns for dynamic parameters
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_REGEX = /\b0x[0-9a-f]+\b|\b[0-9a-f]{24,64}\b/gi;
const IP_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const NUM_REGEX = /\b\d+\b/g;
const PATH_REGEX = /(?:[A-Za-z]:[\\/]|(?:\/[a-zA-Z0-9._-]+)+)[\\/][a-zA-Z0-9._-]+/g;

/**
 * Normalizes a log message or error message by masking dynamic variables.
 * @param {string} message 
 * @returns {string} Normalized template
 */
export function normalizeMessage(message) {
  if (!message || typeof message !== 'string') return 'Unknown error';

  let normalized = message;
  normalized = normalized.replace(UUID_REGEX, '<UUID>');
  normalized = normalized.replace(HEX_REGEX, '<HEX>');
  normalized = normalized.replace(IP_REGEX, '<IP>');
  normalized = normalized.replace(PATH_REGEX, (match) => {
    // Keep only the filename
    const parts = match.split(/[\\/]/);
    return '<PATH>/' + (parts[parts.length - 1] || '');
  });
  normalized = normalized.replace(NUM_REGEX, '<NUM>');
  return normalized.trim();
}

/**
 * Normalizes a stack trace by stripping variable line/column numbers
 * and retaining stable function names and source filenames.
 * @param {Array<{ file: string, function?: string, line?: number, column?: number }>} stack 
 * @returns {string} Normalized stack signature
 */
export function normalizeStackTrace(stack) {
  if (!Array.isArray(stack) || stack.length === 0) {
    return '';
  }

  // Filter out node internals or generic vendor wrappers if applicable, taking top 5 in-app frames
  const frames = stack.slice(0, 5).map(frame => {
    const fn = (frame.function || 'anonymous').trim();
    let file = (frame.file || 'unknown').trim();

    // Strip full absolute file paths down to relative basename
    const fileParts = file.split(/[\\/]/);
    const baseFile = fileParts.slice(-2).join('/'); // e.g. "routes/checkout.js"

    return `${fn}@${baseFile}`;
  });

  return frames.join(' -> ');
}

/**
 * Computes a deterministic SHA-256 fingerprint from a telemetry event.
 * @param {object} event 
 * @returns {{ primaryHash: string, title: string, signature: string }}
 */
export function computeFingerprint(event) {
  const service = event.service || 'default-service';
  const rawMessage = event.tags?.message || event.tags?.error || event.error || (event.stack?.[0]?.function ? `Error in ${event.stack[0].function}` : 'Unhandled Application Event');
  const normalizedMsg = normalizeMessage(rawMessage);
  const normalizedStack = normalizeStackTrace(event.stack);

  // Construct canonical signature
  const signature = `${service}|${normalizedMsg}|${normalizedStack}`;

  // Generate SHA-256 hash
  const primaryHash = crypto
    .createHash('sha256')
    .update(signature)
    .digest('hex')
    .substring(0, 16); // 16-character hex fingerprint

  // Formulate concise human-readable incident title
  const title = `[${service}] ${normalizedMsg.substring(0, 100)}`;

  return {
    primaryHash,
    title,
    signature
  };
}
