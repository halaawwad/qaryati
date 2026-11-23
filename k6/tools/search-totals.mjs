// Records, for a fixed list of village-list queries, meta.total and a hash of the ids on pages 1 and 2.
// Run it before each k6 measurement and diff the outputs: the numbers must be identical, otherwise a change
// altered what the search returns (a different set of villages, or the same set in a different order).
// The list includes the % and _ wildcard cases on purpose: they must behave exactly as before.
//
// Usage: node k6/tools/search-totals.mjs <output-file>
// Env:   BASE (default http://localhost:3000/api/v1)
//
// The governorate ids are the seeded ones (01000000-0000-4000-8000-0000000000NN). The data must be the
// synthetic data from `npm run perf:data -- --count=20000 --seed=1`, otherwise the numbers are different but
// still comparable between runs on the same data.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3000/api/v1';
const out = process.argv[2];

const SEARCH = ['الزيتون', 'بيت', 'كفر الرمان', 'الشرقية', 'Deir', 'beit', 'zaytun', 'al-sharqiya', 'بيتا', 'Sebastia'];
const ALT = ['Bayt', 'Kfar', 'Dayr', 'Khirbat', 'Jebel'];
const NOMATCH = ['zzqnomatch', 'لاتوجد'];
const WILDCARDS = ['%', '_', 'bei_', '100%', 'a\\b'];
const GOVS = ['01000000-0000-4000-8000-000000000001', '01000000-0000-4000-8000-000000000004', '01000000-0000-4000-8000-000000000011'];

const queries = [];
for (const s of [...SEARCH, ...ALT, ...NOMATCH, ...WILDCARDS, '  beit  ']) queries.push({ search: s });
for (const g of GOVS) {
  queries.push({ governorateId: g });
  queries.push({ governorateId: g, search: 'بيت' });
  queries.push({ governorateId: g, search: 'Bayt' });
}
queries.push({ search: 'بيت', sort: 'nameEn', order: 'desc' });
queries.push({ search: 'Deir', sort: 'areaDunums', order: 'asc' });
queries.push({ search: 'Kfar', sort: 'createdAt', order: 'desc' });
queries.push({ search: 'بيت', verificationStatus: 'PENDING' });
queries.push({ verificationStatus: 'VERIFIED' });
queries.push({});

const qs = (q) =>
  Object.entries(q)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

async function get(q, page) {
  const res = await fetch(`${BASE}/villages?${qs({ ...q, page, limit: 20 })}`, { headers: { connection: 'close' } });
  const json = await res.json();
  return { status: res.status, total: json?.meta?.total, ids: (json?.data ?? []).map((v) => v.id) };
}
const hash = (ids) => createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 10);

const lines = [];
for (const q of queries) {
  const p1 = await get(q, 1);
  const p2 = await get(q, 2);
  lines.push(`${JSON.stringify(q)}\tstatus=${p1.status}\ttotal=${p1.total}\tp1=${p1.ids.length}:${hash(p1.ids)}\tp2=${p2.ids.length}:${hash(p2.ids)}`);
}
const text = lines.join('\n') + '\n';
if (out) writeFileSync(out, text);
console.log(`${lines.length} queries`);
