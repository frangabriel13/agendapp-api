import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { ServiceCategoriesService } from './service-categories.service';

const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';

const CATEGORY_ROW = {
  id: CATEGORY_ID,
  name: 'Color',
  displayOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '7.0.0',
  });
}

describe('ServiceCategoriesService', () => {
  let service: ServiceCategoriesService;
  let prisma: {
    scoped: {
      $transaction: jest.Mock;
      serviceCategory: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
      service: { updateMany: jest.Mock };
    };
  };

  beforeEach(() => {
    prisma = {
      scoped: {
        $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
          callback(prisma.scoped),
        ),
        serviceCategory: {
          findFirst: jest.fn().mockResolvedValue(CATEGORY_ROW),
          findMany: jest.fn().mockResolvedValue([CATEGORY_ROW]),
          create: jest.fn().mockResolvedValue(CATEGORY_ROW),
          update: jest.fn().mockResolvedValue(CATEGORY_ROW),
          delete: jest.fn().mockResolvedValue(CATEGORY_ROW),
        },
        service: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      },
    };

    service = new ServiceCategoriesService(prisma as unknown as PrismaService);
  });

  it('ordena por displayOrder y después alfabéticamente', async () => {
    await service.findAll();

    expect(prisma.scoped.serviceCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  });

  it('traduce el UNIQUE de nombre a un 409 con mensaje propio', async () => {
    prisma.scoped.serviceCategory.create.mockRejectedValue(uniqueViolation());

    await expect(service.create({ name: 'Color' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('404 si la categoría no existe o es de otro negocio', async () => {
    prisma.scoped.serviceCategory.findFirst.mockResolvedValue(null);

    await expect(service.findOne(CATEGORY_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('un PATCH sin campos no toca la base', async () => {
    await expect(service.update(CATEGORY_ID, {})).resolves.toMatchObject({
      id: CATEGORY_ID,
    });

    expect(prisma.scoped.serviceCategory.update).not.toHaveBeenCalled();
  });

  /**
   * El `ON DELETE SET NULL` de la FK no se dispara con baja lógica. Si esto se
   * rompe, los servicios quedan apuntando a una categoría invisible.
   */
  it('al dar de baja, desengancha los servicios en la misma transacción', async () => {
    await service.remove(CATEGORY_ID);

    expect(prisma.scoped.$transaction).toHaveBeenCalled();
    expect(prisma.scoped.service.updateMany).toHaveBeenCalledWith({
      where: { categoryId: CATEGORY_ID },
      data: { categoryId: null },
    });
    expect(prisma.scoped.serviceCategory.delete).toHaveBeenCalledWith({
      where: { id: CATEGORY_ID },
    });
  });

  it('no borra nada si la categoría no existe', async () => {
    prisma.scoped.serviceCategory.findFirst.mockResolvedValue(null);

    await expect(service.remove(CATEGORY_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.scoped.service.updateMany).not.toHaveBeenCalled();
  });
});
