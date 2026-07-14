import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'query' | 'warn' | 'error'>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('Prisma');

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
        // Логи самих запросов шумные — включаются флагом PRISMA_LOG_QUERIES=1.
        ...(process.env.PRISMA_LOG_QUERIES === '1'
          ? [{ emit: 'event' as const, level: 'query' as const }]
          : []),
      ],
    });
  }

  async onModuleInit() {
    // Ошибки БД (в т.ч. «column does not exist») теперь видны в логах.
    this.$on('error', (e) => {
      this.logger.error(e.message);
    });
    this.$on('warn', (e) => {
      this.logger.warn(e.message);
    });
    this.$on('query', (e) => {
      this.logger.debug(`${e.query} — ${e.params} (${e.duration}ms)`);
    });

    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
