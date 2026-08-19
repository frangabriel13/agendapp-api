import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { CustomerTagsService } from './customer-tags.service';

const TAG_ID = '11111111-1111-4111-8111-111111111111';

const TAG_ROW = {
  id: TAG_ID,
  name: 'VIP',
  color: '#7C3AED',
  createdAt: new Date(),
  updatedAt: new Date(),
  _count: { assignments: 42 },
};

describe('CustomerTagsService', () => {
  let service: CustomerTagsService;
  let prisma: {
    scoped: {
      $transaction: jest.Mock;
      customerTag: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
      customerTagAssignment: { deleteMany: jest.Mock };
    };
  };

  beforeEach(() => {
    prisma = {
      scoped: {
        $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
          callback(prisma.scoped),
        ),
        customerTag: {
          findFirst: jest.fn().mockResolvedValue(TAG_ROW),
          findMany: jest.fn().mockResolvedValue([TAG_ROW]),
          create: jest.fn().mockResolvedValue(TAG_ROW),
          update: jest.fn().mockResolvedValue(TAG_ROW),
          delete: jest.fn().mockResolvedValue(TAG_ROW),
        },
        customerTagAssignment: {
          deleteMany: jest.fn().mockResolvedValue({ count: 42 }),
        },
      },
    };

    service = new CustomerTagsService(prisma as unknown as PrismaService);
  });

  it('aplana el conteo de clientes en la respuesta', async () => {
    await expect(service.findOne(TAG_ID)).resolves.toEqual({
      id: TAG_ID,
      name: 'VIP',
      color: '#7C3AED',
      customerCount: 42,
      createdAt: TAG_ROW.createdAt,
      updatedAt: TAG_ROW.updatedAt,
    });
  });

  /** El conteo se filtra a mano: la extension no entra en las relaciones. */
  it('cuenta solo los clientes vivos', async () => {
    await service.findAll();

    const [args] = prisma.scoped.customerTag.findMany.mock.calls as [
      { select: Record<string, unknown> },
    ][];

    expect(args[0].select).toMatchObject({
      _count: {
        select: { assignments: { where: { customer: { deletedAt: null } } } },
      },
    });
  });

  it('traduce el nombre repetido a un 409', async () => {
    prisma.scoped.customerTag.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '7',
      }),
    );

    await expect(service.create({ name: 'VIP' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('un PATCH sin campos no toca la base', async () => {
    await expect(service.update(TAG_ID, {})).resolves.toMatchObject({
      id: TAG_ID,
    });

    expect(prisma.scoped.customerTag.update).not.toHaveBeenCalled();
  });

  it('404 si la etiqueta no existe o es de otro negocio', async () => {
    prisma.scoped.customerTag.findFirst.mockResolvedValue(null);

    await expect(service.findOne(TAG_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * La etiqueta se archiva pero las asignaciones se borran de verdad: si no,
   * quedarían para siempre colgadas de algo que ya nadie puede alcanzar.
   */
  it('al darla de baja la saca de todos los clientes', async () => {
    await service.remove(TAG_ID);

    expect(prisma.scoped.customerTagAssignment.deleteMany).toHaveBeenCalledWith(
      { where: { tagId: TAG_ID } },
    );
    expect(prisma.scoped.customerTag.delete).toHaveBeenCalledWith({
      where: { id: TAG_ID },
    });
  });
});
