import { randomUUID } from 'node:crypto';
import { AppointmentStatus } from '@prisma/client';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  switchPlan,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

/** Lunes. El horario de atención se carga solo para este día de la semana. */
const LUNES = '2026-09-07';
const DAY_OF_WEEK = 1;

interface AvailabilityResponse {
  date: string;
  timezone: string;
  durationMinutes: number;
  bufferAfterMinutes: number;
  branchClosed: boolean;
  noEmployeeForServices: boolean;
  slots: {
    startsAt: string;
    endsAt: string;
    employees: { employeeId: string; employeeName: string }[];
  }[];
}

/**
 * `"09:00"` de Buenos Aires como instante ISO. El seed de tests deja el tenant
 * en `America/Argentina/Buenos_Aires`, que es UTC-3 todo el año.
 */
function enBuenosAires(hhmm: string, date = LUNES): string {
  const [hours, minutes] = hhmm.split(':').map(Number);

  return `${date}T${String(hours + 3).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`;
}

/** Los slots como `"09:00"`, para poder leer de un vistazo qué devolvió. */
function horas(response: AvailabilityResponse): string[] {
  return response.slots.map((slot) => {
    const utc = new Date(slot.startsAt);

    return `${String(utc.getUTCHours() - 3).padStart(2, '0')}:${String(
      utc.getUTCMinutes(),
    ).padStart(2, '0')}`;
  });
}

function tokenFromUrl(activationUrl: string): string {
  const token = new URL(activationUrl).searchParams.get('token');

  if (!token) {
    throw new Error(`El link de activación no trae token: ${activationUrl}`);
  }

  return token;
}

describe('Disponibilidad (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;
  let branchId: string;
  let serviceId: string;
  let employeeId: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  async function createBranch(name = 'Sucursal Centro'): Promise<string> {
    const response = await request(server())
      .post('/branches')
      .set(...auth(tenant.accessToken))
      .send({ name })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  /** Abre solo los días indicados; el resto de la semana cerrado. */
  async function setBusinessHours(
    id: string,
    opensAt = '09:00',
    closesAt = '18:00',
    openDays: number[] = [DAY_OF_WEEK],
  ): Promise<void> {
    await request(server())
      .put(`/branches/${id}/business-hours`)
      .set(...auth(tenant.accessToken))
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) =>
          openDays.includes(dayOfWeek)
            ? { dayOfWeek, opensAt, closesAt }
            : { dayOfWeek, isClosed: true },
        ),
      })
      .expect(200);
  }

  async function createService(
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(server())
      .post('/services')
      .set(...auth(tenant.accessToken))
      .send({
        name: `Corte ${randomUUID().slice(0, 8)}`,
        durationMinutes: 60,
        priceCents: 100_000,
        ...body,
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  /** Un profesional activado, con sucursales y horario cargados. */
  async function createProfessional(
    branchIds: string[],
    shifts: { startsAt: string; endsAt: string }[] = [
      { startsAt: '09:00', endsAt: '13:00' },
    ],
    firstName = 'Lucía',
  ): Promise<string> {
    const email = `${randomUUID()}@e2e.test`;

    const invitation = await request(server())
      .post('/employees')
      .set(...auth(tenant.accessToken))
      .send({
        email,
        firstName,
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds,
      })
      .expect(201);

    const body = invitation.body as {
      employee: { id: string };
      activationUrl: string;
    };

    await request(server())
      .post('/employees/activate')
      .send({
        token: tokenFromUrl(body.activationUrl),
        password: 'claveNueva123',
      })
      .expect(204);

    await request(server())
      .put(`/employees/${body.employee.id}/schedules`)
      .set(...auth(tenant.accessToken))
      .send({
        shifts: shifts.map((shift) => ({
          ...shift,
          branchId: branchIds[0],
          dayOfWeek: DAY_OF_WEEK,
        })),
      })
      .expect(200);

    return body.employee.id;
  }

  async function assignService(
    service: string,
    assignments: { employeeId: string; branchId: string }[],
  ): Promise<void> {
    await request(server())
      .put(`/services/${service}/employees`)
      .set(...auth(tenant.accessToken))
      .send({ assignments })
      .expect(200);
  }

  async function createCustomer(): Promise<string> {
    const response = await request(server())
      .post('/customers')
      .set(...auth(tenant.accessToken))
      .send({
        firstName: 'Cliente',
        phone: `11 ${Math.floor(1000 + Math.random() * 8999)}-${Math.floor(
          1000 + Math.random() * 8999,
        )}`,
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  /**
   * Los turnos se cargan por Prisma y no por la API porque `POST /appointments`
   * llega en el tramo siguiente. Lo que se está probando acá es que la
   * disponibilidad los tenga en cuenta, no cómo se crean.
   */
  async function createAppointment(
    from: string,
    to: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const appointment = await prisma.appointment.create({
      data: {
        tenantId: tenant.tenantId,
        branchId,
        employeeId,
        customerId: await createCustomer(),
        startsAt: new Date(enBuenosAires(from)),
        endsAt: new Date(enBuenosAires(to)),
        totalPriceCents: 100_000,
        ...overrides,
      },
      select: { id: true },
    });

    return appointment.id;
  }

  const availability = async (
    query: Record<string, string> = {},
    expected = 200,
    services?: string[],
  ): Promise<AvailabilityResponse> => {
    const params = new URLSearchParams({
      branchId,
      date: LUNES,
      ...query,
    });

    // Repetido, no separado por comas: es como lo serializa `URLSearchParams`
    // en el front y como lo describe el OpenAPI.
    for (const id of services ?? [serviceId]) {
      params.append('serviceIds', id);
    }

    const response = await request(server())
      .get(`/appointments/availability?${params.toString()}`)
      .set(...auth(tenant.accessToken))
      .expect(expected);

    return response.body as AvailabilityResponse;
  };

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
    await switchPlan(prisma, tenant.tenantId, 'empresa');

    branchId = await createBranch();
    await setBusinessHours(branchId);
    serviceId = await createService();
    employeeId = await createProfessional([branchId]);
    await assignService(serviceId, [{ employeeId, branchId }]);
  });

  describe('El caso base', () => {
    it('corta el horario del profesional en turnos', async () => {
      const response = await availability();

      expect(horas(response)).toEqual(['09:00', '10:00', '11:00', '12:00']);
      expect(response).toMatchObject({
        date: LUNES,
        timezone: 'America/Argentina/Buenos_Aires',
        durationMinutes: 60,
        bufferAfterMinutes: 0,
        branchClosed: false,
      });
    });

    it('los slots vienen como instantes UTC', async () => {
      const response = await availability();

      expect(response.slots[0]).toMatchObject({
        startsAt: enBuenosAires('09:00'),
        endsAt: enBuenosAires('10:00'),
      });
    });

    it('cada slot dice quién lo puede tomar', async () => {
      const response = await availability();

      expect(response.slots[0].employees).toEqual([
        { employeeId, employeeName: 'Lucía Fernández' },
      ]);
    });
  });

  describe('El horario que manda es la intersección', () => {
    it('el local recorta al profesional', async () => {
      // Disponible de 8 a 20, pero el local abre de 9 a 18.
      employeeId = await createProfessional(
        [branchId],
        [{ startsAt: '08:00', endsAt: '20:00' }],
        'Ana',
      );
      await assignService(serviceId, [{ employeeId, branchId }]);

      expect(horas(await availability({ employeeId }))).toEqual([
        '09:00',
        '10:00',
        '11:00',
        '12:00',
        '13:00',
        '14:00',
        '15:00',
        '16:00',
        '17:00',
      ]);
    });

    it('un turno partido deja dos bloques con un hueco en el medio', async () => {
      employeeId = await createProfessional(
        [branchId],
        [
          { startsAt: '09:00', endsAt: '12:00' },
          { startsAt: '16:00', endsAt: '18:00' },
        ],
        'Ana',
      );
      await assignService(serviceId, [{ employeeId, branchId }]);

      expect(horas(await availability({ employeeId }))).toEqual([
        '09:00',
        '10:00',
        '11:00',
        '16:00',
        '17:00',
      ]);
    });

    it('sin horario cargado ese día no hay nada', async () => {
      await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({ shifts: [] })
        .expect(200);

      expect((await availability()).slots).toEqual([]);
    });
  });

  describe('Días que el local no abre', () => {
    it('un día de descanso viene marcado como cerrado', async () => {
      // El martes no está entre los días abiertos.
      const response = await availability({ date: '2026-09-08' });

      expect(response).toMatchObject({ branchClosed: true, slots: [] });
    });

    it('un feriado pisa el horario semanal', async () => {
      await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: LUNES, isClosed: true, description: 'Feriado' })
        .expect(201);

      expect(await availability()).toMatchObject({
        branchClosed: true,
        slots: [],
      });
    });

    it('un día con horario especial usa ese horario', async () => {
      await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({
          date: LUNES,
          isClosed: false,
          opensAt: '11:00',
          closesAt: '18:00',
          description: 'Apertura tardía',
        })
        .expect(201);

      // El profesional trabaja de 9 a 13, pero el local abre 11.
      expect(horas(await availability())).toEqual(['11:00', '12:00']);
    });
  });

  describe('Lo que ocupa el día', () => {
    it('una ausencia parcial saca esas horas', async () => {
      await request(server())
        .post(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          startsAt: enBuenosAires('10:00'),
          endsAt: enBuenosAires('12:00'),
          reason: 'Médico',
        })
        .expect(201);

      expect(horas(await availability())).toEqual(['09:00', '12:00']);
    });

    it('un turno ya tomado saca ese hueco', async () => {
      await createAppointment('10:00', '11:00');

      expect(horas(await availability())).toEqual(['09:00', '11:00', '12:00']);
    });

    /** Justo lo contrario: cancelar tiene que devolver el hueco a la agenda. */
    it('un turno cancelado NO ocupa', async () => {
      await createAppointment('10:00', '11:00', {
        status: AppointmentStatus.CANCELED_BY_CUSTOMER,
        canceledAt: new Date(),
      });

      expect(horas(await availability())).toEqual([
        '09:00',
        '10:00',
        '11:00',
        '12:00',
      ]);
    });

    /** Un `no_show` pasó igual: esa hora estuvo ocupada. */
    it('un no_show sigue ocupando', async () => {
      await createAppointment('10:00', '11:00', {
        status: AppointmentStatus.NO_SHOW,
      });

      expect(horas(await availability())).toEqual(['09:00', '11:00', '12:00']);
    });

    it('un turno en otra sucursal también ocupa', async () => {
      const otraSucursal = await createBranch('Sucursal Palermo');
      await setBusinessHours(otraSucursal);

      await createAppointment('10:00', '11:00', { branchId: otraSucursal });

      expect(horas(await availability())).toEqual(['09:00', '11:00', '12:00']);
    });
  });

  describe('El buffer forma parte del turno', () => {
    it('el último turno termina antes del cierre', async () => {
      serviceId = await createService({
        durationMinutes: 45,
        bufferAfterMinutes: 15,
      });
      await assignService(serviceId, [{ employeeId, branchId }]);

      const response = await availability();

      // Slots de 60 (45 + 15) entre las 9 y las 13.
      expect(horas(response)).toEqual(['09:00', '10:00', '11:00', '12:00']);
      expect(response.slots[0].endsAt).toBe(enBuenosAires('10:00'));
      expect(response.bufferAfterMinutes).toBe(15);
    });
  });

  describe('Varios profesionales', () => {
    let segundo: string;

    beforeEach(async () => {
      segundo = await createProfessional(
        [branchId],
        [{ startsAt: '11:00', endsAt: '15:00' }],
        'Marina',
      );
      await assignService(serviceId, [
        { employeeId, branchId },
        { employeeId: segundo, branchId },
      ]);
    });

    it('junta a los dos en el mismo slot cuando coinciden', async () => {
      const response = await availability();

      expect(horas(response)).toEqual([
        '09:00',
        '10:00',
        '11:00',
        '12:00',
        '13:00',
        '14:00',
      ]);

      const alMediodia = response.slots.find(
        (slot) => slot.startsAt === enBuenosAires('12:00'),
      );

      expect(alMediodia?.employees).toHaveLength(2);
    });

    it('filtrando por uno solo trae su horario', async () => {
      expect(horas(await availability({ employeeId: segundo }))).toEqual([
        '11:00',
        '12:00',
        '13:00',
        '14:00',
      ]);
    });

    it('un profesional desactivado desaparece', async () => {
      await request(server())
        .patch(`/employees/${segundo}`)
        .set(...auth(tenant.accessToken))
        .send({ isActive: false })
        .expect(200);

      const response = await availability();

      expect(response.slots.every((slot) => slot.employees.length === 1)).toBe(
        true,
      );
      expect(horas(response)).toEqual(['09:00', '10:00', '11:00', '12:00']);
    });

    it('quien no presta el servicio no aparece', async () => {
      await assignService(serviceId, [{ employeeId, branchId }]);

      expect(horas(await availability())).toEqual([
        '09:00',
        '10:00',
        '11:00',
        '12:00',
      ]);
    });
  });

  describe('Recursos ocupados', () => {
    it('un recurso tomado bloquea el slot aunque el profesional esté libre', async () => {
      const recurso = await request(server())
        .post('/resources')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sala de color', branchId })
        .expect(201);

      const resourceId = (recurso.body as { id: string }).id;

      await request(server())
        .put(`/services/${serviceId}/resources`)
        .set(...auth(tenant.accessToken))
        .send({ resourceIds: [resourceId] })
        .expect(200);

      // Otro turno, de otro profesional, que ya tiene la sala tomada.
      const otro = await createProfessional(
        [branchId],
        [{ startsAt: '09:00', endsAt: '13:00' }],
        'Marina',
      );
      const appointmentId = await createAppointment('10:00', '11:00', {
        employeeId: otro,
      });

      await prisma.appointmentResource.create({
        data: {
          tenantId: tenant.tenantId,
          appointmentId,
          resourceId,
          startsAt: new Date(enBuenosAires('10:00')),
          endsAt: new Date(enBuenosAires('11:00')),
        },
      });

      expect(horas(await availability({ employeeId }))).toEqual([
        '09:00',
        '11:00',
        '12:00',
      ]);
    });

    it('un recurso de otra sucursal no bloquea', async () => {
      const otraSucursal = await createBranch('Sucursal Palermo');
      const recurso = await request(server())
        .post('/resources')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sala de Palermo', branchId: otraSucursal })
        .expect(201);

      await request(server())
        .put(`/services/${serviceId}/resources`)
        .set(...auth(tenant.accessToken))
        .send({ resourceIds: [(recurso.body as { id: string }).id] })
        .expect(200);

      expect(horas(await availability())).toEqual([
        '09:00',
        '10:00',
        '11:00',
        '12:00',
      ]);
    });
  });

  describe('Varios servicios en la misma visita', () => {
    /** 30 minutos de atención más 15 de limpieza. */
    let color: string;

    const largoEnMinutos = (slot: {
      startsAt: string;
      endsAt: string;
    }): number =>
      (new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()) /
      60_000;

    beforeEach(async () => {
      color = await createService({
        name: 'Color',
        durationMinutes: 30,
        bufferAfterMinutes: 15,
      });

      await assignService(color, [{ employeeId, branchId }]);
    });

    it('el hueco mide la suma de los dos, buffers incluidos', async () => {
      const uno = await availability();
      const dos = await availability({}, 200, [serviceId, color]);

      expect(uno.durationMinutes).toBe(60);

      expect(dos.durationMinutes).toBe(90);
      expect(dos.bufferAfterMinutes).toBe(15);

      // La invariante que el front da por cierta: los dos números suman lo que
      // el hueco dura de verdad.
      expect(dos.durationMinutes + dos.bufferAfterMinutes).toBe(105);
      expect(largoEnMinutos(dos.slots[0])).toBe(105);

      // Y por lo tanto entran menos huecos en la misma jornada.
      expect(dos.slots.length).toBeLessThan(uno.slots.length);
    });

    /**
     * El test que ata las dos reglas. Si la disponibilidad y el alta no
     * calcularan la duración igual, el horario que se ofrece sería uno en el
     * que el turno después no entra: el usuario elige y se come un 409.
     *
     * **Va sobre el último hueco del día, no el primero.** Con una duración
     * calculada de menos, los primeros entran igual —sobra jornada por
     * delante— y el test pasaría con el bug puesto. El que no perdona es el
     * último: ahí es donde una duración corta ofrece un horario que se pasa
     * del cierre. Verificado mutando `totalsOf` a un solo servicio.
     */
    it('el último hueco que ofrece es exactamente el que después entra', async () => {
      const dos = await availability({}, 200, [serviceId, color]);
      const ultimo = dos.slots[dos.slots.length - 1];

      await request(server())
        .post('/appointments')
        .set(...auth(tenant.accessToken))
        .send({
          branchId,
          employeeId,
          customerId: await createCustomer(),
          serviceIds: [serviceId, color],
          startsAt: ultimo.startsAt,
        })
        .expect(201);
    });

    it('solo aparecen los que prestan todos: es intersección, no unión', async () => {
      const ana = await createProfessional([branchId], undefined, 'Ana');

      // Ana hace color, pero no el otro servicio.
      await assignService(color, [
        { employeeId, branchId },
        { employeeId: ana, branchId },
      ]);

      const soloColor = await availability({}, 200, [color]);
      expect(soloColor.slots[0].employees).toHaveLength(2);

      const losDos = await availability({}, 200, [serviceId, color]);
      expect(losDos.slots[0].employees).toHaveLength(1);
      expect(losDos.slots[0].employees[0].employeeId).toBe(employeeId);
    });

    it('nadie presta la combinación: no es "sin lugar"', async () => {
      const depilacion = await createService({ name: 'Depilación' });
      const ana = await createProfessional([branchId], undefined, 'Ana');

      await assignService(depilacion, [{ employeeId: ana, branchId }]);

      const respuesta = await availability({}, 200, [serviceId, depilacion]);

      expect(respuesta).toMatchObject({
        noEmployeeForServices: true,
        branchClosed: false,
        slots: [],
      });
    });

    it('haber quién pero no tener lugar es otra cosa', async () => {
      // El día entero ocupado por un turno ya agendado.
      await createAppointment('09:00', '13:00');

      const respuesta = await availability();

      expect(respuesta).toMatchObject({
        noEmployeeForServices: false,
        branchClosed: false,
        slots: [],
      });
    });

    /**
     * Los dos motivos se resuelven juntos y no en cascada: si el cerrado
     * cortara antes, un día de descanso escondería que además nadie presta la
     * combinación — que es el problema que no se arregla cambiando de fecha.
     */
    it('cerrado y sin quién lo preste se informan a la vez', async () => {
      const depilacion = await createService({ name: 'Depilación' });
      const ana = await createProfessional([branchId], undefined, 'Ana');

      await assignService(depilacion, [{ employeeId: ana, branchId }]);

      // El martes la sucursal no abre.
      const respuesta = await availability({ date: '2026-09-08' }, 200, [
        serviceId,
        depilacion,
      ]);

      expect(respuesta).toMatchObject({
        branchClosed: true,
        noEmployeeForServices: true,
        slots: [],
      });
    });

    it('con employeeId, cuenta si esa persona los presta todos', async () => {
      const ana = await createProfessional([branchId], undefined, 'Ana');

      await assignService(color, [
        { employeeId, branchId },
        { employeeId: ana, branchId },
      ]);

      // Ana hace color pero no el otro: pedirle a ella los dos no da nadie.
      const respuesta = await availability({ employeeId: ana }, 200, [
        serviceId,
        color,
      ]);

      expect(respuesta.noEmployeeForServices).toBe(true);
    });

    it('los servicios repetidos dan el mismo 400 que el alta', async () => {
      await availability({}, 400, [serviceId, serviceId]);
    });

    it('un servicio suelto sigue andando igual que antes', async () => {
      const respuesta = await availability({}, 200, [serviceId]);

      expect(respuesta.durationMinutes).toBe(60);
      expect(respuesta.bufferAfterMinutes).toBe(0);
      expect(respuesta.noEmployeeForServices).toBe(false);
      expect(horas(respuesta)).toEqual(['09:00', '10:00', '11:00', '12:00']);
    });
  });

  describe('Errores', () => {
    /**
     * Antes era 404 y ahora es 400: la disponibilidad valida los servicios con
     * el mismo `loadServices` que el alta, y ahí un servicio que no existe en
     * el negocio es un dato malo del pedido, no un recurso ausente. Que los dos
     * endpoints contesten distinto por lo mismo era peor.
     */
    it('400 si el servicio no existe', async () => {
      await availability({}, 400, [randomUUID()]);
    });

    it('404 si la sucursal no existe', async () => {
      await availability({ branchId: randomUUID() }, 404);
    });

    it('404 si la sucursal es de otro negocio', async () => {
      const otro = await registerTenant(app, 'Otro Negocio');

      const ajena = await request(server())
        .post('/branches')
        .set(...auth(otro.accessToken))
        .send({ name: 'Ajena' })
        .expect(201);

      await availability({ branchId: (ajena.body as { id: string }).id }, 404);
    });

    it('400 si el servicio está desactivado', async () => {
      await request(server())
        .patch(`/services/${serviceId}`)
        .set(...auth(tenant.accessToken))
        .send({ isActive: false })
        .expect(200);

      await availability({}, 400);
    });

    it.each([
      ['una fecha con formato raro', { date: '07-09-2026' }],
      ['una fecha que no existe', { date: '2026-02-31' }],
      ['un branchId que no es uuid', { branchId: 'no-soy-uuid' }],
    ])('400 con %s', async (_caso, query) => {
      await availability(query, 400);
    });

    it('401 sin token', async () => {
      await request(server())
        .get(`/appointments/availability?branchId=${branchId}`)
        .expect(401);
    });
  });
});
