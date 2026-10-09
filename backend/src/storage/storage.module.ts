import { Global, Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { AttachmentPreviewsService } from './attachment-previews.service';
import { StorageCleanupService } from './storage-cleanup.service';
import { ImageJobsLogService } from './image-jobs-log.service';

@Global()
@Module({
  providers: [StorageService, AttachmentsService, AttachmentPreviewsService, StorageCleanupService, ImageJobsLogService],
  controllers: [StorageController],
  exports: [StorageService, AttachmentsService, StorageCleanupService],
})
export class StorageModule {}
