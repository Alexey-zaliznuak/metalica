import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BluesalesInboundSyncService implements OnModuleInit {
  // Backend runs as one replica. All import paths share this instance so a
  // saved change takes effect immediately, without a cache TTL or restart.
  private state: { enabled: boolean; updatedAt: Date } | null = null;
  private initialization: Promise<void> | null = null;
  private pendingUpdate: Promise<unknown> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): Promise<void> {
    return this.initialize();
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.prisma.bluesalesSyncSettings.upsert({
        where: { id: 1 },
        create: { id: 1 },
        update: {},
      }).then((row) => {
        this.state = { enabled: row.inboundEnabled, updatedAt: row.updatedAt };
      });
    }
    return this.initialization;
  }

  // Fail closed until the persisted setting has been loaded.
  get enabled(): boolean {
    return this.state?.enabled ?? false;
  }

  async getState() {
    await this.initialize();
    return { ...this.state! };
  }

  setEnabled(enabled: boolean) {
    // Serialize concurrent admin requests to keep memory and the DB in sync.
    const update = this.pendingUpdate.then(async () => {
      await this.initialize();
      const row = await this.prisma.bluesalesSyncSettings.update({
        where: { id: 1 },
        data: { inboundEnabled: enabled },
      });
      this.state = { enabled: row.inboundEnabled, updatedAt: row.updatedAt };
      return { ...this.state };
    });
    this.pendingUpdate = update.catch(() => {});
    return update;
  }
}
