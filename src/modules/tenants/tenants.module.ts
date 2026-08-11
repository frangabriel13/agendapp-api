import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

// Sin imports: PrismaModule y TenantContextModule son @Global.
@Module({
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
