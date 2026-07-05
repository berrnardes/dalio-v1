// Template rendering — anti-ban copy variation (DOCUMENTO-EXECUTIVO §3.3):
// byte-identical text to N recipients is a Meta spam heuristic, so every
// template holds variants and each send draws one at random.
import { Injectable, Logger } from '@nestjs/common';
import { TemplatesRepository } from './templates.repository';

@Injectable()
export class TemplateRenderService {
  private readonly logger = new Logger(TemplateRenderService.name);

  constructor(private readonly templatesRepo: TemplatesRepository) {}

  async render(templateKey: string, variables: Record<string, string>): Promise<string> {
    const template = await this.templatesRepo.findByKey(templateKey);
    if (!template) {
      // Loud failure: a missing template means a campaign/reminder is
      // configured against copy that doesn't exist — sending nothing is
      // correct, sending "{{nome}}" to a client is not.
      throw new Error(`Template '${templateKey}' not found`);
    }

    const variant = template.variants[Math.floor(Math.random() * template.variants.length)]!;
    return variant.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = variables[name];
      if (value === undefined) {
        this.logger.warn(`Template '${templateKey}' missing variable '${name}'`);
        return '';
      }
      return value;
    });
  }
}
