import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatsGateway } from './chats.gateway';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    }),
  ],
  providers: [ChatsGateway],
  exports: [ChatsGateway],
})
export class RealtimeModule {}
