import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('orders/:orderId/messages')
export class MessagesController {
  constructor(private messages: MessagesService) {}

  @Get()
  list(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.messages.list(orderId);
  }

  @Post()
  create(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messages.create(orderId, user.id, dto);
  }
}
