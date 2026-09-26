// npm run check:limits (Phase 66): every tracked .js file must parse (node --check) and no
// tracked .js / .css file may exceed MAX_LINES (300). Exits 1 on any violation.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_LINES = 300;
const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '*.js', '*.css'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const problems = [];
let largest = { file: null, lines: 0 };
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const lines = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
  if (lines > largest.lines) largest = { file, lines };
  if (lines > MAX_LINES) problems.push(`${file}: ${lines} lines (max ${MAX_LINES})`);
  if (file.endsWith('.js')) {
    try {
      execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    } catch (err) {
      problems.push(`${file}: syntax error\n${String(err.stderr || err.message).trim()}`);
    }
  }
}
if (problems.length) {
  console.error(`check:limits FAILED (${problems.length}):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`check:limits OK: ${files.length} files, all parse, none over ${MAX_LINES} lines (largest ${largest.file}: ${largest.lines}).`);
