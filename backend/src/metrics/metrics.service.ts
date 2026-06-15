import { Injectable } from '@nestjs/common';
import { MessageKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MetricsService {
  constructor(private prisma: PrismaService) {}

  private get stuckHours(): number {
    return Number(process.env.STUCK_REVISION_HOURS) || 24;
  }

  async overview() {
    const totalOrders = await this.prisma.order.count();
    const totalRevisions = await this.prisma.message.count({
      where: { kind: MessageKind.REVISION_REQUEST },
    });
    const openRevisions = await this.prisma.message.count({
      where: { kind: MessageKind.REVISION_REQUEST, answeredBy: { none: {} } },
    });

    const stuckThreshold = new Date(Date.now() - this.stuckHours * 3600 * 1000);
    const stuckRevisions = await this.prisma.message.count({
      where: {
        kind: MessageKind.REVISION_REQUEST,
        answeredBy: { none: {} },
        createdAt: { lt: stuckThreshold },
      },
    });

    const avgRevisionSeconds = await this.avgRevisionSeconds();

    return { totalOrders, totalRevisions, avgRevisionSeconds, openRevisions, stuckRevisions };
  }

  async byDesigner() {
    const designers = await this.prisma.user.findMany({
      where: { role: 'DESIGNER' },
      select: { id: true, name: true },
    });

    const answers = await this.prisma.message.findMany({
      where: { kind: MessageKind.REVISION_ANSWER, answerToId: { not: null } },
      select: {
        authorId: true,
        createdAt: true,
        answerTo: { select: { createdAt: true } },
      },
    });

    return designers.map((d) => {
      const own = answers.filter((a) => a.authorId === d.id && a.answerTo);
      const durations = own
        .map((a) => (a.createdAt.getTime() - a.answerTo!.createdAt.getTime()) / 1000)
        .filter((s) => s >= 0);
      const avg =
        durations.length > 0
          ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length)
          : null;
      return {
        designerId: d.id,
        name: d.name,
        revisions: own.length,
        avgRevisionSeconds: avg,
      };
    });
  }

  private async avgRevisionSeconds(): Promise<number | null> {
    const answers = await this.prisma.message.findMany({
      where: { kind: MessageKind.REVISION_ANSWER, answerToId: { not: null } },
      select: { createdAt: true, answerTo: { select: { createdAt: true } } },
    });
    const durations = answers
      .filter((a) => a.answerTo)
      .map((a) => (a.createdAt.getTime() - a.answerTo!.createdAt.getTime()) / 1000)
      .filter((s) => s >= 0);
    if (durations.length === 0) {
      return null;
    }
    return Math.round(durations.reduce((s, v) => s + v, 0) / durations.length);
  }
}
