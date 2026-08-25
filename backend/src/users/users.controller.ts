import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  findAll() {
    return this.users.findAll();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  // Художник управляет своей сменой сам — единственный метод раздела,
  // доступный не администратору.
  @Patch('me/shift')
  @Roles(Role.SKETCH_DESIGNER, Role.REVISION_DESIGNER)
  setOwnShift(@CurrentUser() user: AuthUser, @Body() dto: UpdateShiftDto) {
    return this.users.setShift(user.id, dto.onShift);
  }

  @Patch(':id/shift')
  setShift(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateShiftDto) {
    return this.users.setShift(id, dto.onShift);
  }
}
