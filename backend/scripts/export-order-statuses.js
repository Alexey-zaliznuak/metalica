// DATABASE_URL is supplied by the operator; this script only reads the catalog.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const statuses = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return tx.bluesalesOrderStatus.findMany({ orderBy: { bsOrderStatusId: 'asc' }, select: { bsOrderStatusId: true, name: true } });
  });
  console.log(JSON.stringify(statuses, null, 2));
})().catch(() => { console.error('Unable to read status catalog. Check DATABASE_URL and connectivity.'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
