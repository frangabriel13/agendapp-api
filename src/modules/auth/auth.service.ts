import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  EmployeeRole,
  SubscriptionStatus,
  UserTokenPurpose,
} from '@prisma/client';
import { MailService } from '../../common/mail';
import { isReservedSlug, slugify } from '../../common/utils/slug.util';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_PLAN_SLUG, FALLBACK_SLUG_PREFIX } from './auth.constants';
import type { AuthTokensDto } from './dto/auth-tokens.dto';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { MeResponseDto } from './dto/me-response.dto';
import type {
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/password-reset.dto';
import type { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import type { AuthenticatedUser, JwtPayload } from './types/jwt-payload';
import { UserTokenService } from './user-token.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Cuántos sufijos numéricos probamos antes de caer a un slug random. */
const MAX_SLUG_ATTEMPTS = 20;

/**
 * Registro, login y ciclo de vida de la sesión.
 *
 * Usa el cliente Prisma **base** (`this.prisma`, sin `.scoped`) porque todo
 * esto corre antes de que exista un token y, por lo tanto, antes de que haya
 * contexto de tenant montado. A cambio, cada query filtra a mano por
 * `deletedAt: null` y por los ids que vienen del token ya validado.
 */
@Injectable()
export class AuthService {
  private readonly trialDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly userTokens: UserTokenService,
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.trialDays = config.get('TRIAL_DAYS', { infer: true });
  }

  /**
   * Crea, en una sola transacción: el usuario, el negocio, el empleado dueño,
   * la suscripción de prueba y las dos filas de configuración del tenant.
   * Si cualquier paso falla, no queda nada a medio crear.
   */
  async register(dto: RegisterDto): Promise<AuthTokensDto> {
    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Ya existe una cuenta con ese email');
    }

    const plan = await this.prisma.plan.findFirst({
      where: { slug: DEFAULT_PLAN_SLUG, isActive: true },
      select: { id: true },
    });

    if (!plan) {
      throw new InternalServerErrorException(
        `No está cargado el plan "${DEFAULT_PLAN_SLUG}". Corré: npx prisma db seed`,
      );
    }

    const slug = await this.generateUniqueSlug(dto.businessName);
    const passwordHash = await this.passwords.hash(dto.password);
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + this.trialDays * MS_PER_DAY);

    const { user, employee } = await this.prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone ?? null,
        },
        select: { id: true },
      });

      const tenant = await tx.tenant.create({
        data: {
          ownerUserId: createdUser.id,
          planId: plan.id,
          businessName: dto.businessName,
          slug,
          subscriptionStatus: SubscriptionStatus.TRIAL,
          trialEndsAt,
        },
        select: { id: true },
      });

      const createdEmployee = await tx.employee.create({
        data: {
          tenantId: tenant.id,
          userId: createdUser.id,
          role: EmployeeRole.OWNER,
          isOwner: true,
        },
        select: { id: true, tenantId: true, role: true },
      });

      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          status: SubscriptionStatus.TRIAL,
          currentPeriodStart: now,
          currentPeriodEnd: trialEndsAt,
        },
      });

      await tx.tenantBranding.create({
        data: { tenantId: tenant.id, displayName: dto.businessName },
      });

      await tx.tenantSettings.create({ data: { tenantId: tenant.id } });

      return { user: createdUser, employee: createdEmployee };
    });

    // Fuera de la transacción a propósito: el negocio ya está creado y no se
    // deshace porque el mail no salga. `MailService` no lanza.
    await this.sendVerificationEmail({
      id: user.id,
      email: dto.email,
      firstName: dto.firstName,
    });

    return this.issueTokens(user.id, employee);
  }

  async login(dto: LoginDto): Promise<AuthTokensDto> {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
      select: {
        id: true,
        passwordHash: true,
        // Prisma no admite `where` sobre una relación to-one: los descartes
        // (empleado borrado, inactivo o negocio dado de baja) se hacen abajo.
        employee: {
          select: {
            id: true,
            tenantId: true,
            role: true,
            isActive: true,
            deletedAt: true,
            tenant: { select: { deletedAt: true } },
          },
        },
      },
    });

    // `passwordHash` en null = empleado invitado que todavía no aceptó la
    // invitación. Se responde exactamente igual que a un email desconocido:
    // decir "esa cuenta existe pero está pendiente" delataría quién trabaja
    // en el negocio.
    if (!user || user.passwordHash === null) {
      // Gastamos el mismo tiempo que en el camino feliz para no delatar
      // qué emails están registrados.
      await this.passwords.burnTime();
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }

    const passwordMatches = await this.passwords.verify(
      user.passwordHash,
      dto.password,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }

    const employee = user.employee;

    if (
      !employee ||
      employee.deletedAt !== null ||
      !employee.isActive ||
      employee.tenant.deletedAt !== null
    ) {
      throw new UnauthorizedException('Tu acceso al negocio está desactivado');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.issueTokens(user.id, employee);
  }

  /** Rota el refresh token y emite un access token nuevo. */
  async refresh(presentedToken: string): Promise<AuthTokensDto> {
    const { userId, refreshToken } =
      await this.refreshTokens.rotate(presentedToken);

    const employee = await this.prisma.employee.findFirst({
      where: {
        userId,
        isActive: true,
        deletedAt: null,
        user: { deletedAt: null },
        tenant: { deletedAt: null },
      },
      select: { id: true, tenantId: true, role: true },
    });

    if (!employee) {
      throw new UnauthorizedException('La sesión ya no es válida');
    }

    const accessToken = await this.signAccessToken(userId, employee);

    return this.buildTokensResponse(accessToken, refreshToken);
  }

  async logout(presentedToken: string): Promise<void> {
    await this.refreshTokens.revokeSession(presentedToken);
  }

  async me(current: AuthenticatedUser): Promise<MeResponseDto> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: current.employeeId, deletedAt: null },
      select: {
        id: true,
        role: true,
        isOwner: true,
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            emailVerifiedAt: true,
          },
        },
        tenant: {
          select: {
            id: true,
            businessName: true,
            slug: true,
            timezone: true,
            currency: true,
            language: true,
            subscriptionStatus: true,
            trialEndsAt: true,
          },
        },
      },
    });

    if (!employee) {
      throw new UnauthorizedException('La sesión ya no es válida');
    }

    return {
      user: employee.user,
      tenant: employee.tenant,
      employee: {
        id: employee.id,
        role: employee.role,
        isOwner: employee.isOwner,
      },
    };
  }

  /**
   * Cambia la contraseña y cierra todas las sesiones abiertas.
   * Los access tokens ya emitidos siguen siendo válidos hasta que expiren
   * (15 minutos como máximo): no hay lista de revocación por diseño.
   */
  async changePassword(
    current: AuthenticatedUser,
    dto: ChangePasswordDto,
  ): Promise<void> {
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'La contraseña nueva tiene que ser distinta de la actual',
      );
    }

    const user = await this.prisma.user.findFirst({
      where: { id: current.userId, deletedAt: null },
      select: { id: true, passwordHash: true },
    });

    // Sin contraseña no se puede haber llegado hasta acá con un token válido,
    // pero el tipo lo admite: se trata igual que una sesión que ya no sirve.
    if (!user || user.passwordHash === null) {
      throw new UnauthorizedException('La sesión ya no es válida');
    }

    const matches = await this.passwords.verify(
      user.passwordHash,
      dto.currentPassword,
    );

    if (!matches) {
      throw new UnauthorizedException('La contraseña actual no es correcta');
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    await this.refreshTokens.revokeAllForUser(user.id);
  }

  /**
   * Manda el link para elegir una contraseña nueva.
   *
   * **Siempre responde igual**, exista o no la cuenta: si contestara distinto,
   * el endpoint sería un enumerador de emails registrados que cualquiera puede
   * usar sin credenciales.
   *
   * Lo que la respuesta uniforme NO tapa es el tiempo: el camino con cuenta
   * hace hash, escribe la base y espera al proveedor de mail, así que tarda más
   * que el otro. Lo que acota ese resto es el throttle de 5 intentos por
   * minuto; cerrarlo del todo es sacar el envío del request, que es trabajo de
   * la cola (Fase 8).
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
      select: { id: true, email: true, firstName: true, passwordHash: true },
    });

    // Un invitado que todavía no aceptó la invitación no tiene contraseña que
    // restablecer: su camino es el link de activación. Mandarle un reset le
    // daría una segunda forma de tomar la cuenta y confundiría el flujo.
    if (!user || user.passwordHash === null) {
      await this.passwords.burnTime();

      return;
    }

    const { url, expiresAt } = await this.userTokens.issue(
      user.id,
      UserTokenPurpose.PASSWORD_RESET,
    );

    await this.mail.sendPasswordReset({
      to: user.email,
      firstName: user.firstName,
      url,
      expiresAt,
    });
  }

  /**
   * Canjea el link y deja la contraseña nueva.
   *
   * Cierra todas las sesiones abiertas **dentro de la misma transacción** que
   * el cambio: si el reset se pidió porque alguien más entró a la cuenta,
   * dejarle la sesión viva volvería inútil el cambio de contraseña.
   *
   * El hash se calcula antes de abrir la transacción: argon2 tarda cientos de
   * milisegundos y no hay razón para tener la fila bloqueada mientras tanto.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const passwordHash = await this.passwords.hash(dto.password);

    await this.userTokens.consume(
      dto.token,
      UserTokenPurpose.PASSWORD_RESET,
      async (tx, userId) => {
        await tx.user.update({ where: { id: userId }, data: { passwordHash } });
        await this.refreshTokens.revokeAllForUser(userId, tx);
      },
    );
  }

  /**
   * Marca la casilla como confirmada.
   *
   * Es idempotente por el lado del token (un link sirve una sola vez), pero no
   * hace falta chequear si ya estaba verificado: escribir la fecha de nuevo no
   * rompe nada y evita un caso borde sin valor.
   */
  async verifyEmail(dto: VerifyEmailDto): Promise<void> {
    await this.userTokens.consume(
      dto.token,
      UserTokenPurpose.EMAIL_VERIFICATION,
      async (tx, userId) => {
        await tx.user.update({
          where: { id: userId },
          data: { emailVerifiedAt: new Date() },
        });
      },
    );
  }

  /**
   * Reenvía el mail de verificación al usuario logueado.
   *
   * Acá sí se puede decir "ya está confirmado" sin filtrar nada: el endpoint
   * pide token, así que quien pregunta ya es el dueño de la cuenta.
   */
  async resendEmailVerification(current: AuthenticatedUser): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: current.userId, deletedAt: null },
      select: { id: true, email: true, firstName: true, emailVerifiedAt: true },
    });

    if (!user) {
      throw new UnauthorizedException('La sesión ya no es válida');
    }

    if (user.emailVerifiedAt !== null) {
      throw new ConflictException('Tu email ya está confirmado');
    }

    await this.sendVerificationEmail(user);
  }

  /** Emite el token de verificación y manda el mail. No lanza si el mail falla. */
  private async sendVerificationEmail(user: {
    id: string;
    email: string;
    firstName: string;
  }): Promise<void> {
    const { url, expiresAt } = await this.userTokens.issue(
      user.id,
      UserTokenPurpose.EMAIL_VERIFICATION,
    );

    await this.mail.sendEmailVerification({
      to: user.email,
      firstName: user.firstName,
      url,
      expiresAt,
    });
  }

  private async issueTokens(
    userId: string,
    employee: { id: string; tenantId: string; role: EmployeeRole },
  ): Promise<AuthTokensDto> {
    const accessToken = await this.signAccessToken(userId, employee);
    const refreshToken = await this.refreshTokens.issue(userId);

    return this.buildTokensResponse(accessToken, refreshToken);
  }

  private signAccessToken(
    userId: string,
    employee: { id: string; tenantId: string; role: EmployeeRole },
  ): Promise<string> {
    const payload: JwtPayload = {
      sub: userId,
      tenantId: employee.tenantId,
      employeeId: employee.id,
      role: employee.role,
    };

    return this.jwt.signAsync(payload);
  }

  /** `expiresIn` sale del token firmado para no re-parsear la config. */
  private buildTokensResponse(
    accessToken: string,
    refreshToken: string,
  ): AuthTokensDto {
    const decoded = this.jwt.decode<{ exp: number; iat: number }>(accessToken);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: decoded.exp - decoded.iat,
    };
  }

  /**
   * Deriva un slug del nombre del negocio y le agrega `-2`, `-3`… hasta que
   * no choque con otro tenant ni con una palabra reservada.
   *
   * Hay una ventana de carrera entre el chequeo y el insert; la cubre el
   * UNIQUE de la columna, que el filtro global traduce a 409.
   */
  private async generateUniqueSlug(businessName: string): Promise<string> {
    const base = slugify(businessName) || FALLBACK_SLUG_PREFIX;

    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`;

      if (isReservedSlug(candidate)) {
        continue;
      }

      const taken = await this.prisma.tenant.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });

      if (!taken) {
        return candidate;
      }
    }

    // Caso patológico (20 negocios con el mismo nombre): sufijo aleatorio.
    return `${base}-${Date.now().toString(36)}`;
  }
}
