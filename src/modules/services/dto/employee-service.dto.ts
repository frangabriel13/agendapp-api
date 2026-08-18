import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsUUID, ValidateNested } from 'class-validator';

/** Tope defensivo: un servicio con más asignaciones que esto es un error de carga. */
export const MAX_SERVICE_ASSIGNMENTS = 200;

/**
 * Quién presta el servicio y **dónde**. La sucursal es parte de la clave: una
 * profesional puede hacer color en Centro y no en Palermo, y la Fase 5 necesita
 * esa distinción para no ofrecer un turno imposible.
 */
export class ServiceEmployeeDto {
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiProperty() @IsUUID() branchId!: string;
}

export class SetServiceEmployeesDto {
  @ApiProperty({
    type: [ServiceEmployeeDto],
    description:
      'Reemplaza la lista completa. Un array vacío deja el servicio sin ' +
      'nadie que lo preste (no se puede reservar hasta asignar a alguien).',
  })
  @IsArray()
  @ArrayMaxSize(MAX_SERVICE_ASSIGNMENTS)
  @ValidateNested({ each: true })
  @Type(() => ServiceEmployeeDto)
  assignments!: ServiceEmployeeDto[];
}

export class ServiceEmployeeResponseDto {
  @ApiProperty() employeeId!: string;
  @ApiProperty({ example: 'Lucía Fernández' }) employeeName!: string;
  @ApiProperty() branchId!: string;
  @ApiProperty({ example: 'Sucursal Centro' }) branchName!: string;
}
