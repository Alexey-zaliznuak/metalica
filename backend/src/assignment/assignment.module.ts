import { Module } from '@nestjs/common';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';
import { ShiftResetJob } from './shift-reset.job';

@Module({
  controllers: [AssignmentController],
  providers: [AssignmentService, ShiftResetJob],
  exports: [AssignmentService],
})
export class AssignmentModule {}
