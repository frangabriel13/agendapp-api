import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Exige un access token válido.
 *
 * Por ahora se aplica endpoint por endpoint con `@UseGuards(JwtAuthGuard)`.
 * En la Fase 1.4 pasa a ser guard global (`APP_GUARD`) y aparece el decorator
 * `@Public()` para las rutas que quedan abiertas.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
