// k6 read scenario for GET /api/v1/villages: name search, governorate filter and pagination.
// Measures only: the thresholds below never fail, they exist so k6 reports numbers per request kind.
//
// Env: BASE_URL (default http://localhost:3000), VUS (20), DURATION (60s),
//      RESULT_FILE (e.g. /scripts/results/<name>.json; a .txt summary is written next to it),
//      LABEL and DATASET (free text copied into the summary).

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '60s';
const RESULT_FILE = __ENV.RESULT_FILE || '';
const LABEL = __ENV.LABEL || 'run';
const DATASET = __ENV.DATASET || 'not recorded';

// Terms from the vocabulary in k6/data/generate-villages.ts, plus a few real village names.
const SEARCH_TERMS = ['الزيتون', 'بيت', 'كفر الرمان', 'الشرقية', 'Deir', 'beit', 'zaytun', 'al-sharqiya', 'بيتا', 'Sebastia'];
// Spellings that exist only in village_names, so they can only match through the alternate-name lookup.
const ALT_NAME_TERMS = ['Bayt', 'Kfar', 'Dayr', 'Khirbat', 'Jebel'];
// Terms that match nothing: the worst case, every row has to be checked.
const NO_MATCH_TERMS = ['zzqnomatch', 'لاتوجد'];
const GOVERNORATE_IDS = Array.from({ length: 16 }, (_, i) => `01000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const MAX_PAGE = 500;

// Request mix, by weight.
const KINDS = [
  ['search', 35],
  ['search_alt_name', 15],
  ['search_no_match', 10],
  ['governorate', 15],
  ['page', 15],
  ['governorate_search', 10],
];
const TOTAL_WEIGHT = KINDS.reduce((sum, [, weight]) => sum + weight, 0);

const perKind = (metric, expression) =>
  Object.fromEntries(KINDS.map(([kind]) => [`${metric}{kind:${kind}}`, [expression]]));

export const options = {
  scenarios: {
    village_search: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  thresholds: {
    ...perKind('http_req_duration', 'max>=0'),
    ...perKind('http_req_failed', 'rate>=0'),
    ...perKind('http_reqs', 'count>=0'),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function pickKind() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const [kind, weight] of KINDS) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return KINDS[0][0];
}

function buildQuery(kind) {
  switch (kind) {
    case 'search':
      return { search: pick(SEARCH_TERMS) };
    case 'search_alt_name':
      return { search: pick(ALT_NAME_TERMS) };
    case 'search_no_match':
      return { search: pick(NO_MATCH_TERMS) };
    case 'governorate':
      return { governorateId: pick(GOVERNORATE_IDS) };
    case 'page':
      return { page: 1 + Math.floor(Math.random() * MAX_PAGE), limit: 20 };
    case 'governorate_search':
      return { governorateId: pick(GOVERNORATE_IDS), search: pick(SEARCH_TERMS) };
    default:
      return {};
  }
}

function toQueryString(query) {
  return Object.entries(query)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

export default function () {
  const kind = pickKind();
  const res = http.get(`${BASE_URL}/api/v1/villages?${toQueryString(buildQuery(kind))}`, {
    tags: { kind, name: `GET /villages (${kind})` },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body has data and meta': (r) => {
      try {
        const body = r.json();
        return Array.isArray(body.data) && typeof body.meta === 'object';
      } catch {
        return false;
      }
    },
  });
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

  const rows = KINDS.map(([kind]) => {
    const d = values(`http_req_duration{kind:${kind}}`);
    const n = values(`http_reqs{kind:${kind}}`).count ?? 0;
    const failed = values(`http_req_failed{kind:${kind}}`).rate;
    return `  ${kind.padEnd(20)} ${String(n).padStart(7)} ${ms(d.avg).padStart(11)} ${ms(d['p(95)']).padStart(11)} ${ms(d.max).padStart(11)} ${percent(failed).padStart(9)}`;
  });

  const text = [
    `k6 village search: ${LABEL}`,
    `  target:   ${BASE_URL}/api/v1/villages`,
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
    `  error rate:  ${percent(values('http_req_failed').rate)}`,
    `  checks ok:   ${percent(values('checks').rate)}`,
    '',
    'per request kind',
    `  ${'kind'.padEnd(20)} ${'requests'.padStart(7)} ${'avg'.padStart(11)} ${'p95'.padStart(11)} ${'max'.padStart(11)} ${'errors'.padStart(9)}`,
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
