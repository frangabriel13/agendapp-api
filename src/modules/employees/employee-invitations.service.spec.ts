import { BadRequestException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PasswordService } from '../auth/password.service';
import { EmployeeInvitationService } from './employee-invitations.service';

const INVITATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = `${INVITATION_ID}.un-secreto-cualquiera`;

/** Una invitación en el único estado en el que se puede aceptar. */
function validInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITATION_ID,
    tokenHash: 'hash',
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
    revokedAt: null,
    employee: {
      id: 'employee-1',
      isActive: true,
      deletedAt: null,
      userId: USER_ID,
      user: { passwordHash: null, deletedAt: null },
      tenant: { deletedAt: null },
    },
    ...overrides,
  };
}

describe('EmployeeInvitationService', () => {
  let service: EmployeeInvitationService;
  let prisma: {
    employeeInvitation: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let passwords: {
    hash: jest.Mock;
    verify: jest.Mock;
    burnTime: jest.Mock;
  };
  let tx: {
    user: { update: jest.Mock };
    employeeInvitation: { update: jest.Mock };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    // En los unitarios no hay pino: sin esto, cada activación escupe un log.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    tx = {
      user: { update: jest.fn().mockResolvedValue({}) },
      employeeInvitation: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      employeeInvitation: {
        findUnique: jest.fn().mockResolvedValue(validInvitation()),
      },
      $transaction: jest.fn((callback: (client: unknown) => unknown) =>
        callback(tx),
      ),
    };
    passwords = {
      hash: jest.fn().mockResolvedValue('hash-nuevo'),
      verify: jest.fn().mockResolvedValue(true),
      burnTime: jest.fn().mockResolvedValue(undefined),
    };

    const config = {
      get: (key: string) =>
        key === 'APP_BASE_URL' ? 'https://app.agendapp.test/' : 72,
    };

    service = new EmployeeInvitationService(
      prisma as unknown as PrismaService,
      passwords as unknown as PasswordService,
      config as unknown as ConfigService<never, true>,
    );
  });

  describe('mint', () => {
    it('devuelve el secreto en claro y su hash por separado', async () => {
      const minted = await service.mint();

      expect(minted.secret).toHaveLength(43); // 32 bytes en base64url
      expect(minted.tokenHash).toBe('hash-nuevo');
      expect(passwords.hash).toHaveBeenCalledWith(minted.secret);
    });

    it('cada invitación tiene un secreto distinto', async () => {
      const uno = await service.mint();
      const dos = await service.mint();

      expect(uno.secret).not.toBe(dos.secret);
    });

    it('vence dentro de la ventana configurada', async () => {
      const { expiresAt } = await service.mint();

      const horas = (expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(horas).toBeGreaterThan(71);
      expect(horas).toBeLessThanOrEqual(72);
    });
  });

  describe('buildActivationUrl', () => {
    it('arma el link del frontend con el token completo', () => {
      const url = service.buildActivationUrl(INVITATION_ID, 'secreto');

      // La barra sobrante de APP_BASE_URL no se duplica.
      expect(url).toBe(
        `https://app.agendapp.test/activar?token=${INVITATION_ID}.secreto`,
      );
    });

    it('escapa los caracteres raros del secreto', () => {
      const url = service.buildActivationUrl(INVITATION_ID, 'a+b/c=d');

      expect(url).toContain('a%2Bb%2Fc%3Dd');
    });
  });

  describe('accept', () => {
    const password = 'claveNueva123';

    it('guarda la contraseña y marca la invitación como usada', async () => {
      await service.accept({ token: TOKEN, password });

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { passwordHash: 'hash-nuevo' },
      });
      const [{ where, data }] = tx.employeeInvitation.update.mock.calls[0] as [
        { where: object; data: { acceptedAt: Date } },
      ];
      expect(where).toEqual({ id: INVITATION_ID });
      expect(data.acceptedAt).toBeInstanceOf(Date);
    });

    it('escribe las dos cosas en la misma transacción', async () => {
      await service.accept({ token: TOKEN, password });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('rechaza un token mal formado sin ir a la base', async () => {
      await expect(
        service.accept({ token: 'no-es-un-token', password }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.employeeInvitation.findUnique).not.toHaveBeenCalled();
      // Igual gasta tiempo: si no, se puede distinguir por latencia.
      expect(passwords.burnTime).toHaveBeenCalled();
    });

    it('rechaza un id que no existe', async () => {
      prisma.employeeInvitation.findUnique.mockResolvedValue(null);

      await expect(
        service.accept({ token: TOKEN, password }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(passwords.burnTime).toHaveBeenCalled();
    });

    it('rechaza el secreto incorrecto', async () => {
      passwords.verify.mockResolvedValue(false);

      await expect(
        service.accept({ token: TOKEN, password }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it.each([
      ['ya aceptada', { acceptedAt: new Date() }],
      ['revocada', { revokedAt: new Date() }],
      ['vencida', { expiresAt: new Date(Date.now() - 1000) }],
    ])('rechaza una invitación %s', async (_caso, overrides) => {
      prisma.employeeInvitation.findUnique.mockResolvedValue(
        validInvitation(overrides),
      );

      await expect(
        service.accept({ token: TOKEN, password }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['borrado', { deletedAt: new Date() }],
      ['desactivado', { isActive: false }],
    ])('rechaza si el empleado está %s', async (_caso, employeeOverrides) => {
      const invitation = validInvitation();
      prisma.employeeInvitation.findUnique.mockResolvedValue({
        ...invitation,
        employee: { ...invitation.employee, ...employeeOverrides },
      });

      await expect(
        service.accept({ token: TOKEN, password }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza si el negocio fue dado de baja', async () => {
      const invitation = validInvitation();
      prisma.employeeInvitation.findUnique.mockResolvedValue({
        ...invitation,
        employee: {
          ...invitation.employee,
          tenant: { deletedAt: new Date() },
        },
      });

      await expect(
        service.accept({ token: TOKEN, password }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * El caso feo: si la invitación siguiera sirviendo después de activar la
     * cuenta, sería un cambio de contraseña gratis para quien tenga el link.
     */
    it('rechaza si el usuario ya tiene contraseña', async () => {
      const invitation = validInvitation();
      prisma.employeeInvitation.findUnique.mockResolvedValue({
        ...invitation,
        employee: {
          ...invitation.employee,
          user: { passwordHash: 'ya-tiene', deletedAt: null },
        },
      });

      await expect(
        service.accept({ token: TOKEN, password }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('todos los rechazos dicen exactamente lo mismo', async () => {
      const mensajes: string[] = [];

      const casos = [
        () => prisma.employeeInvitation.findUnique.mockResolvedValue(null),
        () =>
          prisma.employeeInvitation.findUnique.mockResolvedValue(
            validInvitation({ acceptedAt: new Date() }),
          ),
        () =>
          prisma.employeeInvitation.findUnique.mockResolvedValue(
            validInvitation({ expiresAt: new Date(Date.now() - 1000) }),
          ),
      ];

      for (const preparar of casos) {
        preparar();
        await service
          .accept({ token: TOKEN, password })
          .catch((error: Error) => mensajes.push(error.message));
      }

      expect(new Set(mensajes).size).toBe(1);
    });
  });
});
