import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/** Tope defensivo: un servicio que necesita más de esto es un error de carga. */
export const MAX_SERVICE_RESOURCES = 50;

export class SetServiceResourcesDto {
  @ApiProperty({
    type: [String],
    description:
      'Reemplaza la lista completa. Un array vacío deja el servicio sin ' +
      'requisitos de recursos.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_SERVICE_RESOURCES)
  @IsUUID(undefined, { each: true })
  resourceIds!: string[];
}

export class ServiceResourceResponseDto {
  @ApiProperty() resourceId!: string;
  @ApiProperty({ example: 'Camilla 1' }) resourceName!: string;
  @ApiProperty() branchId!: string;
  @ApiProperty({ example: 'Sucursal Centro' }) branchName!: string;
}
