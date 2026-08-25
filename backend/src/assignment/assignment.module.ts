import { Module } from '@nestjs/common';
import { GoodsModule } from '../goods/goods.module';
import { AssignmentService } from './assignment.service';
import { ShiftResetJob } from './shift-reset.job';

@Module({
  imports: [GoodsModule],
  providers: [AssignmentService, ShiftResetJob],
  exports: [AssignmentService],
})
export class AssignmentModule {}
