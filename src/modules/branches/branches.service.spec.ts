import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import type { TenantContextService } from '../../common/tenant-context';
import type { PrismaService } from '../../prisma/prisma.service';
import { BranchesService } from './branches.service';
import type { BusinessHourDto } from './dto/business-hours.dto';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const SPECIAL_DAY_ID = '33333333-3333-4333-8333-333333333333';

const BRANCH_ROW = {
  id: BRANCH_ID,
  name: 'Sucursal Centro',
  address: null,
  phone: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const SPECIAL_DAY_ROW = {
  id: SPECIAL_DAY_ID,
  date: new Date('2026-12-25T00:00:00.000Z'),
  isClosed: true,
  opensAt: null as Date | null,
  closesAt: null as Date | null,
  description: 'Navidad',
};

/** Una semana válida: cerrada los domingos, abierta el resto. */
function validWeek(): BusinessHourDto[] {
  return Array.from({ length: 7 }, (_, dayOfWeek) =>
    dayOfWeek === 0
      ? { dayOfWeek, isClosed: true }
      : { dayOfWeek, opensAt: '09:00', closesAt: '18:00' },
  );
}

describe('BranchesService', () => {
  let service: BranchesService;
  let prisma: {
    scoped: {
      $transaction: jest.Mock;
      $queryRaw: jest.Mock;
      tenant: { findFirst: jest.Mock };
      branch: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        count: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
      branchBusinessHour: {
        findMany: jest.Mock;
        createMany: jest.Mock;
        deleteMany: jest.Mock;
      };
      branchSpecialDay: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
    };
  };
  let tenantContext: { getTenantId: jest.Mock };

  /** El plan que devuelve el tenant mockeado. `null` = sin límite. */
  function planWith(maxBranches: number | null, name = 'Básico'): void {
    prisma.scoped.tenant.findFirst.mockResolvedValue({
      plan: { name, maxBranches },
    });
  }

  beforeEach(() => {
    prisma = {
      scoped: {
        // El callback recibe el mismo mock: alcanza para verificar qué se
        // llamó adentro de la transacción.
        $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
          callback(prisma.scoped),
        ),
        $queryRaw: jest.fn().mockResolvedValue([]),
        tenant: { findFirst: jest.fn() },
        branch: {
          findFirst: jest.fn().mockResolvedValue(BRANCH_ROW),
          findMany: jest.fn().mockResolvedValue([BRANCH_ROW]),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue(BRANCH_ROW),
          update: jest.fn().mockResolvedValue(BRANCH_ROW),
          delete: jest.fn().mockResolvedValue(BRANCH_ROW),
        },
        branchBusinessHour: {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: jest.fn().mockResolvedValue({ count: 7 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
        },
        branchSpecialDay: {
          findFirst: jest.fn().mockResolvedValue(SPECIAL_DAY_ROW),
          findMany: jest.fn().mockResolvedValue([SPECIAL_DAY_ROW]),
          create: jest.fn().mockResolvedValue(SPECIAL_DAY_ROW),
          update: jest.fn().mockResolvedValue(SPECIAL_DAY_ROW),
          delete: jest.fn().mockResolvedValue(SPECIAL_DAY_ROW),
        },
      },
    };
    tenantContext = { getTenantId: jest.fn().mockReturnValue(TENANT_ID) };
    planWith(null);

    service = new BranchesService(
      prisma as unknown as PrismaService,
      tenantContext as unknown as TenantContextService,
    );
  });

  describe('límite de sucursales del plan', () => {
    it('deja crear si el plan no tiene tope', async () => {
      planWith(null, 'Empresa');
      prisma.scoped.branch.count.mockResolvedValue(99);

      await expect(service.create({ name: 'Otra' })).resolves.toMatchObject({
        id: BRANCH_ID,
      });
      // Con maxBranches null ni se molesta en contar.
      expect(prisma.scoped.branch.count).not.toHaveBeenCalled();
    });

    it('deja crear mientras haya lugar', async () => {
      planWith(3);
      prisma.scoped.branch.count.mockResolvedValue(2);

      await expect(service.create({ name: 'Otra' })).resolves.toBeDefined();
    });

    it('corta cuando el plan llegó al tope', async () => {
      planWith(1);
      prisma.scoped.branch.count.mockResolvedValue(1);

      await expect(service.create({ name: 'Otra' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.scoped.branch.create).not.toHaveBeenCalled();
    });

    it('el mensaje del tope dice el plan y el número', async () => {
      planWith(2, 'Profesional');
      prisma.scoped.branch.count.mockResolvedValue(2);

      await expect(service.create({ name: 'Otra' })).rejects.toThrow(
        /Profesional permite hasta 2 sucursales/,
      );
    });

    /**
     * Sin el lock, dos altas simultáneas contarían las dos lo mismo y pasarían
     * las dos. Se toma dentro de la transacción y antes de contar.
     */
    it('lockea la fila del negocio antes de contar', async () => {
      planWith(3);

      await service.create({ name: 'Otra' });

      expect(prisma.scoped.$queryRaw).toHaveBeenCalledTimes(1);
      const lockOrder = prisma.scoped.$queryRaw.mock.invocationCallOrder[0];
      const countOrder = prisma.scoped.branch.count.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(countOrder);
    });

    it('con plan sin tope no lockea nada', async () => {
      planWith(null, 'Empresa');

      await service.create({ name: 'Otra' });

      expect(prisma.scoped.$queryRaw).not.toHaveBeenCalled();
    });

    it('sin contexto de tenant es un error de wiring, no del cliente', async () => {
      tenantContext.getTenantId.mockReturnValue(undefined);

      await expect(service.create({ name: 'Otra' })).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
    });
  });

  describe('create', () => {
    it('crea la sucursal y los 7 días en la misma transacción', async () => {
      await service.create({ name: 'Sucursal Centro' });

      expect(prisma.scoped.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.scoped.branchBusinessHour.createMany).toHaveBeenCalledTimes(
        1,
      );

      const [{ data }] = prisma.scoped.branchBusinessHour.createMany.mock
        .calls[0] as [{ data: { dayOfWeek: number }[] }];
      expect(data).toHaveLength(7);
      expect(data.map((row) => row.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('sin horarios, abre de lunes a viernes de 09:00 a 18:00', async () => {
      await service.create({ name: 'Sucursal Centro' });

      const [{ data }] = prisma.scoped.branchBusinessHour.createMany.mock
        .calls[0] as [
        {
          data: {
            dayOfWeek: number;
            isClosed: boolean;
            opensAt: Date | null;
          }[];
        },
      ];

      expect(
        data.filter((row) => row.isClosed).map((row) => row.dayOfWeek),
      ).toEqual([0, 6]);
      expect(data[1].opensAt?.toISOString()).toBe('1970-01-01T09:00:00.000Z');
    });

    it('NO manda el tenantId: lo pone la extension', async () => {
      await service.create({ name: 'Sucursal Centro' });

      const [{ data }] = prisma.scoped.branch.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('tenantId');
    });

    it('traduce el nombre repetido a un 409', async () => {
      prisma.scoped.branch.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '7.0.0',
        }),
      );

      await expect(service.create({ name: 'Repetida' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('validación del horario semanal', () => {
    it('exige los 7 días', async () => {
      const week = validWeek().slice(0, 6);

      await expect(
        service.setBusinessHours(BRANCH_ID, { days: week }),
      ).rejects.toThrow(/7 días/);
    });

    it('rechaza un día repetido', async () => {
      const week = validWeek();
      week[6] = { dayOfWeek: 1, opensAt: '09:00', closesAt: '18:00' };

      await expect(
        service.setBusinessHours(BRANCH_ID, { days: week }),
      ).rejects.toThrow(/repetido/);
    });

    it('exige las dos horas en un día abierto', async () => {
      const week = validWeek();
      week[1] = { dayOfWeek: 1, opensAt: '09:00' };

      await expect(
        service.setBusinessHours(BRANCH_ID, { days: week }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza que cierre antes de abrir', async () => {
      const week = validWeek();
      week[1] = { dayOfWeek: 1, opensAt: '18:00', closesAt: '09:00' };

      await expect(
        service.setBusinessHours(BRANCH_ID, { days: week }),
      ).rejects.toThrow(/no cierra después de abrir/);
    });

    it('rechaza abrir y cerrar a la misma hora', async () => {
      const week = validWeek();
      week[1] = { dayOfWeek: 1, opensAt: '09:00', closesAt: '09:00' };

      await expect(
        service.setBusinessHours(BRANCH_ID, { days: week }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('en un día cerrado descarta las horas en vez de rebotar', async () => {
      const week = validWeek();
      week[0] = {
        dayOfWeek: 0,
        isClosed: true,
        opensAt: '09:00',
        closesAt: '18:00',
      };

      await service.setBusinessHours(BRANCH_ID, { days: week });

      const [{ data }] = prisma.scoped.branchBusinessHour.createMany.mock
        .calls[0] as [{ data: { opensAt: Date | null }[] }];
      expect(data[0]).toMatchObject({
        isClosed: true,
        opensAt: null,
        closesAt: null,
      });
    });

    it('reemplaza la semana entera: borra y vuelve a insertar', async () => {
      await service.setBusinessHours(BRANCH_ID, { days: validWeek() });

      expect(prisma.scoped.branchBusinessHour.deleteMany).toHaveBeenCalledWith({
        where: { branchId: BRANCH_ID },
      });
      expect(prisma.scoped.$transaction).toHaveBeenCalledTimes(1);
    });

    it('no toca la base si la semana viene mal', async () => {
      await expect(
        service.setBusinessHours(BRANCH_ID, { days: validWeek().slice(0, 3) }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(
        prisma.scoped.branchBusinessHour.deleteMany,
      ).not.toHaveBeenCalled();
      expect(prisma.scoped.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('sucursal ajena o inexistente', () => {
    beforeEach(() => {
      // La extension ya filtró por tenant: si no aparece, no es de este negocio.
      prisma.scoped.branch.findFirst.mockResolvedValue(null);
    });

    it.each([
      ['findOne', () => service.findOne(BRANCH_ID)],
      ['update', () => service.update(BRANCH_ID, { name: 'Otra' })],
      ['remove', () => service.remove(BRANCH_ID)],
      ['findBusinessHours', () => service.findBusinessHours(BRANCH_ID)],
      [
        'setBusinessHours',
        () => service.setBusinessHours(BRANCH_ID, { days: validWeek() }),
      ],
      ['findSpecialDays', () => service.findSpecialDays(BRANCH_ID, {})],
      [
        'createSpecialDay',
        () => service.createSpecialDay(BRANCH_ID, { date: '2026-12-25' }),
      ],
    ])('%s responde 404', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('con body vacío devuelve la sucursal sin tocar la base', async () => {
      await expect(service.update(BRANCH_ID, {})).resolves.toMatchObject({
        id: BRANCH_ID,
      });

      expect(prisma.scoped.branch.update).not.toHaveBeenCalled();
    });

    it('deja borrar la dirección con null explícito', async () => {
      await service.update(BRANCH_ID, { address: null });

      const [{ data }] = prisma.scoped.branch.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toEqual({ address: null });
    });

    it('solo manda lo que vino en el PATCH', async () => {
      await service.update(BRANCH_ID, { isActive: false });

      const [{ data }] = prisma.scoped.branch.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toEqual({ isActive: false });
    });
  });

  describe('días especiales', () => {
    it('por defecto se cargan como feriado (cerrado, sin horas)', async () => {
      await service.createSpecialDay(BRANCH_ID, { date: '2026-12-25' });

      const [{ data }] = prisma.scoped.branchSpecialDay.create.mock
        .calls[0] as [{ data: Record<string, unknown> }];
      expect(data).toMatchObject({
        isClosed: true,
        opensAt: null,
        closesAt: null,
      });
    });

    it('una jornada especial exige las dos horas', async () => {
      await expect(
        service.createSpecialDay(BRANCH_ID, {
          date: '2026-12-24',
          isClosed: false,
          opensAt: '10:00',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * El regex del DTO deja pasar el 30 de febrero; lo agarra el parseo. Sin la
     * traducción, el RangeError saldría como 500 en vez de 400.
     */
    it('una fecha que no existe en el calendario es 400, no 500', async () => {
      await expect(
        service.createSpecialDay(BRANCH_ID, { date: '2026-02-30' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.findSpecialDays(BRANCH_ID, { from: '2026-02-30' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('traduce la fecha repetida a un 409', async () => {
      prisma.scoped.branchSpecialDay.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '7.0.0',
        }),
      );

      await expect(
        service.createSpecialDay(BRANCH_ID, { date: '2026-12-25' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('al reabrir un día cerrado exige el horario', async () => {
      await expect(
        service.updateSpecialDay(BRANCH_ID, SPECIAL_DAY_ID, {
          isClosed: false,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('al cerrar un día que tenía horario se las limpia', async () => {
      prisma.scoped.branchSpecialDay.findFirst.mockResolvedValue({
        ...SPECIAL_DAY_ROW,
        isClosed: false,
        opensAt: new Date('1970-01-01T10:00:00.000Z'),
        closesAt: new Date('1970-01-01T14:00:00.000Z'),
      });

      await service.updateSpecialDay(BRANCH_ID, SPECIAL_DAY_ID, {
        isClosed: true,
      });

      const [{ data }] = prisma.scoped.branchSpecialDay.update.mock
        .calls[0] as [{ data: Record<string, unknown> }];
      expect(data).toMatchObject({
        isClosed: true,
        opensAt: null,
        closesAt: null,
      });
    });

    it('mantiene el horario guardado si el PATCH solo toca la descripción', async () => {
      prisma.scoped.branchSpecialDay.findFirst.mockResolvedValue({
        ...SPECIAL_DAY_ROW,
        isClosed: false,
        opensAt: new Date('1970-01-01T10:00:00.000Z'),
        closesAt: new Date('1970-01-01T14:00:00.000Z'),
      });

      await service.updateSpecialDay(BRANCH_ID, SPECIAL_DAY_ID, {
        description: 'Nochebuena',
      });

      const [{ data }] = prisma.scoped.branchSpecialDay.update.mock
        .calls[0] as [{ data: Record<string, unknown> }];
      expect(data).toMatchObject({
        isClosed: false,
        description: 'Nochebuena',
      });
      expect((data.opensAt as Date).toISOString()).toBe(
        '1970-01-01T10:00:00.000Z',
      );
    });

    it('un día especial de otra sucursal no existe', async () => {
      prisma.scoped.branchSpecialDay.findFirst.mockResolvedValue(null);

      await expect(
        service.removeSpecialDay(BRANCH_ID, SPECIAL_DAY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.scoped.branchSpecialDay.delete).not.toHaveBeenCalled();
    });

    it('filtra por rango de fechas cuando se lo piden', async () => {
      await service.findSpecialDays(BRANCH_ID, {
        from: '2026-01-01',
        to: '2026-12-31',
      });

      const [{ where }] = prisma.scoped.branchSpecialDay.findMany.mock
        .calls[0] as [{ where: { date: { gte: Date; lte: Date } } }];
      expect(where.date.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(where.date.lte.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    });

    it('devuelve las fechas y horas como strings, no como Date', async () => {
      prisma.scoped.branchSpecialDay.findMany.mockResolvedValue([
        {
          ...SPECIAL_DAY_ROW,
          isClosed: false,
          opensAt: new Date('1970-01-01T10:00:00.000Z'),
          closesAt: new Date('1970-01-01T14:00:00.000Z'),
        },
      ]);

      const [day] = await service.findSpecialDays(BRANCH_ID, {});

      expect(day).toMatchObject({
        date: '2026-12-25',
        opensAt: '10:00',
        closesAt: '14:00',
      });
    });
  });

  describe('findAll', () => {
    it('sin filtro trae todas', async () => {
      await service.findAll({});

      const [{ where }] = prisma.scoped.branch.findMany.mock.calls[0] as [
        { where: object },
      ];
      expect(where).toEqual({});
    });

    it('filtra por estado si se lo piden', async () => {
      await service.findAll({ isActive: true });

      const [{ where }] = prisma.scoped.branch.findMany.mock.calls[0] as [
        { where: object },
      ];
      expect(where).toEqual({ isActive: true });
    });
  });
});
