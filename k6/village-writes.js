// k6 write scenario for the village write endpoints (create, update, verify, reject, delete).
// Measures only: the thresholds below never fail, they exist so k6 reports numbers per request kind.
//
// Run it only against a local stack whose API has the village write endpoints, with
// RATE_LIMIT_ENABLED=false, and clean up afterwards with `npm run perf:clean` (it removes the
// perf- villages and their audit rows).
//
// Every created village has a slug starting with "perf-w-" (the prefix perf:clean looks for).
// Each iteration walks one village through its life, so no two VUs ever touch the same row:
//   create -> update -> update -> stale update (409 expected) -> verify -> update -> reject -> delete
// The stale update sends an old `version` on purpose. Its 409 is the correct answer, so it is counted on
// its own (`expected_version_conflicts`) and is NOT an error. A 409 anywhere else, or any other
// unexpected status, is an error.
//
// Env: BASE_URL (default http://localhost:3000), VUS (10), DURATION (60s),
//      ADMIN_EMAIL and ADMIN_PASSWORD (a seeded admin; admin may call every write endpoint),
//      RESULT_FILE (e.g. /scripts/results/<name>.json; a .txt summary is written next to it),
//      LABEL and DATASET (free text copied into the summary).

import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '60s';
const RESULT_FILE = __ENV.RESULT_FILE || '';
const LABEL = __ENV.LABEL || 'run';
const DATASET = __ENV.DATASET || 'not recorded';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL;
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD;

const API = `${BASE_URL}/api/v1`;
const SLUG_PREFIX = 'perf-w-';
const GOVERNORATE_IDS = Array.from({ length: 16 }, (_, i) => `01000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);

const expectedConflicts = new Counter('expected_version_conflicts');
const unexpectedConflicts = new Counter('unexpected_version_conflicts');

// Status codes that are the right answer for each kind of request.
const KINDS = {
  create: [201],
  update: [200],
  stale_update: [409],
  verify: [200],
  reject: [200],
  delete: [204],
};
const KIND_NAMES = Object.keys(KINDS);

const perKind = (metric, expression) => Object.fromEntries(KIND_NAMES.map((kind) => [`${metric}{kind:${kind}}`, [expression]]));

export const options = {
  scenarios: {
    village_writes: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  thresholds: {
    ...perKind('http_req_duration', 'max>=0'),
    ...perKind('http_req_failed', 'rate>=0'),
    ...perKind('http_reqs', 'count>=0'),
    expected_version_conflicts: ['count>=0'],
    unexpected_version_conflicts: ['count>=0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) fail('ADMIN_EMAIL and ADMIN_PASSWORD are required');

  const res = http.post(`${API}/auth/login`, JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status !== 200) fail(`login failed with status ${res.status}`);

  return { token: res.json('accessToken') };
}

function send(method, path, token, body, kind) {
  const expected = KINDS[kind];
  const res = http.request(method, `${API}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    tags: { kind, name: `${method} /villages (${kind})` },
    // Only the listed statuses count as success; everything else is a failed request in the metrics.
    responseCallback: http.expectedStatuses(...expected),
  });

  const ok = check(res, { [`${kind}: status is ${expected.join(' or ')}`]: (r) => expected.includes(r.status) });
  if (res.status === 409) (kind === 'stale_update' ? expectedConflicts : unexpectedConflicts).add(1);

  return ok ? res : null;
}

export default function (data) {
  const { token } = data;
  const slug = `${SLUG_PREFIX}${__VU}-${__ITER}-${Date.now()}`;

  const created = send(
    'POST',
    '/villages',
    token,
    { slug, nameAr: `قرية أداء ${slug}`, nameEn: `Perf ${slug}`, governorateId: GOVERNORATE_IDS[__ITER % GOVERNORATE_IDS.length] },
    'create',
  );
  if (!created) return;
  const id = created.json('data.id');
  let version = created.json('data.version');

  // Two normal updates; each one bumps the version.
  for (const field of ['locationDescription', 'historicalOverview']) {
    const updated = send('PATCH', `/villages/${id}`, token, { version, [field]: `k6 ${field} ${__ITER}` }, 'update');
    if (!updated) return;
    version = updated.json('data.version');
  }

  // A stale version on purpose: the right answer is 409, and nothing is written.
  send('PATCH', `/villages/${id}`, token, { version: version - 1, nameEn: 'stale' }, 'stale_update');

  const verified = send('POST', `/villages/${id}/verify`, token, { version }, 'verify');
  if (!verified) return;
  version = verified.json('data.version');

  // An edit sends a verified village back to PENDING, then it is rejected, then deleted (soft delete).
  const edited = send('PATCH', `/villages/${id}`, token, { version, nameEn: `Perf edited ${slug}` }, 'update');
  if (!edited) return;
  version = edited.json('data.version');

  const rejected = send('POST', `/villages/${id}/reject`, token, { version }, 'reject');
  if (!rejected) return;

  send('DELETE', `/villages/${id}`, token, undefined, 'delete');
}

function ms(value) {
  return value === undefined ? '-' : `${value.toFixed(1)} ms`;
}

function percent(value) {
  return value === undefined ? '-' : `${(value * 100).toFixed(2)} %`;
}

export function handleSummary(data) {
  const values = (name) => data.metrics[name]?.values ?? {};
  const duration = values('http_req_duration');
  const requests = values('http_reqs');

  const rows = KIND_NAMES.map((kind) => {
    const d = values(`http_req_duration{kind:${kind}}`);
    const n = values(`http_reqs{kind:${kind}}`).count ?? 0;
    const failed = values(`http_req_failed{kind:${kind}}`).rate;
    return `  ${kind.padEnd(14)} ${String(n).padStart(7)} ${ms(d.avg).padStart(11)} ${ms(d['p(95)']).padStart(11)} ${ms(d.max).padStart(11)} ${percent(failed).padStart(9)}`;
  });

  const text = [
    `k6 village writes: ${LABEL}`,
    `  target:   ${API}/villages (create, update, verify, reject, delete)`,
    `  load:     ${VUS} VUs, ${DURATION} (constant-vus)`,
    `  dataset:  ${DATASET}`,
    '',
    'overall',
    `  requests:    ${requests.count ?? 0}`,
    `  throughput:  ${(requests.rate ?? 0).toFixed(2)} req/s`,
    `  avg:         ${ms(duration.avg)}`,
    `  p95:         ${ms(duration['p(95)'])}`,
    `  p99:         ${ms(duration['p(99)'])}`,
    `  max:         ${ms(duration.max)}`,
    `  error rate:  ${percent(values('http_req_failed').rate)}   (unexpected statuses only; the stale_update 409s are expected)`,
    `  checks ok:   ${percent(values('checks').rate)}`,
    '',
    'version conflicts (409)',
    `  expected (stale_update, on purpose):  ${values('expected_version_conflicts').count ?? 0}`,
    `  unexpected (anywhere else):           ${values('unexpected_version_conflicts').count ?? 0}`,
    '',
    'per request kind',
    `  ${'kind'.padEnd(14)} ${'requests'.padStart(7)} ${'avg'.padStart(11)} ${'p95'.padStart(11)} ${'max'.padStart(11)} ${'errors'.padStart(9)}`,
    ...rows,
    '',
  ].join('\n');

  const outputs = { stdout: text };
  if (RESULT_FILE) {
    outputs[RESULT_FILE] = JSON.stringify(data, null, 2);
    outputs[RESULT_FILE.replace(/\.json$/, '.txt')] = text;
  }
  return outputs;
}
