import {
  ArgumentsHost,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Lo que se prueba acá es el puente entre un service y el front: si un error
 * lleva datos, tienen que llegar. El 409 de `POST /customers` depende de eso.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let json: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    json = jest.fn();

    const response = { status: jest.fn(() => ({ json })) };
    const request = { url: '/customers', headers: {} };

    host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost;

    // El filtro loguea cada error; en los tests solo hace ruido.
    jest.spyOn(filter['logger'], 'warn').mockImplementation();
  });

  const bodyOf = (exception: unknown): Record<string, unknown> => {
    filter.catch(exception, host);

    const [[body]] = json.mock.calls as [Record<string, unknown>][];

    return body;
  };

  it('deja pasar los datos que el service adjuntó al error', () => {
    const body = bodyOf(
      new ConflictException({
        message: 'Ya tenés un cliente con ese teléfono',
        existingCustomer: { id: 'abc', firstName: 'Ana' },
      }),
    );

    expect(body).toMatchObject({
      statusCode: 409,
      message: 'Ya tenés un cliente con ese teléfono',
      existingCustomer: { id: 'abc', firstName: 'Ana' },
    });
  });

  /** Un service no puede mentir sobre el status de su propio error. */
  it('ignora un statusCode puesto en el cuerpo', () => {
    const body = bodyOf(
      new ConflictException({ message: 'algo', statusCode: 200 }),
    );

    expect(body.statusCode).toBe(409);
  });

  it('sigue funcionando con un mensaje suelto', () => {
    const body = bodyOf(new NotFoundException('El cliente no existe'));

    expect(body).toMatchObject({
      statusCode: 404,
      message: 'El cliente no existe',
      error: 'NOT_FOUND',
    });
  });
});
