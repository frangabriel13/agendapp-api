import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { AuditOptions } from './audit.types';

export const AUDIT_KEY = 'audit';

/**
 * Marca un handler para que quede registrado quién lo ejecutó.
 *
 * **Opt-in, y esa es la decisión de diseño del módulo.** Un interceptor global
 * que registre todo request mutante escribe la contraseña de `POST /auth/login`
 * en la base: no es un problema de volumen, es un problema de seguridad. Y el
 * ruido tampoco es gratis — una auditoría donde todo entra es una en la que no
 * se encuentra nada.
 *
 * El criterio para ponerlo: **lo que alguien podría querer negar después.**
 * Quién entró, quién sumó o sacó a una persona del equipo, quién le cambió el
 * rol a quién, quién canceló un turno, quién cargó plata a mano.
 *
 * Lo que NO va: las lecturas (para eso están los logs de acceso) y la
 * configuración de bajo riesgo, que solo agrega filas que nadie va a leer.
 */
export const Audited = (options: AuditOptions): CustomDecorator<string> =>
  SetMetadata(AUDIT_KEY, options);
