import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { ServicesRepository } from './services.repository';

@Module({
  controllers: [CatalogController],
  providers: [ServicesRepository],
  exports: [ServicesRepository], // agent prompt builder reads the catalog
})
export class CatalogModule {}
