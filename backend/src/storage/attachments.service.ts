import { Injectable, Logger } from '@nestjs/common';
import { Attachment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';

export interface SerializedAttachment {
  id: number;
  url: string;
  filename: string;
  mimeType: string | null;
  size: number | null;
  kind: string;
}

/**
 * Общая работа с вложениями сообщений: и чат заказа, и групповые чаты пишут
 * в одну таблицу Attachment и одинаково отдают её клиенту.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  // Ключи, по которым хранилище не отдало метаданные: без этого каждая отдача
  // ленты снова ходила бы в MinIO за битым объектом.
  private readonly keysWithoutMeta = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  async buildCreateInput(keys: string[] | undefined, kind: string) {
    if (!keys?.length) return undefined;

    const create = await Promise.all(
      keys.map(async (key) => {
        const stat = await this.storage.stat(key);
        return {
          objectKey: key,
          filename: key.substring(key.lastIndexOf('/') + 1),
          mimeType: stat?.mimeType ?? null,
          size: stat?.size ?? null,
          kind,
        };
      }),
    );

    return { create };
  }

  async serialize(attachments: Attachment[]): Promise<SerializedAttachment[]> {
    return Promise.all(
      attachments.map(async (attachment) => {
        const { size, mimeType } = await this.resolveMeta(attachment);
        return {
          id: attachment.id,
          url: await this.storage.getUrl(attachment.objectKey),
          filename: attachment.filename,
          mimeType,
          size,
          kind: attachment.kind,
        };
      }),
    );
  }

  /**
   * У вложений, созданных до появления колонки size, метаданных в БД нет.
   * Дотягиваем их из хранилища при первой отдаче и сразу сохраняем: так это
   * один запрос на вложение за всё время, а не на каждый просмотр ленты.
   */
  private async resolveMeta(attachment: Attachment) {
    if (attachment.size != null || this.keysWithoutMeta.has(attachment.objectKey)) {
      return { size: attachment.size, mimeType: attachment.mimeType };
    }

    const stat = await this.storage.stat(attachment.objectKey);
    if (!stat) {
      this.keysWithoutMeta.add(attachment.objectKey);
      return { size: null, mimeType: attachment.mimeType };
    }

    const mimeType = attachment.mimeType ?? stat.mimeType;
    try {
      await this.prisma.attachment.update({
        where: { id: attachment.id },
        data: { size: stat.size, mimeType },
      });
    } catch (e) {
      // Не смогли закешировать в БД — отдать размер это не мешает.
      this.logger.warn(
        `Не удалось сохранить метаданные вложения #${attachment.id}: ${(e as Error).message}`,
      );
    }

    return { size: stat.size, mimeType };
  }
}
