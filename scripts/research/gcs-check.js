// Phase 95 Task 0.3: check that a research bucket key has EXACTLY its intended rights, without printing the key.
//   writer (VM): can create objects, cannot list / read them      reader (PC): can list / read, cannot create
// Run: node scripts/research/gcs-check.js --role writer|reader --bucket <name> [--key <path, default .research-gcs.json>]
// The writer check leaves one small object under check/ (the bucket's lifecycle rule deletes it).
const fs = require('fs');
const path = require('path');

// { created: upload result, listed: list result } -> { ok, line }
function verdict(role, created, listed) {
  const canCreate = !!created.ok || created.exists === true;
  const canRead = !!listed.ok;
  const want = role === 'writer' ? { canCreate: true, canRead: false } : { canCreate: false, canRead: true };
  const ok = canCreate === want.canCreate && canRead === want.canRead && (created.ok || [403, 412].includes(created.status)) && (listed.ok || listed.status === 403);
  const line = `${role}: ${canCreate ? 'can create' : 'cannot create'}, ${canRead ? 'can read' : 'cannot read'} -> ${ok ? 'OK' : 'NOT AS INTENDED'}`
    + (ok ? '' : ` (create: ${created.status} ${created.error || ''}; list: ${listed.status} ${listed.error || ''})`);
  return { ok, line };
}

async function main() {
  const a = process.argv.slice(2); const arg = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const role = arg('--role'); const bucket = arg('--bucket', process.env.RESEARCH_GCS_BUCKET);
  const keyPath = arg('--key', path.join(__dirname, '..', '..', '.research-gcs.json'));
  if (!['writer', 'reader'].includes(role) || !bucket) { console.log('usage: --role writer|reader --bucket <name> [--key <path>]'); process.exit(2); }
  let key; try { key = JSON.parse(fs.readFileSync(keyPath, 'utf8')); } catch { console.log(`cannot read the key file ${keyPath}`); process.exit(2); }
  const c = require('../../server/research/gcs').client({ key, bucket, scope: role === 'writer' ? 'read_write' : 'read_only' });
  const created = await c.upload(`check/${role}-${Date.now()}.txt`, Buffer.from('access check'), { ifNotExists: true });
  const listed = await c.list('check/');
  const v = verdict(role, created, listed);
  console.log(v.line); process.exitCode = v.ok ? 0 : 1;
}

if (require.main === module) main().catch((e) => { console.error(String(e.message).slice(0, 200)); process.exitCode = 1; });
module.exports = { verdict };
