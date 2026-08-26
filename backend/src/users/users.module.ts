import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { ShiftManagementGuard } from './shift-management.guard';

@Module({
  providers: [UsersService, ShiftManagementGuard],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
