import { Module } from '@nestjs/common';
import { BluesalesModule } from '../bluesales/bluesales.module';
import { MetavistaService } from './metavista.service';
import { MetavistaBsService } from './metavista-bs.service';
import { EurRateService } from './eur-rate.service';

@Module({ imports: [BluesalesModule], providers: [MetavistaService, MetavistaBsService, EurRateService] })
export class MetavistaModule {}
