import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OrderLifecycleService } from './order-lifecycle.service';
import { CLEANUP_TAG, COMPLETE_TAG } from './order-lifecycle.policy';

@Injectable()
export class OrderAttachmentCleanupWorker {
  private running = false;
  private logger = new Logger(OrderAttachmentCleanupWorker.name);
  constructor(private lifecycle: OrderLifecycleService) {}
  @Interval(60_000)
  async run() {
    if (this.running) return;
    this.running = true;
    try { await this.lifecycle.tick(CLEANUP_TAG, process.env.ORDER_ATTACHMENT_CLEANUP_ENABLED === 'true'); }
    catch (error) { this.logger.error(`Attachment lifecycle: ${(error as Error).message}`); }
    finally { this.running = false; }
  }
}

@Injectable()
export class OrderAutoCompleteWorker {
  private running = false;
  private logger = new Logger(OrderAutoCompleteWorker.name);
  constructor(private lifecycle: OrderLifecycleService) {}
  @Interval(60_000)
  async run() {
    if (this.running) return;
    this.running = true;
    try { await this.lifecycle.tick(COMPLETE_TAG, process.env.ORDER_AUTO_COMPLETE_ENABLED === 'true'); }
    catch (error) { this.logger.error(`Completion lifecycle: ${(error as Error).message}`); }
    finally { this.running = false; }
  }
}
