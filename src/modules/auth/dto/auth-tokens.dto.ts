import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de register / login / refresh. */
export class AuthTokensDto {
  @ApiProperty({ description: 'JWT de acceso. Va en el header Authorization.' })
  accessToken!: string;

  @ApiProperty({
    description:
      'Token opaco para pedir un access token nuevo. Se rota en cada uso.',
  })
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({
    example: 900,
    description: 'Segundos de vida del access token.',
  })
  expiresIn!: number;
}
