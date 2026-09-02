import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';

// Sin imports: PrismaModule y TenantContextModule son @Global.
@Module({
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}
