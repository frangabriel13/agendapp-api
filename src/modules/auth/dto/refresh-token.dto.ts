import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    example: '4f0a1e2c-....7b.Zm9vYmFyYmF6',
    description: 'El refresh token tal cual lo devolvió login o refresh.',
  })
  @IsString()
  @IsNotEmpty({ message: 'El refresh token es obligatorio' })
  @MaxLength(200)
  refreshToken!: string;
}
