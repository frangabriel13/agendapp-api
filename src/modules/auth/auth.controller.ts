import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { MeResponseDto } from './dto/me-response.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import type { AuthenticatedUser } from './types/jwt-payload';

/** Límite extra para los endpoints que aceptan credenciales. */
const CREDENTIALS_THROTTLE = { short: { limit: 5, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Public()
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({
    summary: 'Registra un negocio nuevo',
    description:
      'Crea el usuario, el negocio, el empleado dueño y la suscripción de prueba, y devuelve los tokens.',
  })
  @ApiCreatedResponse({ type: AuthTokensDto })
  @ApiConflictResponse({ description: 'El email ya está registrado' })
  register(@Body() dto: RegisterDto): Promise<AuthTokensDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Inicia sesión' })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiUnauthorizedResponse({ description: 'Credenciales inválidas' })
  login(@Body() dto: LoginDto): Promise<AuthTokensDto> {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Renueva el access token',
    description:
      'Rota el refresh token: el que se envía queda revocado y se devuelve uno nuevo.',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiUnauthorizedResponse({ description: 'Refresh token inválido o vencido' })
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokensDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cierra la sesión',
    description:
      'Revoca el refresh token enviado y toda su cadena de rotaciones. ' +
      'Es público a propósito: alcanza con presentar el refresh token, así se ' +
      'puede cerrar sesión aunque el access token ya haya vencido.',
  })
  @ApiNoContentResponse()
  logout(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Devuelve el usuario, su negocio y su rol' })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponseDto> {
    return this.authService.me(user);
  }

  @Patch('password')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({
    summary: 'Cambia la contraseña',
    description: 'Cierra todas las sesiones abiertas del usuario.',
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({
    description: 'La contraseña actual no es correcta',
  })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.authService.changePassword(user, dto);
  }
}
