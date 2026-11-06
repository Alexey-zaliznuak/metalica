import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { LoggingInterceptor } from './common/logging.interceptor';
import { PrismaService } from './prisma/prisma.service';
import { reconcileActiveRevisions } from './orders/revision-status.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.enableCors({ origin: true, credentials: true });

  const port = Number(process.env.PORT) || 3000;
  await reconcileActiveRevisions(app.get(PrismaService));
  await app.listen(port, '0.0.0.0');
  Logger.log(`Backend listening on :${port}`, 'Bootstrap');
}

bootstrap();
