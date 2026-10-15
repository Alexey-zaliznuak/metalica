import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Attachment, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';
import { PHOTO_SIZES } from './dto/update-attachment-photo-size.dto';
import { isPreviewCandidate } from './image-preview';

export interface SerializedAttachment {
  id: number;
  url: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  previewStatus: string;
  filename: string;
  mimeType: string | null;
  size: number | null;
  photoSize: string | null;
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
          ...stat?.previews,
          kind,
        };
      }),
    );

    return { create };
  }

  async updatePhotoSize(where: Prisma.AttachmentWhereInput, photoSize: (typeof PHOTO_SIZES)[number]) {
    if (!PHOTO_SIZES.includes(photoSize)) throw new BadRequestException('Выберите размер 30 х 40, 40 х 60 или 60 х 80');
    const attachment = await this.prisma.attachment.findFirst({ where });
    if (!attachment) throw new NotFoundException('Фото не найдено в этом заказе');
    if (!isPreviewCandidate(attachment.filename, attachment.mimeType)) {
      throw new BadRequestException('Размер можно установить только для фото');
    }
    const updated = await this.prisma.attachment.update({
      where: { id: attachment.id }, data: { photoSize },
    });
    const [serialized] = await this.serialize([updated]);
    return serialized;
  }

  async serialize(attachments: Attachment[]): Promise<SerializedAttachment[]> {
    return Promise.all(
      attachments.map(async (attachment) => {
        const { size, mimeType } = await this.resolveMeta(attachment);
        return {
          id: attachment.id,
          url: await this.storage.getUrl(attachment.objectKey),
          thumbnailUrl: attachment.thumbnailKey ? await this.storage.getUrl(attachment.thumbnailKey) : null,
          previewUrl: attachment.previewKey ? await this.storage.getUrl(attachment.previewKey) : null,
          previewStatus: attachment.previewStatus,
          filename: attachment.filename,
          mimeType,
          size,
          photoSize: attachment.photoSize ?? null,
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
