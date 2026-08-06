const { PrismaClient } = require('@prisma/client');

const connectionUri = process.argv[2] || process.env.DATABASE_URL;

if (!connectionUri) {
  console.error(
    'Укажите connection URI первым аргументом или через DATABASE_URL:\n' +
      'node prisma/backfill-sketch-ready.js "postgresql://user:password@host:5432/database"',
  );
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: connectionUri },
  },
});

async function main() {
  const closingStatuses = await prisma.bluesalesOrderStatus.findMany({
    where: { closesSketch: true },
    select: { bsOrderStatusId: true, name: true },
    orderBy: { sortOrder: 'asc' },
  });

  if (closingStatuses.length === 0) {
    console.log('Нет статусов с включённой опцией «Закрывать эскиз».');
    return;
  }

  const statusIds = closingStatuses.map((status) => status.bsOrderStatusId);
  const statusNames = closingStatuses
    .map((status) => `${status.name} (${status.bsOrderStatusId})`)
    .join(', ');
  const now = new Date();
  const inClosingStatus = {
    bluesalesInfo: {
      is: {
        orderStatusId: { in: statusIds },
      },
    },
  };

  const [started, ready] = await prisma.$transaction([
    prisma.order.updateMany({
      where: {
        ...inClosingStatus,
        sketchStartedAt: null,
      },
      data: { sketchStartedAt: now },
    }),
    prisma.order.updateMany({
      where: {
        ...inClosingStatus,
        sketchReadyAt: null,
      },
      data: { sketchReadyAt: now },
    }),
  ]);

  console.log(`Статусы: ${statusNames}`);
  console.log(`Установлено sketchStartedAt: ${started.count}`);
  console.log(`Установлено sketchReadyAt: ${ready.count}`);
}

main()
  .catch((error) => {
    console.error('Не удалось обновить заказы:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
