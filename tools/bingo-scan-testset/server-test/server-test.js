// Tests the /api/training endpoint (htdocs/api/training.php) against a real PHP server and a MySQL-compatible database.
// It uploads samples, checks them in the database, and exercises every validation rule, the limits and the admin routes.
//
// Setup (see README.md): a database with the site's schema, a PHP server on BASE, a second PHP server on CAP_BASE started
// with TRAINING_TEST_CAP set to a small number of bytes, an admin and a regular user with session tokens, and the images
// from make-fixtures.py. Settings come from environment variables:
//   BASE, CAP_BASE, ADMIN_TOKEN, PLAIN_TOKEN, NOPASS_TOKEN, FIXTURES, MARIADB (path to the client), DBPORT, DBNAME
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const env = k => { if (!process.env[k]) { console.log('Missing environment variable ' + k); process.exit(2); } return process.env[k]; };
const BASE = env('BASE'), CAP_BASE = env('CAP_BASE');
const ADMIN = env('ADMIN_TOKEN'), PLAIN = env('PLAIN_TOKEN'), NOPASS = env('NOPASS_TOKEN');
const FIX = env('FIXTURES'), MARIADB = env('MARIADB'), DBPORT = env('DBPORT'), DBNAME = env('DBNAME');

const b64 = name => fs.readFileSync(path.join(FIX, name)).toString('base64');
const sql = query => execFileSync(MARIADB, ['--no-defaults', '-h127.0.0.1', '-P' + DBPORT, '-uroot', DBNAME, '-N', '-B', '-e', query], { encoding: 'utf8' }).trim();

let failed = 0, checks = 0;
const t = (name, ok, detail) => { checks++; if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : '')); };

const RANGES = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
let counter = 0;
const uuid = () => {
  counter++;
  const hex = n => n.toString(16).padStart(12, '0');
  return `${(0xabcd0000 + counter).toString(16)}-1111-4222-8333-${hex(counter + 0x100000)}`;
};

// A valid sample; `over` replaces fields, and a field set to undefined is removed
function sample(over = {}) {
  const shift = counter % 10;
  const cells = [];
  for (let i = 0; i < 25; i++) {
    if (i === 12) { cells.push({ label: null, predicted: null, score: null, corrected: false, covered: false, glare: false }); continue; }
    const [lo] = RANGES[i % 5];
    const label = lo + Math.floor(i / 5) + shift;           // distinct inside the column and inside the range
    cells.push({ label, predicted: i % 7 === 0 ? label + 1 : label, score: 0.5 + (i % 5) / 10, corrected: i % 7 === 0, covered: false, glare: i === 3 });
  }
  const s = {
    schema: 1, id: uuid(), createdAt: new Date().toISOString(), appVersion: '2.1', profile: 'slider',
    reader: { id: 'tesseract', version: '4.1.4/eng-best_int' }, device: 'Chrome 130 / Android; 412x915@2.6',
    cells, meta: { profileScores: { slider: 22.5 }, geometry: { windows: 24, err: 0.017 }, versions: { ocr: '2.2' } },
    sheet: b64('sheet_ok.jpg')
  };
  Object.assign(s, over);
  for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
  return s;
}

async function call(method, url, { body, token, raw, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { method, headers: h, body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* no body */ }
  return { status: res.status, json, text, headers: res.headers };
}
const post = (body, token, base = BASE) => call('POST', `${base}/api/training`, { body, token });

(async () => {
  sql('DELETE FROM bingo_scan_samples');

  // ---------- Upload: the happy path ----------
  const s1 = sample();
  let r = await post(s1);
  t('upload: a valid sample is stored (201)', r.status === 201 && r.json.stored === true && r.json.id === s1.id, r.status + ' ' + r.text.slice(0, 120));
  t('upload: it is in the database with status new', sql(`SELECT status FROM bingo_scan_samples WHERE id='${s1.id}'`) === 'new');
  t('upload: the sheet bytes are stored exactly (JPEG, same length)', sql(`SELECT LENGTH(sheet) FROM bingo_scan_samples WHERE id='${s1.id}'`) === String(fs.statSync(path.join(FIX, 'sheet_ok.jpg')).size));
  t('upload: the sheet starts with the JPEG marker', sql(`SELECT HEX(SUBSTRING(sheet,1,3)) FROM bingo_scan_samples WHERE id='${s1.id}'`) === 'FFD8FF');
  t('upload: no photo unless one was sent', sql(`SELECT photo IS NULL FROM bingo_scan_samples WHERE id='${s1.id}'`) === '1');
  const row = sql(`SELECT profile, reader, app_version, device, uploaded_by IS NULL, schema_ver, created_at FROM bingo_scan_samples WHERE id='${s1.id}'`).split('\t');
  t('upload: profile, reader, app version and device are recorded', row[0] === 'slider' && row[1] === 'tesseract@4.1.4/eng-best_int' && row[2] === '2.1' && row[3].startsWith('Chrome 130'), row.join(' | '));
  t('upload: a guest upload has no username', row[4] === '1');
  const cellsBack = JSON.parse(sql(`SELECT cells FROM bingo_scan_samples WHERE id='${s1.id}'`));
  t('upload: all 25 cells are stored with labels, predictions and flags', cellsBack.length === 25 && cellsBack[12].label === null && cellsBack[0].label === 1 && cellsBack[0].corrected === true && cellsBack[3].glare === true, JSON.stringify(cellsBack[0]));
  const metaBack = JSON.parse(sql(`SELECT meta FROM bingo_scan_samples WHERE id='${s1.id}'`));
  t('upload: meta is stored as given', metaBack.geometry.windows === 24 && metaBack.versions.ocr === '2.2');
  const ipHash = sql(`SELECT ip_hash FROM bingo_scan_samples WHERE id='${s1.id}'`);
  t('upload: the client address is stored only as a 64-character hash', /^[0-9a-f]{64}$/.test(ipHash) && !sql(`SELECT * FROM bingo_scan_samples WHERE id='${s1.id}'`).includes('127.0.0.1'));

  // ---------- Upload: same id again, photo, signed-in user ----------
  r = await post(s1);
  t('upload: sending the same sample again is accepted without storing it twice (200, duplicate)', r.status === 200 && r.json.duplicate === true && sql('SELECT COUNT(*) FROM bingo_scan_samples') === '1', r.status + ' ' + r.text.slice(0, 100));

  const s2 = sample({ photo: b64('photo_ok.jpg') });
  r = await post(s2);
  t('photo: a photo under 300 KB is stored', r.status === 201 && sql(`SELECT LENGTH(photo) FROM bingo_scan_samples WHERE id='${s2.id}'`) === String(fs.statSync(path.join(FIX, 'photo_ok.jpg')).size), r.status + ' ' + r.text.slice(0, 120));
  r = await post(sample({ photo: b64('photo_over.jpg'), sheet: b64('sheet_small.jpg') }));
  t('photo: a photo over 300 KB is refused (400)', r.status === 400 && /photo/.test(r.json.error), r.status + ' ' + r.text.slice(0, 100));
  r = await post(sample({ photo: b64('not_a_jpeg.png') }));
  t('photo: a photo that is not a JPEG is refused (400)', r.status === 400 && /photo/.test(r.json.error), r.text.slice(0, 100));

  const s3 = sample();
  r = await post(s3, PLAIN);
  t('auth: a signed-in upload records the username', r.status === 201 && sql(`SELECT uploaded_by FROM bingo_scan_samples WHERE id='${s3.id}'`) === 'plain_t');
  const s4 = sample();
  r = await post(s4, 'not-a-real-token-0123456789abcdef0123456789');
  t('auth: an invalid token does not block an upload (it counts as a guest)', r.status === 201 && sql(`SELECT uploaded_by IS NULL FROM bingo_scan_samples WHERE id='${s4.id}'`) === '1', r.status + ' ' + r.text.slice(0, 80));

  // ---------- Validation: every rule refuses with 400 and stores nothing ----------
  const before = sql('SELECT COUNT(*) FROM bingo_scan_samples');
  const goodCells = () => sample().cells;
  const bad = async (name, over, pattern) => {
    const res = await post(sample(over));
    t(`validation: ${name}`, res.status === 400 && (!pattern || pattern.test(res.json.error)), `${res.status} ${(res.json && res.json.error) || res.text.slice(0, 80)}`);
  };
  await bad('wrong schema version', { schema: 2 }, /schema/i);
  await bad('missing schema', { schema: undefined }, /schema/i);
  await bad('id that is not a UUID', { id: 'abc' }, /id/i);
  await bad('id with SQL characters', { id: "x'; DROP TABLE bingo_cards;--" }, /id/i);
  await bad('createdAt that is not a date', { createdAt: 'yesterday-ish' }, /createdAt/);
  await bad('app version with letters', { appVersion: 'v2-beta' }, /appVersion/);
  await bad('unknown card profile', { profile: 'hologram' }, /profile/i);
  await bad('reader missing', { reader: undefined }, /reader/);
  await bad('reader with odd characters', { reader: { id: '<script>', version: '1' } }, /reader/);
  await bad('device that is not text', { device: 42 }, /device/);
  await bad('only 24 cells', { cells: goodCells().slice(0, 24) }, /25/);
  await bad('cells that are not a list', { cells: { 0: {} } }, /25/);
  await bad('a label outside its column range', { cells: goodCells().map((c, i) => (i === 0 ? Object.assign({}, c, { label: 16 }) : c)) }, /range/);
  await bad('a label that is not a whole number', { cells: goodCells().map((c, i) => (i === 1 ? Object.assign({}, c, { label: '17' }) : c)) }, /label/);
  await bad('a label on the FREE space', { cells: goodCells().map((c, i) => (i === 12 ? Object.assign({}, c, { label: 38 }) : c)) }, /FREE/);
  await bad('the same number twice in a column', { cells: goodCells().map((c, i) => (i === 10 ? Object.assign({}, c, { label: goodCells()[0].label }) : c)) }, /more than once/);
  await bad('a prediction that is not 1-75', { cells: goodCells().map((c, i) => (i === 2 ? Object.assign({}, c, { predicted: 99 }) : c)) }, /predicted/);
  await bad('a score above 1', { cells: goodCells().map((c, i) => (i === 2 ? Object.assign({}, c, { score: 1.5 }) : c)) }, /score/);
  await bad('meta that is not an object', { meta: 'text' }, /meta/);
  await bad('meta that is too large', { meta: { blob: 'x'.repeat(30000) } }, /meta/);
  await bad('sheet missing', { sheet: undefined }, /sheet/);
  await bad('sheet that is not base64', { sheet: '***not base64***' }, /sheet/);
  await bad('sheet that is a PNG', { sheet: b64('not_a_jpeg.png') }, /JPEG/);
  await bad('sheet of the wrong size', { sheet: b64('sheet_wrong_size.jpg') }, /360x400/);
  await bad('sheet over 100 KB', { sheet: b64('sheet_big.jpg') }, /100 KB/);
  r = await call('POST', `${BASE}/api/training`, { raw: '{not json' });
  t('validation: a body that is not JSON is refused (400)', r.status === 400, r.status + ' ' + r.text.slice(0, 80));
  r = await call('POST', `${BASE}/api/training`, { raw: '[1,2,3]' });
  t('validation: a JSON list instead of an object is refused (400)', r.status === 400);
  t('validation: nothing refused above was stored', sql('SELECT COUNT(*) FROM bingo_scan_samples') === before);

  r = await call('POST', `${BASE}/api/training`, { raw: JSON.stringify(sample({ photo: b64('photo_big.jpg') })) });
  t('limits: a request body over 450 KB is refused (413)', r.status === 413, r.status + ' ' + r.text.slice(0, 80));

  r = await call('GET', `${BASE}/api/training`);
  t('methods: PUT on the collection is refused (405)', (await call('PUT', `${BASE}/api/training`, { body: {} })).status === 405);
  r = await call('OPTIONS', `${BASE}/api/training`);
  t('cors: the preflight allows PATCH', r.status === 200 && /PATCH/.test(r.headers.get('access-control-allow-methods') || ''), r.headers.get('access-control-allow-methods'));

  // ---------- Admin routes: who may do what ----------
  r = await call('GET', `${BASE}/api/training?stats=1`);
  t('admin: stats without a token is refused (401)', r.status === 401);
  r = await call('GET', `${BASE}/api/training?stats=1`, { token: PLAIN });
  t('admin: stats for a signed-in non-admin is refused (403)', r.status === 403);
  r = await call('GET', `${BASE}/api/training?stats=1`, { token: NOPASS });
  t('admin: an admin profile without a password is refused (403)', r.status === 403);
  r = await call('GET', `${BASE}/api/training`);
  t('admin: the list without a token is refused (401)', r.status === 401);
  r = await call('PATCH', `${BASE}/api/training/${s1.id}`, { body: { status: 'imported' }, token: PLAIN });
  t('admin: changing a status as a non-admin is refused (403)', r.status === 403 && sql(`SELECT status FROM bingo_scan_samples WHERE id='${s1.id}'`) === 'new');
  r = await call('DELETE', `${BASE}/api/training/${s1.id}`, { token: PLAIN });
  t('admin: deleting as a non-admin is refused (403) and nothing is deleted', r.status === 403 && sql('SELECT COUNT(*) FROM bingo_scan_samples WHERE id=\'' + s1.id + '\'') === '1');
  r = await call('POST', `${BASE}/api/training?purge=1`, { body: { ids: [s1.id] } });
  t('admin: purge without a token is refused (401)', r.status === 401);

  // ---------- Admin: stats ----------
  r = await call('GET', `${BASE}/api/training?stats=1`, { token: ADMIN });
  const st = r.json || {};
  const rows = Number(sql('SELECT COUNT(*) FROM bingo_scan_samples'));
  t('stats: count matches the database', r.status === 200 && st.count === rows, `${st.count} vs ${rows}`);
  const bytes = Number(sql('SELECT SUM(LENGTH(sheet)+COALESCE(LENGTH(photo),0)) FROM bingo_scan_samples'));
  t('stats: total image bytes match the database', st.bytes === bytes, `${st.bytes} vs ${bytes}`);
  t('stats: counts by status and profile', st.byStatus && st.byStatus.new === rows && st.byProfile && st.byProfile.slider === rows, JSON.stringify([st.byStatus, st.byProfile]));
  t('stats: one sample carries a photo', st.withPhoto === 1);
  t('stats: per-number label counts are right (number 1 appears in every sample that labeled it)', st.perNumber && st.perNumber['1'] === sql(`SELECT COUNT(*) FROM bingo_scan_samples WHERE JSON_EXTRACT(cells,'$[0].label')=1`) * 1, JSON.stringify(st.perNumber && st.perNumber['1']));
  t('stats: labels counted and user corrections counted', st.labels === rows * 24 && st.labelsCorrectedByUser === rows * 4, `${st.labels}, ${st.labelsCorrectedByUser}`);
  const zeros = Object.keys(st.perNumber || {}).filter(k => st.perNumber[k] === 0).map(Number).sort((a, b) => a - b);
  t('stats: the numbers with no sample are listed exactly (so gaps in the data are visible)', Array.isArray(st.numbersWithNoSample) && JSON.stringify(st.numbersWithNoSample) === JSON.stringify(zeros) && zeros.length > 0 && zeros.length < 75, zeros.length + ' numbers have no sample');
  t('stats: the storage cap and its use are reported', st.capBytes === 150 * 1024 * 1024 && typeof st.capUsed === 'number');

  // ---------- Admin: list and pages ----------
  for (let k = 0; k < 4; k++) await post(sample());
  r = await call('GET', `${BASE}/api/training?limit=3`, { token: ADMIN });
  t('list: a page has the requested number of items', r.status === 200 && r.json.items.length === 3 && !!r.json.next, r.status + ' ' + (r.json && r.json.items && r.json.items.length));
  const it = r.json.items[0];
  t('list: an item carries its fields and the sheet as base64 that decodes to a JPEG', it.id && it.profile === 'slider' && it.cells.length === 25 && it.meta.versions && Buffer.from(it.sheet, 'base64').slice(0, 3).toString('hex') === 'ffd8ff', Object.keys(it).join());
  t('list: guests show uploadedBy null and photo null', it.uploadedBy === null && it.photo === null);
  const seen = new Set(r.json.items.map(x => x.id));
  let cursor = r.json.next, pages = 1, guard = 0;
  while (cursor && guard++ < 20) {
    const p = await call('GET', `${BASE}/api/training?limit=3&since=${encodeURIComponent(cursor)}`, { token: ADMIN });
    p.json.items.forEach(x => { if (seen.has(x.id)) t('list: no sample repeats between pages', false, x.id); seen.add(x.id); });
    cursor = p.json.next; pages++;
  }
  t('list: paging with the cursor visits every sample exactly once', seen.size === Number(sql('SELECT COUNT(*) FROM bingo_scan_samples')) && pages >= 2, `${seen.size} samples in ${pages} pages`);
  r = await call('GET', `${BASE}/api/training?limit=999`, { token: ADMIN });
  t('list: the page size is capped at 25', r.json.items.length <= 25);
  r = await call('GET', `${BASE}/api/training?status=bogus`, { token: ADMIN });
  t('list: an unknown status filter is refused (400)', r.status === 400);
  r = await call('GET', `${BASE}/api/training?since=not-a-date`, { token: ADMIN });
  t('list: an invalid since value is refused (400)', r.status === 400);
  r = await call('GET', `${BASE}/api/training?status=imported`, { token: ADMIN });
  t('list: filtering by a status with no samples gives an empty page', r.status === 200 && r.json.items.length === 0 && r.json.next === null);
  const withPhoto = (await call('GET', `${BASE}/api/training?limit=25&status=all`, { token: ADMIN })).json.items.find(x => x.id === s2.id);
  t('list: a sample with a photo returns it as base64', withPhoto && Buffer.from(withPhoto.photo, 'base64').equals(fs.readFileSync(path.join(FIX, 'photo_ok.jpg'))));
  const byUser = (await call('GET', `${BASE}/api/training?limit=25&status=all`, { token: ADMIN })).json.items.find(x => x.id === s3.id);
  t('list: a signed-in upload shows the username', byUser && byUser.uploadedBy === 'plain_t');

  // ---------- Admin: status, delete, purge ----------
  r = await call('PATCH', `${BASE}/api/training/${s1.id}`, { body: { status: 'imported' }, token: ADMIN });
  t('status: an admin can mark a sample imported', r.status === 200 && r.json.status === 'imported' && sql(`SELECT status FROM bingo_scan_samples WHERE id='${s1.id}'`) === 'imported');
  r = await call('PATCH', `${BASE}/api/training/${s1.id}`, { body: { status: 'weird' }, token: ADMIN });
  t('status: an unknown status is refused (400)', r.status === 400);
  r = await call('PATCH', `${BASE}/api/training/ffffffff-ffff-4fff-8fff-ffffffffffff`, { body: { status: 'new' }, token: ADMIN });
  t('status: an unknown sample is reported (404)', r.status === 404);
  r = await call('GET', `${BASE}/api/training?status=new&limit=25`, { token: ADMIN });
  t('status: the default list no longer includes the imported sample', !r.json.items.some(x => x.id === s1.id));
  await call('PATCH', `${BASE}/api/training/${s2.id}`, { body: { status: 'rejected' }, token: ADMIN });
  t('status: an admin can reject a sample', sql(`SELECT status FROM bingo_scan_samples WHERE id='${s2.id}'`) === 'rejected');

  r = await call('POST', `${BASE}/api/training?purge=1`, { body: { ids: [s1.id, s2.id, s3.id, 'ffffffff-ffff-4fff-8fff-ffffffffffff'] }, token: ADMIN });
  t('purge: only imported samples are deleted', r.status === 200 && r.json.deleted.length === 1 && r.json.deleted[0] === s1.id, r.text.slice(0, 200));
  t('purge: the rest are reported as skipped with a reason', r.json.skipped.length === 3 && r.json.skipped.some(x => x.id === s2.id && /rejected/.test(x.reason)) && r.json.skipped.some(x => x.id === s3.id && /new/.test(x.reason)) && r.json.skipped.some(x => /not found/.test(x.reason)));
  t('purge: the deleted sample is gone and the others remain', sql(`SELECT COUNT(*) FROM bingo_scan_samples WHERE id='${s1.id}'`) === '0' && sql(`SELECT COUNT(*) FROM bingo_scan_samples WHERE id='${s2.id}'`) === '1');
  r = await call('POST', `${BASE}/api/training?purge=1`, { body: { ids: [] }, token: ADMIN });
  t('purge: an empty list is refused (400)', r.status === 400);
  r = await call('POST', `${BASE}/api/training?purge=1`, { body: { ids: Array.from({ length: 501 }, (_, i) => 'id' + i) }, token: ADMIN });
  t('purge: more than 500 ids is refused (400)', r.status === 400);

  r = await call('DELETE', `${BASE}/api/training/${s2.id}`, { token: ADMIN });
  t('delete: an admin can delete one sample (204)', r.status === 204 && sql(`SELECT COUNT(*) FROM bingo_scan_samples WHERE id='${s2.id}'`) === '0');
  r = await call('DELETE', `${BASE}/api/training/${s2.id}`, { token: ADMIN });
  t('delete: deleting it again is reported (404)', r.status === 404);

  // ---------- Rate limit: 30 per device per hour ----------
  sql('DELETE FROM bingo_scan_samples');
  let accepted = 0, limited = null;
  for (let k = 0; k < 40; k++) {
    const res = await post(sample({ sheet: b64('sheet_small.jpg') }));
    if (res.status === 201) accepted++; else { limited = res; break; }
  }
  t('rate limit: exactly 30 samples are accepted within an hour', accepted === 30, 'accepted ' + accepted);
  t('rate limit: the 31st is refused (429) with a Retry-After', limited && limited.status === 429 && limited.headers.get('retry-after') === '3600', limited && limited.status);
  const dup = await post(JSON.parse(JSON.stringify(sample({ sheet: b64('sheet_small.jpg') }))));
  t('rate limit: further uploads stay refused', dup.status === 429);
  sql("UPDATE bingo_scan_samples SET received_at = received_at - INTERVAL 2 HOUR");
  r = await post(sample({ sheet: b64('sheet_small.jpg') }));
  t('rate limit: after the hour passes uploads work again', r.status === 201, r.status);

  // ---------- Storage cap (second server started with a tiny cap) ----------
  sql('DELETE FROM bingo_scan_samples');
  const size = fs.statSync(path.join(FIX, 'sheet_ok.jpg')).size;
  const cap = Number(env('CAP_BYTES'));
  let stored = 0, full = null;
  for (let k = 0; k < 10; k++) {
    // each sample comes from a different "device" so the rate limit does not interfere
    const res = await call('POST', `${CAP_BASE}/api/training`, { body: sample() });
    if (res.status === 201) stored++; else { full = res; break; }
    sql(`UPDATE bingo_scan_samples SET ip_hash = SHA2(CONCAT('device', id), 256)`);
  }
  t('cap: samples are accepted until the stored images reach the cap', stored === Math.floor(cap / size), `stored ${stored}, cap ${cap}, sheet ${size}`);
  t('cap: the next one is refused with 507 and the cap is reported', full && full.status === 507 && full.json.capBytes === cap, full && (full.status + ' ' + full.text.slice(0, 100)));
  t('cap: a refused sample is not stored', Number(sql('SELECT COUNT(*) FROM bingo_scan_samples')) === stored);
  r = await call('POST', `${CAP_BASE}/api/training`, { body: sample() });
  t('cap: it stays full for new samples', r.status === 507);
  const existing = sql('SELECT id FROM bingo_scan_samples LIMIT 1');
  r = await call('POST', `${CAP_BASE}/api/training`, { body: sample({ id: existing }) });
  t('cap: re-sending a sample that is already stored is still accepted (duplicate)', r.status === 200 && r.json.duplicate === true, r.status);

  console.log(`\n${checks} checks, ${failed ? failed + ' FAILED' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('ERROR', e.stack || e); process.exit(1); });
