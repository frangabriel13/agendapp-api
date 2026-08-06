import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Hashing de contraseñas. Aislado en su propio provider para que el algoritmo
 * (hoy argon2id, el recomendado por OWASP) se pueda cambiar en un solo lugar
 * y para poder mockearlo en tests sin pagar el costo real del hash.
 */
@Injectable()
export class PasswordService {
  // argon2id con los parámetros por defecto de la librería
  // (m=64 MiB, t=3, p=4), alineados con la recomendación de OWASP.
  private readonly options: argon2.HashOptions = { type: argon2.argon2id };

  /**
   * Hash señuelo, calculado una sola vez al arrancar. Sirve para gastar el
   * mismo tiempo cuando el email no existe que cuando existe: si no, la
   * diferencia de latencia permite enumerar qué emails están registrados.
   */
  private readonly decoyHash: Promise<string> = argon2.hash(
    randomBytes(32).toString('hex'),
    this.options,
  );

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // Hash corrupto o con un formato que argon2 no reconoce.
      return false;
    }
  }

  /** Verificación descartable contra el hash señuelo (ver `decoyHash`). */
  async burnTime(): Promise<void> {
    await this.verify(await this.decoyHash, 'no-importa');
  }
}
