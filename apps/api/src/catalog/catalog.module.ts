import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { ServicesRepository } from './services.repository';

@Module({
  controllers: [CatalogController],
  providers: [ServicesRepository],
})
export class CatalogModule {}
