import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EmployeeRole } from '@prisma/client';
import type { TenantContextService } from '../../common/tenant-context';
import type { PrismaService } from '../../prisma/prisma.service';
import type { EmployeeInvitationService } from './employee-invitations.service';
import { EmployeesService } from './employees.service';
import type { EmployeeShiftDto } from './dto/employee-schedule.dto';
import { EmployeeStatus, type InviteEmployeeDto } from './dto/employee.dto';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';
const BRANCH_A = '33333333-3333-4333-8333-333333333333';
const BRANCH_B = '44444444-4444-4444-8444-444444444444';

const EMPLOYEE_ROW = {
  id: EMPLOYEE_ID,
  role: EmployeeRole.PROFESSIONAL,
  isOwner: false,
  isActive: true,
  hiredAt: null as Date | null,
  bio: null,
  avatarUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  user: {
    id: 'user-1',
    email: 'ana@e2e.test',
    firstName: 'Ana',
    lastName: 'Gómez',
    phone: null,
    passwordHash: null as string | null,
  },
};

const VALID_INVITE: InviteEmployeeDto = {
  email: 'ana@e2e.test',
  firstName: 'Ana',
  lastName: 'Gómez',
  role: EmployeeRole.PROFESSIONAL,
};

describe('EmployeesService', () => {
  let service: EmployeesService;
  let prisma: {
    user: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    scoped: {
      user: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
      $transaction: jest.Mock;
      tenant: { findFirst: jest.Mock };
      branch: { findMany: jest.Mock };
      employee: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        count: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
      employeeBranch: {
        findMany: jest.Mock;
        createMany: jest.Mock;
        deleteMany: jest.Mock;
      };
      employeeSchedule: {
        findMany: jest.Mock;
        createMany: jest.Mock;
        deleteMany: jest.Mock;
      };
      employeeInvitation: { create: jest.Mock; updateMany: jest.Mock };
      employeeTimeOff: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        create: jest.Mock;
        delete: jest.Mock;
      };
    };
  };
  let tenantContext: { getTenantId: jest.Mock; getEmployeeId: jest.Mock };
  let invitations: { mint: jest.Mock; buildActivationUrl: jest.Mock };

  function planWith(maxEmployees: number | null, name = 'Pro'): void {
    prisma.scoped.tenant.findFirst.mockResolvedValue({
      plan: { name, maxEmployees },
    });
  }

  /** El empleado trabaja en estas sucursales. */
  function assignedTo(...branchIds: string[]): void {
    prisma.scoped.employeeBranch.findMany.mockResolvedValue(
      branchIds.map((branchId) => ({ branchId })),
    );
  }

  beforeEach(() => {
    // `User` está exento del tenant-scope, así que el cliente extendido lo
    // expone igual que el base: los dos apuntan a los mismos mocks, como pasa
    // de verdad con la extension (que hace passthrough en los exentos).
    const user = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'user-1' }),
      update: jest.fn().mockResolvedValue({}),
    };

    prisma = {
      user,
      scoped: {
        user,
        $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
          callback(prisma.scoped),
        ),
        tenant: { findFirst: jest.fn() },
        branch: { findMany: jest.fn().mockResolvedValue([]) },
        employee: {
          findFirst: jest.fn().mockResolvedValue(EMPLOYEE_ROW),
          findMany: jest.fn().mockResolvedValue([EMPLOYEE_ROW]),
          count: jest.fn().mockResolvedValue(1),
          create: jest.fn().mockResolvedValue(EMPLOYEE_ROW),
          update: jest.fn().mockResolvedValue(EMPLOYEE_ROW),
          delete: jest.fn().mockResolvedValue(EMPLOYEE_ROW),
        },
        employeeBranch: {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        employeeSchedule: {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        employeeInvitation: {
          create: jest.fn().mockResolvedValue({ id: 'invitation-1' }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        employeeTimeOff: {
          findFirst: jest.fn().mockResolvedValue({ id: 'time-off-1' }),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue({ id: 'time-off-1' }),
          delete: jest.fn().mockResolvedValue({}),
        },
      },
    };
    tenantContext = {
      getTenantId: jest.fn().mockReturnValue(TENANT_ID),
      getEmployeeId: jest.fn().mockReturnValue('otro-empleado'),
    };
    invitations = {
      mint: jest.fn().mockResolvedValue({
        secret: 'secreto',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      buildActivationUrl: jest.fn().mockReturnValue('https://app.test/activar'),
    };
    planWith(null);

    service = new EmployeesService(
      prisma as unknown as PrismaService,
      tenantContext as unknown as TenantContextService,
      invitations as unknown as EmployeeInvitationService,
    );
  });

  describe('invite', () => {
    it('crea el usuario SIN contraseña', async () => {
      await service.invite(VALID_INVITE);

      const [{ data }] = prisma.user.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.passwordHash).toBeNull();
    });

    it('crea usuario, empleado e invitación en una sola transacción', async () => {
      await service.invite(VALID_INVITE);

      expect(prisma.scoped.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.scoped.employee.create).toHaveBeenCalledTimes(1);
      expect(prisma.scoped.employeeInvitation.create).toHaveBeenCalledTimes(1);
    });

    it('el empleado nace sin ser dueño y sin tenantId a mano', async () => {
      await service.invite(VALID_INVITE);

      const [{ data }] = prisma.scoped.employee.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.isOwner).toBe(false);
      expect(data).not.toHaveProperty('tenantId');
    });

    it('guarda el hash del token, nunca el secreto', async () => {
      await service.invite(VALID_INVITE);

      const [{ data }] = prisma.scoped.employeeInvitation.create.mock
        .calls[0] as [{ data: Record<string, unknown> }];
      expect(data.tokenHash).toBe('hash');
      expect(JSON.stringify(data)).not.toContain('secreto');
    });

    it('rechaza un email que ya tiene cuenta', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'otro-user' });

      await expect(service.invite(VALID_INVITE)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rechaza sucursales que no son del negocio', async () => {
      prisma.scoped.branch.findMany.mockResolvedValue([{ id: BRANCH_A }]);

      await expect(
        service.invite({ ...VALID_INVITE, branchIds: [BRANCH_A, BRANCH_B] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('devuelve el link de activación una sola vez', async () => {
      const response = await service.invite(VALID_INVITE);

      expect(invitations.buildActivationUrl).toHaveBeenCalledWith(
        'invitation-1',
        'secreto',
      );
      expect(response.activationUrl).toBe('https://app.test/activar');
    });
  });

  describe('límite de empleados del plan', () => {
    it('el dueño cuenta para el límite', async () => {
      planWith(1, 'Básico');
      prisma.scoped.employee.count.mockResolvedValue(1); // solo el dueño

      await expect(service.invite(VALID_INVITE)).rejects.toThrow(
        /Básico permite hasta 1 empleado/,
      );
    });

    it('deja invitar mientras haya lugar', async () => {
      planWith(4);
      prisma.scoped.employee.count.mockResolvedValue(3);

      await expect(service.invite(VALID_INVITE)).resolves.toBeDefined();
    });

    it('sin tope no cuenta siquiera', async () => {
      planWith(null, 'Empresa');

      await service.invite(VALID_INVITE);

      expect(prisma.scoped.employee.count).not.toHaveBeenCalled();
    });
  });

  describe('protecciones del dueño', () => {
    beforeEach(() => {
      prisma.scoped.employee.findFirst.mockResolvedValue({
        ...EMPLOYEE_ROW,
        isOwner: true,
        role: EmployeeRole.OWNER,
      });
    });

    it('no se le cambia el rol', async () => {
      await expect(
        service.update(EMPLOYEE_ID, { role: EmployeeRole.PROFESSIONAL }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('no se lo desactiva', async () => {
      await expect(
        service.update(EMPLOYEE_ID, { isActive: false }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('no se lo da de baja', async () => {
      await expect(service.remove(EMPLOYEE_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.scoped.employee.delete).not.toHaveBeenCalled();
    });

    it('pero sí se le puede editar la bio', async () => {
      await expect(
        service.update(EMPLOYEE_ID, { bio: 'Dueña y colorista' }),
      ).resolves.toBeDefined();
    });
  });

  describe('protecciones sobre uno mismo', () => {
    beforeEach(() => {
      tenantContext.getEmployeeId.mockReturnValue(EMPLOYEE_ID);
    });

    it('no podés desactivarte', async () => {
      await expect(
        service.update(EMPLOYEE_ID, { isActive: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no podés darte de baja', async () => {
      await expect(service.remove(EMPLOYEE_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('pero sí podés editarte otras cosas', async () => {
      await expect(
        service.update(EMPLOYEE_ID, { bio: 'Nueva bio' }),
      ).resolves.toBeDefined();
    });
  });

  describe('horario semanal', () => {
    const shift = (
      branchId: string,
      dayOfWeek: number,
      startsAt: string,
      endsAt: string,
    ): EmployeeShiftDto => ({ branchId, dayOfWeek, startsAt, endsAt });

    beforeEach(() => {
      assignedTo(BRANCH_A, BRANCH_B);
    });

    it('acepta un turno partido el mismo día', async () => {
      await service.setSchedules(EMPLOYEE_ID, {
        shifts: [
          shift(BRANCH_A, 1, '09:00', '13:00'),
          shift(BRANCH_A, 1, '16:00', '20:00'),
        ],
      });

      const [{ data }] = prisma.scoped.employeeSchedule.createMany.mock
        .calls[0] as [{ data: unknown[] }];
      expect(data).toHaveLength(2);
    });

    it('acepta dos tramos pegados (uno termina donde arranca el otro)', async () => {
      await expect(
        service.setSchedules(EMPLOYEE_ID, {
          shifts: [
            shift(BRANCH_A, 1, '09:00', '13:00'),
            shift(BRANCH_A, 1, '13:00', '17:00'),
          ],
        }),
      ).resolves.toBeDefined();
    });

    it('rechaza tramos que se pisan en la misma sucursal', async () => {
      await expect(
        service.setSchedules(EMPLOYEE_ID, {
          shifts: [
            shift(BRANCH_A, 1, '09:00', '13:00'),
            shift(BRANCH_A, 1, '12:00', '16:00'),
          ],
        }),
      ).rejects.toThrow(/se pisan/);
    });

    /** Lo importante: la persona es una sola, aunque las sucursales sean dos. */
    it('rechaza tramos que se pisan en sucursales distintas', async () => {
      await expect(
        service.setSchedules(EMPLOYEE_ID, {
          shifts: [
            shift(BRANCH_A, 1, '09:00', '13:00'),
            shift(BRANCH_B, 1, '12:00', '16:00'),
          ],
        }),
      ).rejects.toThrow(/dos lugares a la vez/);
    });

    it('el mismo horario en días distintos no se pisa', async () => {
      await expect(
        service.setSchedules(EMPLOYEE_ID, {
          shifts: [
            shift(BRANCH_A, 1, '09:00', '13:00'),
            shift(BRANCH_B, 2, '09:00', '13:00'),
          ],
        }),
      ).resolves.toBeDefined();
    });

    it('rechaza un tramo que termina antes de empezar', async () => {
      await expect(
        service.setSchedules(EMPLOYEE_ID, {
          shifts: [shift(BRANCH_A, 1, '18:00', '09:00')],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza una sucursal donde el empleado no trabaja', async () => {
      assignedTo(BRANCH_A);

      await expect(
        service.setSchedules(EMPLOYEE_ID, {
          shifts: [shift(BRANCH_B, 1, '09:00', '13:00')],
        }),
      ).rejects.toThrow(/no trabaja en la sucursal/);
    });

    it('si algo viene mal no toca la base', async () => {
      await expect(
        service.setSchedules(EMPLOYEE_ID, {
          shifts: [shift(BRANCH_A, 1, '18:00', '09:00')],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.scoped.employeeSchedule.deleteMany).not.toHaveBeenCalled();
      expect(prisma.scoped.$transaction).not.toHaveBeenCalled();
    });

    it('un set vacío borra el horario sin insertar nada', async () => {
      await service.setSchedules(EMPLOYEE_ID, { shifts: [] });

      expect(prisma.scoped.employeeSchedule.deleteMany).toHaveBeenCalled();
      expect(prisma.scoped.employeeSchedule.createMany).not.toHaveBeenCalled();
    });
  });

  describe('sucursales asignadas', () => {
    it('borra el horario de las sucursales que se le sacan', async () => {
      prisma.scoped.branch.findMany.mockResolvedValue([{ id: BRANCH_A }]);

      await service.setBranches(EMPLOYEE_ID, { branchIds: [BRANCH_A] });

      const [{ where }] = prisma.scoped.employeeSchedule.deleteMany.mock
        .calls[0] as [{ where: { branchId?: { notIn: string[] } } }];
      expect(where.branchId).toEqual({ notIn: [BRANCH_A] });
    });

    it('sin sucursales, borra todo el horario', async () => {
      await service.setBranches(EMPLOYEE_ID, { branchIds: [] });

      const [{ where }] = prisma.scoped.employeeSchedule.deleteMany.mock
        .calls[0] as [{ where: Record<string, unknown> }];
      expect(where).toEqual({ employeeId: EMPLOYEE_ID });
      expect(prisma.scoped.employeeBranch.createMany).not.toHaveBeenCalled();
    });
  });

  describe('ausencias', () => {
    it('rechaza una que termina antes de empezar', async () => {
      await expect(
        service.createTimeOff(EMPLOYEE_ID, {
          startsAt: '2026-01-20T00:00:00Z',
          endsAt: '2026-01-05T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sin sucursal, aplica a todas', async () => {
      await service.createTimeOff(EMPLOYEE_ID, {
        startsAt: '2026-01-05T00:00:00Z',
        endsAt: '2026-01-20T00:00:00Z',
      });

      const [{ data }] = prisma.scoped.employeeTimeOff.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.branchId).toBeNull();
    });

    it('filtra por solapamiento, no por contención', async () => {
      await service.findTimeOff(EMPLOYEE_ID, {
        from: '2026-02-01T00:00:00Z',
        to: '2026-02-28T00:00:00Z',
      });

      const [{ where }] = prisma.scoped.employeeTimeOff.findMany.mock
        .calls[0] as [{ where: { startsAt?: object; endsAt?: object } }];
      // Empieza antes del fin del rango Y termina después del inicio.
      expect(where.startsAt).toEqual({ lte: new Date('2026-02-28T00:00:00Z') });
      expect(where.endsAt).toEqual({ gte: new Date('2026-02-01T00:00:00Z') });
    });

    it('una ausencia de otro empleado no existe', async () => {
      prisma.scoped.employeeTimeOff.findFirst.mockResolvedValue(null);

      await expect(
        service.removeTimeOff(EMPLOYEE_ID, 'time-off-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.scoped.employeeTimeOff.delete).not.toHaveBeenCalled();
    });
  });

  describe('respuesta', () => {
    it('nunca incluye el hash de la contraseña', async () => {
      prisma.scoped.employee.findFirst.mockResolvedValue({
        ...EMPLOYEE_ROW,
        user: { ...EMPLOYEE_ROW.user, passwordHash: '$argon2id$secreto' },
      });

      const employee = await service.findOne(EMPLOYEE_ID);

      expect(JSON.stringify(employee)).not.toContain('argon2');
      expect(employee.user).not.toHaveProperty('passwordHash');
    });

    it('deriva el estado de si ya tiene contraseña', async () => {
      const pendiente = await service.findOne(EMPLOYEE_ID);
      expect(pendiente.status).toBe(EmployeeStatus.PENDING);

      prisma.scoped.employee.findFirst.mockResolvedValue({
        ...EMPLOYEE_ROW,
        user: { ...EMPLOYEE_ROW.user, passwordHash: 'hash' },
      });

      const activo = await service.findOne(EMPLOYEE_ID);
      expect(activo.status).toBe(EmployeeStatus.ACTIVE);
    });

    it('devuelve la fecha de ingreso como YYYY-MM-DD', async () => {
      prisma.scoped.employee.findFirst.mockResolvedValue({
        ...EMPLOYEE_ROW,
        hiredAt: new Date('2026-03-01T00:00:00.000Z'),
      });

      const employee = await service.findOne(EMPLOYEE_ID);

      expect(employee.hiredAt).toBe('2026-03-01');
    });
  });

  describe('empleado ajeno o inexistente', () => {
    beforeEach(() => {
      prisma.scoped.employee.findFirst.mockResolvedValue(null);
    });

    it.each([
      ['findOne', () => service.findOne(EMPLOYEE_ID)],
      ['update', () => service.update(EMPLOYEE_ID, { bio: 'x' })],
      ['remove', () => service.remove(EMPLOYEE_ID)],
      ['resendInvitation', () => service.resendInvitation(EMPLOYEE_ID)],
      [
        'setBranches',
        () => service.setBranches(EMPLOYEE_ID, { branchIds: [] }),
      ],
      ['setSchedules', () => service.setSchedules(EMPLOYEE_ID, { shifts: [] })],
      ['findSchedules', () => service.findSchedules(EMPLOYEE_ID)],
      ['findTimeOff', () => service.findTimeOff(EMPLOYEE_ID, {})],
    ])('%s responde 404', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reenviar invitación', () => {
    it('revoca las anteriores antes de emitir la nueva', async () => {
      await service.resendInvitation(EMPLOYEE_ID);

      const [{ where, data }] = prisma.scoped.employeeInvitation.updateMany.mock
        .calls[0] as [{ where: object; data: { revokedAt: Date } }];
      expect(where).toEqual({
        employeeId: EMPLOYEE_ID,
        acceptedAt: null,
        revokedAt: null,
      });
      expect(data.revokedAt).toBeInstanceOf(Date);
      expect(prisma.scoped.employeeInvitation.create).toHaveBeenCalledTimes(1);
    });

    it('no tiene sentido si ya eligió contraseña', async () => {
      prisma.scoped.employee.findFirst.mockResolvedValue({
        ...EMPLOYEE_ROW,
        user: { ...EMPLOYEE_ROW.user, passwordHash: 'hash' },
      });

      await expect(
        service.resendInvitation(EMPLOYEE_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.scoped.employeeInvitation.create).not.toHaveBeenCalled();
    });
  });
});
