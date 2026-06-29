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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('orders/:orderId/messages')
export class MessagesController {
  constructor(private messages: MessagesService) {}

  @Get()
  list(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('before', new ParseIntPipe({ optional: true })) before?: number,
  ) {
    return this.messages.list(orderId, { limit, before });
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

  @Delete(':messageId/text')
  deleteText(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messages.deleteText(orderId, messageId, user);
  }
}
