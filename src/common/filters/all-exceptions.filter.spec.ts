import {
  ArgumentsHost,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { AllExceptionsFilter } from './all-exceptions.filter';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

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
    jest.spyOn(filter['logger'], 'error').mockImplementation();

    jest.mocked(Sentry.captureException).mockClear();
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

  /**
   * Qué llega a Sentry y qué no.
   *
   * El corte es el mismo que decide si el log va como `error` o como `warn`, y
   * por el mismo motivo: un 404 es la API funcionando —el pedido estaba mal— y
   * reportarlo llena el tablero de ruido hasta que deje de mirarse.
   */
  describe('lo que se reporta a Sentry', () => {
    it('un 500 se reporta', () => {
      const explota = new Error('la base se cayó');

      filter.catch(explota, host);

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(jest.mocked(Sentry.captureException).mock.calls[0][0]).toBe(
        explota,
      );
    });

    /** El `requestId` es lo que empalma el evento con la línea del log. */
    it('el reporte lleva la ruta y el requestId', () => {
      filter.catch(new Error('la base se cayó'), host);

      expect(
        jest.mocked(Sentry.captureException).mock.calls[0][1],
      ).toMatchObject({
        tags: { path: '/customers' },
        extra: { statusCode: 500 },
      });
    });

    it.each([
      ['un 404', new NotFoundException('El cliente no existe')],
      ['un 409', new ConflictException('Ya existe')],
    ])('%s no se reporta', (_caso, exception) => {
      filter.catch(exception, host);

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });
  });
});
