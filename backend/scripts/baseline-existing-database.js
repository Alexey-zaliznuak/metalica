const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

// Immutable pre-change schema/history. Never replace this with the moving HEAD.
const BASELINE = '71364e7050cf3be0567091c34b3e6850e3494e3e';
const backend = path.resolve(__dirname, '..');
const repo = path.resolve(backend, '..');
const apply = process.argv.includes('--apply');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/^postgres(?:ql)?:\/\//.test(dbUrl)) {
  throw new Error('Set DATABASE_URL explicitly. This script does not load .env files.');
}
if (process.argv.slice(2).some((arg) => arg !== '--apply')) throw new Error('Usage: node scripts/baseline-existing-database.js [--apply]');
const redact = (value) => String(value).split(dbUrl).join('[DATABASE_URL]').replace(/postgres(?:ql)?:\/\/\S+/g, '[DATABASE_URL]');
function run(command, args, cwd = repo) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(redact(result.error.message));
  if (result.status !== 0) throw new Error(redact(result.stderr || result.stdout || `Command failed (${result.status})`));
  return result.stdout;
}
const git = (...args) => run('git', args);
const prismaCli = require.resolve('prisma/build/index.js');
const prisma = (...args) => run(process.execPath, [prismaCli, ...args], backend);

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metalica-baseline-'));
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    const table = await db.$queryRaw`SELECT to_regclass('public._prisma_migrations')::text AS name`;
    if (table[0].name) {
      const count = await db.$queryRaw`SELECT COUNT(*)::int AS count FROM public._prisma_migrations`;
      if (count[0].count !== 0) throw new Error('Migration history already exists. Refusing to baseline; use normal migrate deploy or inspect incomplete baseline manually.');
    }
    const schema = path.join(directory, 'schema.prisma');
    fs.writeFileSync(schema, git('show', `${BASELINE}:backend/prisma/schema.prisma`));
    const migrations = git('ls-tree', '--name-only', `${BASELINE}:backend/prisma/migrations`)
      .trim().split(/\r?\n/).filter((name) => /^\d+_/.test(name)).sort();
    for (const name of migrations) {
      const relative = `backend/prisma/migrations/${name}/migration.sql`;
      const expected = git('show', `${BASELINE}:${relative}`);
      const actual = fs.readFileSync(path.join(repo, relative), 'utf8');
      if (actual.replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) throw new Error(`Historical migration changed: ${name}. Restore the historical migration before baseline.`);
    }
    // exit-code 2 means schema drift: no baseline writes are made in that case.
    prisma('migrate', 'diff', '--from-schema-datasource', schema, '--to-schema-datamodel', schema, '--exit-code');
    console.log(`Existing schema exactly matches pre-change schema; ${migrations.length} historical migrations verified.`);
    if (!apply) {
      console.log('Read-only check passed. Re-run with --apply to register existing history, then prisma migrate deploy.');
      return;
    }
    for (const name of migrations) {
      // Resolve records checksums of real historical files; never executes their DDL.
      prisma('migrate', 'resolve', '--applied', name, '--schema', path.join(backend, 'prisma/schema.prisma'));
      console.log(`Registered ${name}`);
    }
    console.log('Baseline complete. New migrations have NOT been applied. Run prisma migrate deploy separately.');
  } finally {
    await db.$disconnect();
    const resolvedDirectory = path.resolve(directory);
    if (!resolvedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe temporary directory');
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(redact(error.message)); process.exitCode = 1; });
