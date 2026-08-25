import { Module } from '@nestjs/common';
import { GoodsModule } from '../goods/goods.module';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';
import { ShiftResetJob } from './shift-reset.job';

@Module({
  imports: [GoodsModule],
  controllers: [AssignmentController],
  providers: [AssignmentService, ShiftResetJob],
  exports: [AssignmentService],
})
export class AssignmentModule {}
