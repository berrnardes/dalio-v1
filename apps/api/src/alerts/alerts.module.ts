// Alerts module — Phase 7. Global so any subsystem can page ops without an
// import dance; the service is leaf-level (ConfigService only), so this
// cannot create cycles.
import { Global, Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';

@Global()
@Module({
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
