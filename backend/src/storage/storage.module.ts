import { Global, Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';

@Global()
@Module({
  providers: [StorageService, AttachmentsService],
  controllers: [StorageController],
  exports: [StorageService, AttachmentsService],
})
export class StorageModule {}
