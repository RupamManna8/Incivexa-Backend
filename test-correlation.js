import assert from 'assert';
import { normalizeMessage, normalizeStackTrace, computeFingerprint } from './shared/fingerprint.js';
import { correlateEvent, getInMemoryIncidents } from './processor/correlator.js';
import { INCIDENT_STATUS } from './models/Incident.js';

console.log('====================================================');
console.log('🧪 Running Module 2: Correlation & State Tests');
console.log('====================================================\n');

// -----------------------------------------------------------
// TEST 1: Log Template Normalization (Drain3-style mining)
// -----------------------------------------------------------
console.log('▶ Test 1: Log Template Mining & Parameter Stripping...');
const rawMsg1 = 'Failed connection to DB replica 192.168.1.45 for user 109283 with token 0xdeadbeef';
const rawMsg2 = 'Failed connection to DB replica 10.0.0.12 for user 449102 with token 0xcafe1234';
const norm1 = normalizeMessage(rawMsg1);
const norm2 = normalizeMessage(rawMsg2);

console.log(`  Raw 1:  "${rawMsg1}"`);
console.log(`  Norm 1: "${norm1}"`);
console.log(`  Norm 2: "${norm2}"`);

assert.strictEqual(norm1, norm2, 'Normalized templates must match across dynamic parameters');
console.log('  ✔ Log template mining passed!\n');

// -----------------------------------------------------------
// TEST 2: Stack Trace Normalization
// -----------------------------------------------------------
console.log('▶ Test 2: Stack Trace Normalization across line numbers and paths...');
const stackA = [
  { file: 'C:\\Users\\HP\\src\\services\\checkout.js', line: 104, column: 12, function: 'processPayment' },
  { file: 'C:\\Users\\HP\\src\\routes\\api.js', line: 45, column: 8, function: 'handleCheckout' }
];

const stackB = [
  { file: '/var/app/services/checkout.js', line: 189, column: 2, function: 'processPayment' },
  { file: '/var/app/routes/api.js', line: 99, column: 1, function: 'handleCheckout' }
];

const normStackA = normalizeStackTrace(stackA);
const normStackB = normalizeStackTrace(stackB);

console.log(`  Norm Stack A: "${normStackA}"`);
console.log(`  Norm Stack B: "${normStackB}"`);

assert.strictEqual(normStackA, normStackB, 'Stack signatures must match regardless of line numbers or absolute paths');
console.log('  ✔ Stack trace normalization passed!\n');

// -----------------------------------------------------------
// TEST 3: Deterministic Fingerprint Generation
// -----------------------------------------------------------
console.log('▶ Test 3: Fingerprint Generation...');
const eventA = {
  service: 'payment-service',
  tags: { message: 'Database connection pool timeout on replica 01' },
  stack: stackA
};

const eventB = {
  service: 'payment-service',
  tags: { message: 'Database connection pool timeout on replica 09' },
  stack: stackB
};

const fpA = computeFingerprint(eventA);
const fpB = computeFingerprint(eventB);

console.log(`  Fingerprint A: Hash=${fpA.primaryHash} | Title="${fpA.title}"`);
console.log(`  Fingerprint B: Hash=${fpB.primaryHash} | Title="${fpB.title}"`);

assert.strictEqual(fpA.primaryHash, fpB.primaryHash, 'Fingerprint hashes must match for the same root cause');
console.log('  ✔ Deterministic fingerprinting passed!\n');

// -----------------------------------------------------------
// TEST 4: Alert Storm Deduplication (50 noisy events -> 1 incident)
// -----------------------------------------------------------
console.log('▶ Test 4: Alert Storm Deduplication Simulation (50 events)...');

async function testAlertStorm() {
  const projectId = '64f01234567890abcdef1234';
  const TOTAL_EVENTS = 50;

  for (let i = 1; i <= TOTAL_EVENTS; i++) {
    const stormEvent = {
      projectId,
      trace_id: `trace-storm-${i}-${Math.random().toString(36).substring(7)}`,
      service: 'payment-service',
      env: 'production',
      severity: i === 25 ? 'critical' : 'error', // Event 25 spikes to critical
      tags: {
        message: `Database connection pool timeout on replica ${i % 5}`
      },
      stack: [
        { file: 'd:\\app\\services\\checkout.js', line: 100 + i, column: 4, function: 'processPayment' }
      ],
      timestamp: new Date().toISOString()
    };

    const { incident, isNew } = await correlateEvent(stormEvent);
    if (i === 1) {
      assert.strictEqual(isNew, true, 'First event must open a new incident');
      assert.strictEqual(incident.eventCount, 1);
    } else {
      assert.strictEqual(isNew, false, 'Subsequent events must correlate to existing incident');
    }
  }

  // Retrieve correlated incident
  const incidents = getInMemoryIncidents(projectId);
  const paymentIncident = incidents.find(inc => inc.service === 'payment-service');

  console.log(`  Total Raw Events Sent: ${TOTAL_EVENTS}`);
  console.log(`  Total Incidents Created: ${incidents.length}`);
  console.log(`  Correlated Incident Event Count: ${paymentIncident.eventCount}`);
  console.log(`  Final Severity: ${paymentIncident.severity}`);
  console.log(`  Timeline Events Recorded: ${paymentIncident.timeline.length}`);
  console.log(`  Evidence Samples Captured: ${paymentIncident.evidence.length}`);

  assert.strictEqual(paymentIncident.eventCount, TOTAL_EVENTS, `Incident must have aggregated all ${TOTAL_EVENTS} events`);
  assert.strictEqual(paymentIncident.severity, 'critical', 'Incident severity must have been upgraded to critical');
  assert(paymentIncident.timeline.length >= 2, 'Timeline must include creation and milestone/severity transitions');

  const compressionRatio = TOTAL_EVENTS / 1;
  console.log(`  ⚡ Alert-to-Incident Compression Ratio: ${compressionRatio}:1 (100% deduplication)`);
  console.log('  ✔ Alert storm deduplication passed!\n');
}

testAlertStorm().then(() => {
  console.log('====================================================');
  console.log('🎉 ALL MODULE 2 TESTS COMPLETED SUCCESSFULLY!');
  console.log('====================================================');
  process.exit(0);
}).catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
