import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AUTO_ASSIGN_TZ } from './assignment.service';

const RESET_CRON = process.env.SHIFT_RESET_CRON ?? '0 21 * * *';

/**
 * Вечерний сброс «На смене». Художник, забывший выключить статус, не должен
 * получать заказы на следующий день без явного выхода на смену.
 */
@Injectable()
export class ShiftResetJob {
  private readonly logger = new Logger(ShiftResetJob.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(RESET_CRON, { timeZone: AUTO_ASSIGN_TZ })
  async resetShifts() {
    const { count } = await this.prisma.user.updateMany({
      where: { onShift: true },
      data: { onShift: false, onShiftAt: new Date() },
    });
    if (count > 0) {
      this.logger.log(`Смена закрыта: снят статус «На смене» у ${count} художников`);
    }
  }
}
