import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  switchPlan,
  TEST_PASSWORD,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

interface InvitationResponse {
  employee: { id: string; status: string; role: string };
  activationUrl: string;
  expiresAt: string;
}

/** Saca el token del link, que es lo que el empleado va a mandar de vuelta. */
function tokenFromUrl(activationUrl: string): string {
  const token = new URL(activationUrl).searchParams.get('token');

  if (!token) {
    throw new Error(`El link de activación no trae token: ${activationUrl}`);
  }

  return token;
}

describe('Employees (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
    // El plan básico solo admite al dueño: sin esto no se puede invitar a nadie.
    await switchPlan(prisma, tenant.tenantId, 'empresa');
  });

  const server = () => app.getHttpServer();

  async function invite(
    body: Record<string, unknown> = {},
    token = tenant.accessToken,
  ): Promise<InvitationResponse> {
    const response = await request(server())
      .post('/employees')
      .set(...auth(token))
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName: 'Ana',
        lastName: 'Gómez',
        role: 'PROFESSIONAL',
        ...body,
      })
      .expect(201);

    return response.body as InvitationResponse;
  }

  async function createBranch(
    name = 'Sucursal Centro',
    token = tenant.accessToken,
  ): Promise<string> {
    const response = await request(server())
      .post('/branches')
      .set(...auth(token))
      .send({ name })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  describe('Invitación', () => {
    it('crea al empleado en estado PENDING y devuelve el link', async () => {
      const invitation = await invite({ email: 'ana@e2e.test' });

      expect(invitation.employee).toMatchObject({
        status: 'PENDING',
        role: 'PROFESSIONAL',
        isOwner: false,
        isActive: true,
      });
      expect(invitation.activationUrl).toContain('/activar?token=');
      expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    it('nunca devuelve el hash de la contraseña', async () => {
      const invitation = await invite();

      expect(JSON.stringify(invitation)).not.toContain('passwordHash');
    });

    it('el invitado todavía no puede entrar', async () => {
      await invite({ email: 'ana@e2e.test' });

      await request(server())
        .post('/auth/login')
        .send({ email: 'ana@e2e.test', password: TEST_PASSWORD })
        .expect(401);
    });

    it('normaliza el email a minúsculas', async () => {
      const invitation = await invite({ email: 'Ana.Gomez@E2E.test' });

      const detail = await request(server())
        .get(`/employees/${invitation.employee.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((detail.body as { user: { email: string } }).user.email).toBe(
        'ana.gomez@e2e.test',
      );
    });

    it('rechaza un email que ya tiene cuenta', async () => {
      await invite({ email: 'ana@e2e.test' });

      await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: 'ana@e2e.test',
          firstName: 'Otra',
          lastName: 'Persona',
          role: 'PROFESSIONAL',
        })
        .expect(409);
    });

    it('tampoco deja usar el email del dueño de otro negocio', async () => {
      const otro = await registerTenant(app, 'Estética Norte');

      await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: otro.email,
          firstName: 'Ana',
          lastName: 'Gómez',
          role: 'PROFESSIONAL',
        })
        .expect(409);
    });

    it('no deja invitar a alguien como OWNER', async () => {
      await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: 'ana@e2e.test',
          firstName: 'Ana',
          lastName: 'Gómez',
          role: 'OWNER',
        })
        .expect(400);
    });

    it('rechaza una sucursal que no es del negocio', async () => {
      const otro = await registerTenant(app, 'Estética Norte');
      const ajena = await createBranch('Sucursal Norte', otro.accessToken);

      await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: 'ana@e2e.test',
          firstName: 'Ana',
          lastName: 'Gómez',
          role: 'PROFESSIONAL',
          branchIds: [ajena],
        })
        .expect(400);

      // Y no dejó al usuario colgado a medio crear.
      const usuarios = await prisma.user.findMany({
        where: { email: 'ana@e2e.test' },
      });
      expect(usuarios).toHaveLength(0);
    });

    it('puede asignar sucursales en el alta', async () => {
      const branchId = await createBranch();
      const invitation = await invite({ branchIds: [branchId] });

      const detail = await request(server())
        .get(`/employees/${invitation.employee.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((detail.body as { branchIds: string[] }).branchIds).toEqual([
        branchId,
      ]);
    });
  });

  describe('Activación', () => {
    it('activa la cuenta y a partir de ahí puede loguearse', async () => {
      const invitation = await invite({ email: 'ana@e2e.test' });

      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'claveNueva123',
        })
        .expect(204);

      const login = await request(server())
        .post('/auth/login')
        .send({ email: 'ana@e2e.test', password: 'claveNueva123' })
        .expect(200);

      const { accessToken } = login.body as { accessToken: string };

      const me = await request(server())
        .get('/auth/me')
        .set(...auth(accessToken))
        .expect(200);

      expect(me.body).toMatchObject({
        user: { email: 'ana@e2e.test' },
        tenant: { id: tenant.tenantId },
        employee: { role: 'PROFESSIONAL', isOwner: false },
      });
    });

    it('el empleado pasa a ACTIVE en el listado', async () => {
      const invitation = await invite();

      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'claveNueva123',
        })
        .expect(204);

      const detail = await request(server())
        .get(`/employees/${invitation.employee.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((detail.body as { status: string }).status).toBe('ACTIVE');
    });

    it('el mismo link no se puede usar dos veces', async () => {
      const invitation = await invite();
      const token = tokenFromUrl(invitation.activationUrl);

      await request(server())
        .post('/employees/activate')
        .send({ token, password: 'claveNueva123' })
        .expect(204);

      await request(server())
        .post('/employees/activate')
        .send({ token, password: 'otraClave456' })
        .expect(400);
    });

    it.each([
      ['basura', 'no-es-un-token'],
      ['con id inventado', `${randomUUID()}.secreto-cualquiera`],
    ])('rechaza un token %s', async (_caso, token) => {
      await request(server())
        .post('/employees/activate')
        .send({ token, password: 'claveNueva123' })
        .expect(400);
    });

    it('rechaza el token correcto con el secreto cambiado', async () => {
      const invitation = await invite();
      const [id] = tokenFromUrl(invitation.activationUrl).split('.');

      await request(server())
        .post('/employees/activate')
        .send({ token: `${id}.secreto-falso`, password: 'claveNueva123' })
        .expect(400);
    });

    it('rechaza un link vencido', async () => {
      const invitation = await invite();

      await prisma.employeeInvitation.updateMany({
        where: { employeeId: invitation.employee.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'claveNueva123',
        })
        .expect(400);
    });

    it('rechaza el link de un empleado dado de baja', async () => {
      const invitation = await invite();

      await request(server())
        .delete(`/employees/${invitation.employee.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'claveNueva123',
        })
        .expect(400);
    });

    it('exige una contraseña que cumpla las reglas', async () => {
      const invitation = await invite();

      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'corta',
        })
        .expect(400);
    });

    it('es público: no pide token de sesión', async () => {
      const invitation = await invite();

      // Sin header Authorization y funciona igual.
      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'claveNueva123',
        })
        .expect(204);
    });
  });

  describe('Reenviar la invitación', () => {
    it('emite un link nuevo y mata el anterior', async () => {
      const primera = await invite();
      const viejo = tokenFromUrl(primera.activationUrl);

      const segunda = await request(server())
        .post(`/employees/${primera.employee.id}/invitation`)
        .set(...auth(tenant.accessToken))
        .expect(201);

      const nuevo = tokenFromUrl(
        (segunda.body as InvitationResponse).activationUrl,
      );
      expect(nuevo).not.toBe(viejo);

      await request(server())
        .post('/employees/activate')
        .send({ token: viejo, password: 'claveNueva123' })
        .expect(400);

      await request(server())
        .post('/employees/activate')
        .send({ token: nuevo, password: 'claveNueva123' })
        .expect(204);
    });

    it('no tiene sentido si ya activó la cuenta', async () => {
      const invitation = await invite();

      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'claveNueva123',
        })
        .expect(204);

      await request(server())
        .post(`/employees/${invitation.employee.id}/invitation`)
        .set(...auth(tenant.accessToken))
        .expect(409);
    });
  });

  describe('Límite del plan', () => {
    it('el plan básico solo admite al dueño', async () => {
      await switchPlan(prisma, tenant.tenantId, 'basico');

      const response = await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: 'ana@e2e.test',
          firstName: 'Ana',
          lastName: 'Gómez',
          role: 'PROFESSIONAL',
        })
        .expect(403);

      expect(JSON.stringify(response.body)).toContain('Básico');
    });

    it('el invitado que todavía no aceptó ya ocupa lugar', async () => {
      // Pro admite 4 con el dueño incluido: quedan 3 lugares.
      await switchPlan(prisma, tenant.tenantId, 'pro');

      await invite();
      await invite();
      await invite();

      await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: 'uno.mas@e2e.test',
          firstName: 'Uno',
          lastName: 'Más',
          role: 'PROFESSIONAL',
        })
        .expect(403);
    });

    /** Mismo caso que en sucursales: el lock es lo único que lo evita. */
    it('varias invitaciones simultáneas no se saltean el límite', async () => {
      // Pro admite 4 con el dueño incluido: quedan 3 lugares para 6 intentos.
      await switchPlan(prisma, tenant.tenantId, 'pro');

      const intentos = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request(server())
            .post('/employees')
            .set(...auth(tenant.accessToken))
            .send({
              email: `simultanea-${i}@e2e.test`,
              firstName: 'Ana',
              lastName: 'Gómez',
              role: 'PROFESSIONAL',
            }),
        ),
      );

      expect(intentos.filter((r) => r.status === 201)).toHaveLength(3);
      expect(intentos.filter((r) => r.status === 403)).toHaveLength(3);

      const listado = await request(server())
        .get('/employees')
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(listado.body).toHaveLength(4); // el dueño + los 3 invitados
    });

    it('dar de baja a alguien libera el lugar', async () => {
      await switchPlan(prisma, tenant.tenantId, 'pro');

      const primero = await invite();
      await invite();
      await invite();

      await request(server())
        .delete(`/employees/${primero.employee.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      await invite();
    });
  });

  describe('Protecciones del dueño y de uno mismo', () => {
    it('al dueño no se lo puede desactivar, borrar ni cambiar de rol', async () => {
      await request(server())
        .patch(`/employees/${tenant.employeeId}`)
        .set(...auth(tenant.accessToken))
        .send({ isActive: false })
        .expect(403);

      await request(server())
        .patch(`/employees/${tenant.employeeId}`)
        .set(...auth(tenant.accessToken))
        .send({ role: 'PROFESSIONAL' })
        .expect(403);

      await request(server())
        .delete(`/employees/${tenant.employeeId}`)
        .set(...auth(tenant.accessToken))
        .expect(403);
    });

    it('un administrativo no puede darse de baja a sí mismo', async () => {
      const invitation = await invite({
        email: 'admin@e2e.test',
        role: 'ADMINISTRATIVE',
      });

      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'claveNueva123',
        })
        .expect(204);

      const login = await request(server())
        .post('/auth/login')
        .send({ email: 'admin@e2e.test', password: 'claveNueva123' })
        .expect(200);

      const { accessToken } = login.body as { accessToken: string };

      await request(server())
        .delete(`/employees/${invitation.employee.id}`)
        .set(...auth(accessToken))
        .expect(400);

      await request(server())
        .patch(`/employees/${invitation.employee.id}`)
        .set(...auth(accessToken))
        .send({ isActive: false })
        .expect(400);
    });
  });

  describe('Edición y baja', () => {
    it('desactivar corta el acceso en el acto', async () => {
      const invitation = await invite({ email: 'ana@e2e.test' });

      await request(server())
        .post('/employees/activate')
        .send({
          token: tokenFromUrl(invitation.activationUrl),
          password: 'claveNueva123',
        })
        .expect(204);

      const login = await request(server())
        .post('/auth/login')
        .send({ email: 'ana@e2e.test', password: 'claveNueva123' })
        .expect(200);

      const { accessToken } = login.body as { accessToken: string };

      await request(server())
        .get('/employees')
        .set(...auth(accessToken))
        .expect(200);

      await request(server())
        .patch(`/employees/${invitation.employee.id}`)
        .set(...auth(tenant.accessToken))
        .send({ isActive: false })
        .expect(200);

      // El token sigue siendo válido, pero el guard relee al empleado.
      await request(server())
        .get('/employees')
        .set(...auth(accessToken))
        .expect(401);
    });

    it('edita los datos laborales', async () => {
      const invitation = await invite();

      const response = await request(server())
        .patch(`/employees/${invitation.employee.id}`)
        .set(...auth(tenant.accessToken))
        .send({
          role: 'ADMINISTRATIVE',
          hiredAt: '2026-03-01',
          bio: 'Colorista',
        })
        .expect(200);

      expect(response.body).toMatchObject({
        role: 'ADMINISTRATIVE',
        hiredAt: '2026-03-01',
        bio: 'Colorista',
      });
    });

    it('rechaza una fecha de ingreso que no existe', async () => {
      const invitation = await invite();

      await request(server())
        .patch(`/employees/${invitation.employee.id}`)
        .set(...auth(tenant.accessToken))
        .send({ hiredAt: '2026-02-30' })
        .expect(400);
    });

    it('el empleado dado de baja desaparece del listado', async () => {
      const invitation = await invite();

      await request(server())
        .delete(`/employees/${invitation.employee.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      const listado = await request(server())
        .get('/employees')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(listado.body).toHaveLength(1); // solo el dueño
    });
  });

  describe('Sucursales del empleado', () => {
    let employeeId: string;
    let centro: string;
    let palermo: string;

    beforeEach(async () => {
      employeeId = (await invite()).employee.id;
      centro = await createBranch('Sucursal Centro');
      palermo = await createBranch('Sucursal Palermo');
    });

    it('reemplaza el set completo', async () => {
      const asignadas = await request(server())
        .put(`/employees/${employeeId}/branches`)
        .set(...auth(tenant.accessToken))
        .send({ branchIds: [centro, palermo] })
        .expect(200);

      expect(asignadas.body).toHaveLength(2);

      const reducidas = await request(server())
        .put(`/employees/${employeeId}/branches`)
        .set(...auth(tenant.accessToken))
        .send({ branchIds: [palermo] })
        .expect(200);

      expect(reducidas.body).toEqual([palermo]);
    });

    it('sacarle una sucursal borra el horario que tenía ahí', async () => {
      await request(server())
        .put(`/employees/${employeeId}/branches`)
        .set(...auth(tenant.accessToken))
        .send({ branchIds: [centro, palermo] })
        .expect(200);

      await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: centro,
              dayOfWeek: 1,
              startsAt: '09:00',
              endsAt: '13:00',
            },
            {
              branchId: palermo,
              dayOfWeek: 2,
              startsAt: '09:00',
              endsAt: '13:00',
            },
          ],
        })
        .expect(200);

      await request(server())
        .put(`/employees/${employeeId}/branches`)
        .set(...auth(tenant.accessToken))
        .send({ branchIds: [palermo] })
        .expect(200);

      const horarios = await request(server())
        .get(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(horarios.body).toHaveLength(1);
      expect((horarios.body as { branchId: string }[])[0].branchId).toBe(
        palermo,
      );
    });

    it('rechaza una sucursal de otro negocio', async () => {
      const otro = await registerTenant(app, 'Estética Norte');
      const ajena = await createBranch('Sucursal Norte', otro.accessToken);

      await request(server())
        .put(`/employees/${employeeId}/branches`)
        .set(...auth(tenant.accessToken))
        .send({ branchIds: [ajena] })
        .expect(400);
    });
  });

  describe('Horario del empleado', () => {
    let employeeId: string;
    let centro: string;
    let palermo: string;

    beforeEach(async () => {
      employeeId = (await invite()).employee.id;
      centro = await createBranch('Sucursal Centro');
      palermo = await createBranch('Sucursal Palermo');

      await request(server())
        .put(`/employees/${employeeId}/branches`)
        .set(...auth(tenant.accessToken))
        .send({ branchIds: [centro, palermo] })
        .expect(200);
    });

    it('acepta un turno partido el mismo día', async () => {
      const response = await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: centro,
              dayOfWeek: 1,
              startsAt: '09:00',
              endsAt: '13:00',
            },
            {
              branchId: centro,
              dayOfWeek: 1,
              startsAt: '16:00',
              endsAt: '20:00',
            },
          ],
        })
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body).toEqual([
        expect.objectContaining({ startsAt: '09:00', endsAt: '13:00' }),
        expect.objectContaining({ startsAt: '16:00', endsAt: '20:00' }),
      ]);
    });

    it('acepta horarios distintos en cada sucursal', async () => {
      const response = await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: centro,
              dayOfWeek: 1,
              startsAt: '09:00',
              endsAt: '13:00',
            },
            {
              branchId: palermo,
              dayOfWeek: 1,
              startsAt: '15:00',
              endsAt: '19:00',
            },
          ],
        })
        .expect(200);

      expect(response.body).toHaveLength(2);
    });

    it('no deja estar en dos sucursales a la vez', async () => {
      const response = await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: centro,
              dayOfWeek: 1,
              startsAt: '09:00',
              endsAt: '13:00',
            },
            {
              branchId: palermo,
              dayOfWeek: 1,
              startsAt: '12:00',
              endsAt: '16:00',
            },
          ],
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('dos lugares a la vez');
    });

    it('rechaza un tramo que termina antes de empezar', async () => {
      await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: centro,
              dayOfWeek: 1,
              startsAt: '18:00',
              endsAt: '09:00',
            },
          ],
        })
        .expect(400);
    });

    it('rechaza un tramo en una sucursal donde no trabaja', async () => {
      const otra = await createBranch('Sucursal Caballito');

      await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: otra,
              dayOfWeek: 1,
              startsAt: '09:00',
              endsAt: '13:00',
            },
          ],
        })
        .expect(400);
    });

    it('un array vacío lo deja sin horario', async () => {
      await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: centro,
              dayOfWeek: 1,
              startsAt: '09:00',
              endsAt: '13:00',
            },
          ],
        })
        .expect(200);

      const vacío = await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({ shifts: [] })
        .expect(200);

      expect(vacío.body).toEqual([]);
    });

    it('si un tramo viene mal, no pisa el horario anterior', async () => {
      await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: centro,
              dayOfWeek: 1,
              startsAt: '09:00',
              endsAt: '13:00',
            },
          ],
        })
        .expect(200);

      await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: [
            {
              branchId: centro,
              dayOfWeek: 2,
              startsAt: '09:00',
              endsAt: '13:00',
            },
            {
              branchId: centro,
              dayOfWeek: 2,
              startsAt: '10:00',
              endsAt: '14:00',
            },
          ],
        })
        .expect(400);

      const actual = await request(server())
        .get(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(actual.body).toHaveLength(1);
      expect((actual.body as { dayOfWeek: number }[])[0].dayOfWeek).toBe(1);
    });
  });

  describe('Ausencias', () => {
    let employeeId: string;

    beforeEach(async () => {
      employeeId = (await invite()).employee.id;
    });

    it('carga vacaciones sin sucursal (todas)', async () => {
      const response = await request(server())
        .post(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          startsAt: '2026-01-05T09:00:00-03:00',
          endsAt: '2026-01-20T09:00:00-03:00',
          reason: 'Vacaciones',
        })
        .expect(201);

      expect(response.body).toMatchObject({
        branchId: null,
        reason: 'Vacaciones',
      });
    });

    /**
     * `reason` es texto libre y el panel venía adivinando la categoría por
     * palabras clave: "me voy a Brasil" no dice "vacaciones" en ningún lado.
     * Por eso el tipo viaja aparte y no se deduce del texto.
     */
    it('guarda el tipo de ausencia que le mandan', async () => {
      const response = await request(server())
        .post(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          kind: 'VACATION',
          startsAt: '2026-01-05T09:00:00-03:00',
          endsAt: '2026-01-20T09:00:00-03:00',
          reason: 'me voy a Brasil',
        })
        .expect(201);

      expect(response.body).toMatchObject({ kind: 'VACATION' });

      const listado = await request(server())
        .get(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(listado.body).toMatchObject([{ kind: 'VACATION' }]);
    });

    /** El campo es opcional para no romper a quien ya cargaba ausencias. */
    it('sin tipo queda OTHER', async () => {
      const response = await request(server())
        .post(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          startsAt: '2026-01-05T09:00:00-03:00',
          endsAt: '2026-01-20T09:00:00-03:00',
        })
        .expect(201);

      expect(response.body).toMatchObject({ kind: 'OTHER' });
    });

    it('rechaza un tipo que no existe', async () => {
      await request(server())
        .post(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          kind: 'FRANCACHELA',
          startsAt: '2026-01-05T09:00:00-03:00',
          endsAt: '2026-01-20T09:00:00-03:00',
        })
        .expect(400);
    });

    it('rechaza una ausencia que termina antes de empezar', async () => {
      await request(server())
        .post(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          startsAt: '2026-01-20T09:00:00-03:00',
          endsAt: '2026-01-05T09:00:00-03:00',
        })
        .expect(400);
    });

    it('devuelve las que se solapan con el rango consultado', async () => {
      await request(server())
        .post(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          startsAt: '2026-01-05T00:00:00Z',
          endsAt: '2026-03-05T00:00:00Z',
          reason: 'Licencia larga',
        })
        .expect(201);

      // Febrero cae en el medio: la licencia tiene que aparecer igual.
      const febrero = await request(server())
        .get(
          `/employees/${employeeId}/time-off?from=2026-02-01T00:00:00Z&to=2026-02-28T00:00:00Z`,
        )
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(febrero.body).toHaveLength(1);

      const junio = await request(server())
        .get(
          `/employees/${employeeId}/time-off?from=2026-06-01T00:00:00Z&to=2026-06-30T00:00:00Z`,
        )
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(junio.body).toEqual([]);
    });

    it('la borra', async () => {
      const created = await request(server())
        .post(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          startsAt: '2026-01-05T00:00:00Z',
          endsAt: '2026-01-20T00:00:00Z',
        })
        .expect(201);

      const { id } = created.body as { id: string };

      await request(server())
        .delete(`/employees/${employeeId}/time-off/${id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      const listado = await request(server())
        .get(`/employees/${employeeId}/time-off`)
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(listado.body).toEqual([]);
    });
  });

  describe('Autorización por rol', () => {
    let employeeId: string;

    beforeEach(async () => {
      employeeId = (await invite()).employee.id;
    });

    it('un PROFESSIONAL lee el equipo pero no lo administra', async () => {
      await prisma.employee.update({
        where: { id: tenant.employeeId },
        data: { role: 'PROFESSIONAL', isOwner: false },
      });

      await request(server())
        .get('/employees')
        .set(...auth(tenant.accessToken))
        .expect(200);

      await request(server())
        .get(`/employees/${employeeId}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: 'otra@e2e.test',
          firstName: 'Otra',
          lastName: 'Persona',
          role: 'PROFESSIONAL',
        })
        .expect(403);

      await request(server())
        .patch(`/employees/${employeeId}`)
        .set(...auth(tenant.accessToken))
        .send({ role: 'ADMINISTRATIVE' })
        .expect(403);

      await request(server())
        .put(`/employees/${employeeId}/branches`)
        .set(...auth(tenant.accessToken))
        .send({ branchIds: [] })
        .expect(403);

      await request(server())
        .delete(`/employees/${employeeId}`)
        .set(...auth(tenant.accessToken))
        .expect(403);
    });
  });

  describe('Aislamiento entre negocios', () => {
    let otro: RegisteredTenant;
    let ajeno: string;

    beforeEach(async () => {
      otro = await registerTenant(app, 'Estética Norte');
      await switchPlan(prisma, otro.tenantId, 'empresa');
      ajeno = (await invite({ email: 'ajena@e2e.test' }, otro.accessToken))
        .employee.id;
    });

    it('cada negocio ve solo su equipo', async () => {
      await invite();

      const mio = await request(server())
        .get('/employees')
        .set(...auth(tenant.accessToken))
        .expect(200);
      const suyo = await request(server())
        .get('/employees')
        .set(...auth(otro.accessToken))
        .expect(200);

      expect(mio.body).toHaveLength(2);
      expect(suyo.body).toHaveLength(2);
      expect(
        (mio.body as { id: string }[]).map((employee) => employee.id),
      ).not.toContain(ajeno);
    });

    it('el empleado del otro negocio no existe para mí', async () => {
      await request(server())
        .get(`/employees/${ajeno}`)
        .set(...auth(tenant.accessToken))
        .expect(404);

      await request(server())
        .patch(`/employees/${ajeno}`)
        .set(...auth(tenant.accessToken))
        .send({ role: 'ADMINISTRATIVE' })
        .expect(404);

      await request(server())
        .delete(`/employees/${ajeno}`)
        .set(...auth(tenant.accessToken))
        .expect(404);

      await request(server())
        .post(`/employees/${ajeno}/invitation`)
        .set(...auth(tenant.accessToken))
        .expect(404);

      await request(server())
        .put(`/employees/${ajeno}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({ shifts: [] })
        .expect(404);

      await request(server())
        .post(`/employees/${ajeno}/time-off`)
        .set(...auth(tenant.accessToken))
        .send({
          startsAt: '2026-01-05T00:00:00Z',
          endsAt: '2026-01-20T00:00:00Z',
        })
        .expect(404);
    });
  });
});
