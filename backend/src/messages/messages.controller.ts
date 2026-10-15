import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { UpdateMessageTextDto } from './dto/update-message-text.dto';
import { UpdateAttachmentPhotoSizeDto } from '../storage/dto/update-attachment-photo-size.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { parseOptionalInt } from '../common/parse-optional-int';

@UseGuards(JwtAuthGuard)
@Controller('orders/:orderId/messages')
export class MessagesController {
  constructor(private messages: MessagesService) {}

  @Get()
  list(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.messages.list(orderId, {
      limit: parseOptionalInt(limit),
      before: parseOptionalInt(before),
    });
  }

  @Post()
  create(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messages.create(orderId, user.id, dto);
  }

  @Patch(':messageId/text')
  updateText(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Body() dto: UpdateMessageTextDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messages.updateText(orderId, messageId, user, dto);
  }

  @Patch(':messageId/attachments/:attachmentId/photo-size')
  updateAttachmentPhotoSize(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @Body() dto: UpdateAttachmentPhotoSizeDto,
  ) {
    return this.messages.updateAttachmentPhotoSize(orderId, messageId, attachmentId, dto);
  }

  @Delete(':messageId/text')
  deleteText(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messages.deleteText(orderId, messageId, user);
  }
}
