const { PrismaClient } = require('@prisma/client');

const ARTIST_NAME = process.argv[2] || 'Аня Колесова';
const DATABASE_URL = process.env.DATABASE_URL;
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://metallity-crm.ru').replace(/\/+$/, '');

const MOSCOW_OFFSET_MINUTES = 180;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 21;

if (!DATABASE_URL) {
  console.error(
    'Не задан DATABASE_URL.\n' +
      'Пример: DATABASE_URL="postgresql://..." node prisma/sketch-timing-report.js "Аня Колесова"',
  );
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: DATABASE_URL },
  },
});

const moscowDateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function workingMillisecondsBetween(startedAt, readyAt) {
  const startMs = startedAt.getTime();
  const endMs = readyAt.getTime();
  if (endMs <= startMs) return 0;

  const offsetMs = MOSCOW_OFFSET_MINUTES * 60_000;
  const localStartMs = startMs + offsetMs;
  const localEndMs = endMs + offsetMs;
  const dayMs = 24 * 60 * 60 * 1000;
  const workStartMs = WORK_START_HOUR * 60 * 60 * 1000;
  const workEndMs = WORK_END_HOUR * 60 * 60 * 1000;

  let result = 0;
  for (
    let dayStartMs = Math.floor(localStartMs / dayMs) * dayMs;
    dayStartMs <= localEndMs;
    dayStartMs += dayMs
  ) {
    const intervalStartMs = Math.max(localStartMs, dayStartMs + workStartMs);
    const intervalEndMs = Math.min(localEndMs, dayStartMs + workEndMs);
    if (intervalEndMs > intervalStartMs) {
      result += intervalEndMs - intervalStartMs;
    }
  }

  return result;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0) parts.push(`${minutes} мин`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} сек`);
  return parts.join(' ');
}

async function main() {
  const artists = await prisma.user.findMany({
    where: {
      name: {
        equals: ARTIST_NAME,
        mode: 'insensitive',
      },
    },
    select: {
      id: true,
      name: true,
      role: true,
    },
  });

  if (artists.length === 0) {
    throw new Error(`Художник «${ARTIST_NAME}» не найден.`);
  }
  if (artists.length > 1) {
    throw new Error(
      `Найдено несколько пользователей с именем «${ARTIST_NAME}»: ${artists
        .map((artist) => `id=${artist.id}`)
        .join(', ')}`,
    );
  }

  const artist = artists[0];
  const orders = await prisma.order.findMany({
    where: {
      sketchDesignerId: artist.id,
      sketchStartedAt: { not: null },
      sketchReadyAt: { not: null },
    },
    select: {
      id: true,
      orderNumber: true,
      sketchStartedAt: true,
      sketchReadyAt: true,
    },
    orderBy: {
      sketchStartedAt: 'asc',
    },
  });

  let totalElapsedMs = 0;
  let totalWorkingMs = 0;
  let validOrdersCount = 0;

  for (const order of orders) {
    const startedAt = order.sketchStartedAt;
    const readyAt = order.sketchReadyAt;
    if (!startedAt || !readyAt) continue;

    console.log('----');
    console.log(`${APP_BASE_URL}/orders/${order.id}`);
    console.log(
      `разработка эскиза: ${moscowDateTimeFormatter.format(startedAt)} - ` +
        moscowDateTimeFormatter.format(readyAt),
    );

    if (readyAt < startedAt) {
      console.log('время затраченное на эскиз - некорректные даты');
      console.log('время затраченное на эскиз с учетом рабочего дня - некорректные даты');
      continue;
    }

    const elapsedMs = readyAt.getTime() - startedAt.getTime();
    const workingMs = workingMillisecondsBetween(startedAt, readyAt);
    totalElapsedMs += elapsedMs;
    totalWorkingMs += workingMs;
    validOrdersCount += 1;

    console.log(`время затраченное на эскиз - ${formatDuration(elapsedMs)}`);
    console.log(
      `время затраченное на эскиз с учетом рабочего дня - ${formatDuration(workingMs)}`,
    );
  }

  console.log('----');
  if (validOrdersCount === 0) {
    console.log('итоговое среднее время на эскиз - нет данных');
    console.log('итоговое среднее время на эскиз с учетом рабочего дня - нет данных');
    return;
  }

  console.log(
    `итоговое среднее время на эскиз - ${formatDuration(totalElapsedMs / validOrdersCount)}`,
  );
  console.log(
    'итоговое среднее время на эскиз с учетом рабочего дня - ' +
      formatDuration(totalWorkingMs / validOrdersCount),
  );
}

main()
  .catch((error) => {
    console.error('Не удалось сформировать отчёт:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
