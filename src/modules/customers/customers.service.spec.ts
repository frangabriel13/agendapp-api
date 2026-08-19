import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { CustomersService } from './customers.service';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const TAG_ID = '33333333-3333-4333-8333-333333333333';

const customerRow = (overrides: Record<string, unknown> = {}) => ({
  id: CUSTOMER_ID,
  firstName: 'María',
  lastName: 'González',
  phone: '11 5555-1234',
  email: null,
  dateOfBirth: null,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  tagAssignments: [],
  ...overrides,
});

/** El P2002 que tira Postgres cuando dos altas con el mismo número corren juntas. */
const uniqueViolation = new Prisma.PrismaClientKnownRequestError('unique', {
  code: 'P2002',
  clientVersion: '7',
});

/**
 * El argumento de una llamada al mock, tipado. `mock.calls` es `any[][]`, así
 * que entrar a mano deja `any` sueltos que el lint (con razón) no acepta.
 */
function callArg<T>(mock: jest.Mock, call = 0): T {
  return (mock.mock.calls as unknown[][])[call][0] as T;
}

describe('CustomersService', () => {
  let service: CustomersService;
  let prisma: {
    scoped: {
      $transaction: jest.Mock;
      customer: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        count: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
      customerTag: { findMany: jest.Mock };
      customerTagAssignment: { deleteMany: jest.Mock; createMany: jest.Mock };
    };
  };

  /**
   * `findFirst` lo usan dos cosas distintas: buscar la ficha por id y buscar un
   * repetido por teléfono. Se despachan por el `where` para que cada test diga
   * solo lo que le importa.
   */
  let byId: unknown;
  let byPhone: unknown;

  beforeEach(() => {
    byId = customerRow();
    byPhone = null;

    prisma = {
      scoped: {
        $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
          callback(prisma.scoped),
        ),
        customer: {
          findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
            Promise.resolve('phoneNormalized' in args.where ? byPhone : byId),
          ),
          findMany: jest.fn().mockResolvedValue([customerRow()]),
          count: jest.fn().mockResolvedValue(1),
          create: jest.fn().mockResolvedValue(customerRow()),
          update: jest.fn().mockResolvedValue(customerRow()),
          delete: jest.fn().mockResolvedValue(customerRow()),
        },
        customerTag: {
          findMany: jest.fn().mockResolvedValue([{ id: TAG_ID }]),
        },
        customerTagAssignment: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
    };

    service = new CustomersService(prisma as unknown as PrismaService);
  });

  const baseCreate = { firstName: 'María', phone: '+54 9 11 5555-1234' };

  describe('un teléfono, un cliente', () => {
    it('guarda el teléfono crudo y su versión normalizada', async () => {
      await service.create(baseCreate);

      const { data } = callArg<{ data: Record<string, unknown> }>(
        prisma.scoped.customer.create,
      );

      expect(data).toMatchObject({
        phone: '+54 9 11 5555-1234',
        phoneNormalized: '1155551234',
      });
    });

    it('rechaza con 409 si el número ya está cargado', async () => {
      byPhone = customerRow({ id: OTHER_ID });

      await expect(service.create(baseCreate)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(prisma.scoped.customer.create).not.toHaveBeenCalled();
    });

    /** Lo que hace útil al 409: el front puede ofrecer la ficha sin otra request. */
    it('el 409 trae la ficha existente en el cuerpo', async () => {
      byPhone = customerRow({ id: OTHER_ID, firstName: 'Ana' });

      await expect(service.create(baseCreate)).rejects.toMatchObject({
        // `toMatchObject` ya compara parcial y en profundidad.
        response: {
          message: 'Ya tenés un cliente con ese teléfono',
          existingCustomer: { id: OTHER_ID, firstName: 'Ana' },
        },
      });
    });

    /**
     * El chequeo previo no cubre dos altas simultáneas: una pasa el findFirst y
     * choca contra el unique. Tiene que salir el mismo 409, no un 500.
     */
    it('traduce el choque contra el unique al mismo 409', async () => {
      prisma.scoped.customer.create.mockRejectedValue(uniqueViolation);
      prisma.scoped.customer.findFirst.mockImplementation(
        (args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            'phoneNormalized' in args.where
              ? // Libre cuando se chequeó, ocupado cuando se releyó: la carrera.
                prisma.scoped.customer.create.mock.calls.length > 0
                ? customerRow({ id: OTHER_ID })
                : null
              : byId,
          ),
      );

      await expect(service.create(baseCreate)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('reconoce el mismo número escrito distinto', async () => {
      byPhone = customerRow({ id: OTHER_ID });

      await expect(
        service.create({ ...baseCreate, phone: '011 5555-1234' }),
      ).rejects.toBeInstanceOf(ConflictException);

      const { where } = callArg<{ where: Record<string, unknown> }>(
        prisma.scoped.customer.findFirst,
      );

      expect(where).toMatchObject({ phoneNormalized: '1155551234' });
    });

    it('rechaza un teléfono sin ningún número', async () => {
      await expect(
        service.create({ ...baseCreate, phone: '+()-. ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('editar', () => {
    it('reguardar el mismo teléfono en la misma ficha no es duplicado', async () => {
      await service.update(CUSTOMER_ID, { phone: '11 5555-1234' });

      // La segunda llamada es la del duplicado; la primera trae la ficha.
      const { where } = callArg<{ where: Record<string, unknown> }>(
        prisma.scoped.customer.findFirst,
        1,
      );

      expect(where).toMatchObject({ id: { not: CUSTOMER_ID } });
      expect(prisma.scoped.customer.update).toHaveBeenCalled();
    });

    it('rechaza mudar el teléfono a uno que ya es de otro', async () => {
      byPhone = customerRow({ id: OTHER_ID });

      await expect(
        service.update(CUSTOMER_ID, { phone: '11 9999-8888' }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.scoped.customer.update).not.toHaveBeenCalled();
    });

    /** Las dos columnas son un solo dato: desincronizarlas rompe el unique. */
    it('cambiar el teléfono actualiza también el normalizado', async () => {
      await service.update(CUSTOMER_ID, { phone: '+54 11 9999-8888' });

      expect(prisma.scoped.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { phone: '+54 11 9999-8888', phoneNormalized: '1199998888' },
        }),
      );
    });

    it('un PATCH sin campos no toca la base', async () => {
      await expect(service.update(CUSTOMER_ID, {})).resolves.toMatchObject({
        id: CUSTOMER_ID,
      });

      expect(prisma.scoped.customer.update).not.toHaveBeenCalled();
    });

    it('404 si el cliente no existe o es de otro negocio', async () => {
      byId = null;

      await expect(service.findOne(CUSTOMER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('fecha de nacimiento', () => {
    it('rechaza una fecha futura', async () => {
      await expect(
        service.create({ ...baseCreate, dateOfBirth: '2999-01-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un día que no existe en el calendario', async () => {
      await expect(
        service.create({ ...baseCreate, dateOfBirth: '1990-02-31' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('la devuelve como YYYY-MM-DD, no como instante', async () => {
      byId = customerRow({
        dateOfBirth: new Date('1990-04-25T00:00:00.000Z'),
      });

      await expect(service.findOne(CUSTOMER_ID)).resolves.toMatchObject({
        dateOfBirth: '1990-04-25',
      });
    });
  });

  describe('búsqueda', () => {
    it('devuelve el total y las páginas junto con los datos', async () => {
      prisma.scoped.customer.count.mockResolvedValue(45);

      await expect(
        service.findAll({ page: 2, pageSize: 20 }),
      ).resolves.toMatchObject({
        meta: { page: 2, pageSize: 20, total: 45, totalPages: 3 },
      });

      expect(prisma.scoped.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });

    it('sin paginar arranca en la página 1 con 20 por página', async () => {
      await service.findAll({});

      expect(prisma.scoped.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('un teléfono tipeado con separadores busca por el normalizado', async () => {
      await service.findAll({ search: '+54 9 11 5555-1234' });

      const { where } = callArg<{ where: { OR: Record<string, unknown>[] } }>(
        prisma.scoped.customer.findMany,
      );

      expect(where.OR).toContainEqual({
        phoneNormalized: { contains: '1155551234' },
      });
    });

    /** Sin esto "maría gonzález" no encuentra a nadie: ningún campo tiene las dos. */
    it('cruza nombre y apellido cuando la búsqueda tiene varias palabras', async () => {
      await service.findAll({ search: 'maría gonzález' });

      const { where } = callArg<{ where: { OR: { AND?: unknown[] }[] } }>(
        prisma.scoped.customer.findMany,
      );

      expect(where.OR.some((clause) => clause.AND?.length === 2)).toBe(true);
    });

    it('un solo dígito no cuenta como búsqueda de teléfono', async () => {
      await service.findAll({ search: 'a1' });

      const { where } = callArg<{ where: { OR: Record<string, unknown>[] } }>(
        prisma.scoped.customer.findMany,
      );

      expect(where.OR.some((clause) => 'phoneNormalized' in clause)).toBe(
        false,
      );
    });

    it('filtra por etiqueta', async () => {
      await service.findAll({ tagId: TAG_ID });

      expect(prisma.scoped.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tagAssignments: { some: { tagId: TAG_ID } } },
        }),
      );
    });
  });

  describe('etiquetas del cliente', () => {
    it('guarda el set completo reemplazando el anterior', async () => {
      await service.setTags(CUSTOMER_ID, { tagIds: [TAG_ID] });

      expect(
        prisma.scoped.customerTagAssignment.deleteMany,
      ).toHaveBeenCalledWith({ where: { customerId: CUSTOMER_ID } });
      expect(prisma.scoped.customerTagAssignment.createMany).toHaveBeenCalled();
    });

    it('rechaza etiquetas repetidas antes de tocar la base', async () => {
      await expect(
        service.setTags(CUSTOMER_ID, { tagIds: [TAG_ID, TAG_ID] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.scoped.customerTag.findMany).not.toHaveBeenCalled();
    });

    it('rechaza una etiqueta que no existe en el negocio', async () => {
      prisma.scoped.customerTag.findMany.mockResolvedValue([]);

      await expect(
        service.setTags(CUSTOMER_ID, { tagIds: [TAG_ID] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(
        prisma.scoped.customerTagAssignment.deleteMany,
      ).not.toHaveBeenCalled();
    });

    it('un array vacío las saca todas sin insertar nada', async () => {
      await service.setTags(CUSTOMER_ID, { tagIds: [] });

      expect(prisma.scoped.customerTagAssignment.deleteMany).toHaveBeenCalled();
      expect(
        prisma.scoped.customerTagAssignment.createMany,
      ).not.toHaveBeenCalled();
      expect(prisma.scoped.customerTag.findMany).not.toHaveBeenCalled();
    });

    it('aplana la etiqueta en la respuesta del cliente', async () => {
      byId = customerRow({
        tagAssignments: [
          { tag: { id: TAG_ID, name: 'VIP', color: '#7C3AED' } },
        ],
      });

      await expect(service.findTags(CUSTOMER_ID)).resolves.toEqual([
        { id: TAG_ID, name: 'VIP', color: '#7C3AED' },
      ]);
    });
  });
});
