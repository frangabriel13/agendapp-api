import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { TenantContextService } from '../../../common/tenant-context';
import type { AuthenticatedUser } from '../types/jwt-payload';
import { JwtAuthGuard } from './jwt-auth.guard';

/** Prototipo del mixin que devuelve `AuthGuard('jwt')`: ahí vive el canActivate real. */
const passportPrototype = Object.getPrototypeOf(
  JwtAuthGuard.prototype,
) as JwtAuthGuard;

const AUTHENTICATED_USER: AuthenticatedUser = {
  userId: 'u1',
  email: 'dueño@negocio.test',
  tenantId: 't1',
  employeeId: 'e1',
  role: 'OWNER',
};

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let tenantContext: { set: jest.Mock };
  let superCanActivate: jest.SpyInstance;

  const createContext = (user?: AuthenticatedUser): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => jest.fn(),
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    tenantContext = { set: jest.fn() };
    guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      tenantContext as unknown as TenantContextService,
    );
    superCanActivate = jest
      .spyOn(passportPrototype, 'canActivate')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deja pasar las rutas @Public() sin validar token ni resolver tenant', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
    expect(superCanActivate).not.toHaveBeenCalled();
    expect(tenantContext.set).not.toHaveBeenCalled();
  });

  it('resuelve el tenant-context con los datos del usuario autenticado', async () => {
    await expect(
      guard.canActivate(createContext(AUTHENTICATED_USER)),
    ).resolves.toBe(true);

    expect(superCanActivate).toHaveBeenCalledTimes(1);
    expect(tenantContext.set).toHaveBeenCalledWith({
      tenantId: 't1',
      userId: 'u1',
      employeeId: 'e1',
      role: 'OWNER',
    });
  });

  it('no resuelve tenant si passport rechaza el request', async () => {
    superCanActivate.mockResolvedValue(false);

    await expect(guard.canActivate(createContext())).resolves.toBe(false);
    expect(tenantContext.set).not.toHaveBeenCalled();
  });

  it('propaga el 401 que lanza la estrategia', async () => {
    superCanActivate.mockRejectedValue(new UnauthorizedException());

    await expect(guard.canActivate(createContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tenantContext.set).not.toHaveBeenCalled();
  });
});
