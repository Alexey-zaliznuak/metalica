import { Body, Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateGoodsDto } from './dto/update-goods.dto';
import { GoodsService } from './goods.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('goods')
export class GoodsController {
  constructor(private goods: GoodsService) {}

  @Get()
  list() {
    return this.goods.list();
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateGoodsDto) {
    return this.goods.updateDirection(id, dto.direction ?? null);
  }
}
