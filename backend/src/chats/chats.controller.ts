import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatsService } from './chats.service';
import { AddChatMemberDto } from './dto/add-chat-member.dto';
import { CreateChatDto } from './dto/create-chat.dto';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { UpdateChatDto } from './dto/update-chat.dto';
import { UpdateChatMessageTextDto } from './dto/update-chat-message-text.dto';

@UseGuards(JwtAuthGuard)
@Controller('chats')
export class ChatsController {
  constructor(private chats: ChatsService) {}

  @Get('users')
  listUsers() {
    return this.chats.listUsers();
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.chats.list(user);
  }

  @Post()
  create(@Body() dto: CreateChatDto, @CurrentUser() user: AuthUser) {
    return this.chats.create(dto, user);
  }

  @Get(':chatId')
  getOne(@Param('chatId', ParseIntPipe) chatId: number, @CurrentUser() user: AuthUser) {
    return this.chats.getOne(chatId, user);
  }

  @Patch(':chatId')
  update(
    @Param('chatId', ParseIntPipe) chatId: number,
    @Body() dto: UpdateChatDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.update(chatId, dto, user);
  }

  @Delete(':chatId')
  remove(@Param('chatId', ParseIntPipe) chatId: number, @CurrentUser() user: AuthUser) {
    return this.chats.remove(chatId, user);
  }

  @Post(':chatId/members')
  addMember(
    @Param('chatId', ParseIntPipe) chatId: number,
    @Body() dto: AddChatMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.addMember(chatId, dto, user);
  }

  @Delete(':chatId/members/:userId')
  removeMember(
    @Param('chatId', ParseIntPipe) chatId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.removeMember(chatId, userId, user);
  }

  @Get(':chatId/messages')
  listMessages(@Param('chatId', ParseIntPipe) chatId: number, @CurrentUser() user: AuthUser) {
    return this.chats.listMessages(chatId, user.id);
  }

  @Post(':chatId/messages')
  createMessage(
    @Param('chatId', ParseIntPipe) chatId: number,
    @Body() dto: CreateChatMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.createMessage(chatId, user.id, dto);
  }

  @Patch(':chatId/messages/:messageId/text')
  updateMessageText(
    @Param('chatId', ParseIntPipe) chatId: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Body() dto: UpdateChatMessageTextDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.updateMessageText(chatId, messageId, user, dto);
  }

  @Delete(':chatId/messages/:messageId/text')
  deleteMessageText(
    @Param('chatId', ParseIntPipe) chatId: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.deleteMessageText(chatId, messageId, user);
  }
}
