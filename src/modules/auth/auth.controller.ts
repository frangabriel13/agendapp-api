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
  ApiBadRequestResponse,
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
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/password-reset.dto';
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

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({
    summary: 'Pide el link para restablecer la contraseña',
    description:
      'Responde 204 exista o no la cuenta, a propósito: contestar distinto ' +
      'convertiría el endpoint en un enumerador de emails registrados. Emitir ' +
      'un link nuevo revoca el anterior.',
  })
  @ApiNoContentResponse()
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({
    summary: 'Canjea el link y deja una contraseña nueva',
    description:
      'El token sirve una sola vez. Cierra todas las sesiones abiertas del usuario.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'El link no es válido o ya venció' })
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.authService.resetPassword(dto);
  }

  @Post('verify-email')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({
    summary: 'Confirma la casilla con el link que llegó por mail',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'El link no es válido o ya venció' })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    return this.authService.verifyEmail(dto);
  }

  @Post('verify-email/resend')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Reenvía el mail de verificación' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'El email ya está confirmado' })
  resendEmailVerification(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.authService.resendEmailVerification(user);
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
