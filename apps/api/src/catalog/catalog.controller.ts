import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { ServicesRepository } from './services.repository';

const createServiceSchema = z.object({
  name: z.string().min(1),
  priceCents: z.number().int().positive(),
  durationMin: z.number().int().positive(),
  returnIntervalDays: z.number().int().positive().optional(),
});

@Controller('api/v1/services')
export class CatalogController {
  constructor(private readonly servicesRepo: ServicesRepository) {}

  @Get()
  list() {
    return this.servicesRepo.list();
  }

  @Post()
  create(@Body() body: unknown) {
    const parsed = createServiceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.servicesRepo.create(parsed.data);
  }
}
