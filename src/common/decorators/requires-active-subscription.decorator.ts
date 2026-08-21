import { SetMetadata } from '@nestjs/common';

export const REQUIRES_ACTIVE_SUBSCRIPTION = 'requiresActiveSubscription';

/**
 * Marca una acción que un negocio con la suscripción vencida **no** puede
 * hacer.
 *
 * Se usa igual que `@Roles()`: el decorator solo deja una marca y el trabajo lo
 * hace `ActiveSubscriptionGuard`, que está montado como guard global. Eso evita
 * que el módulo de turnos tenga que importar el de suscripciones solo para
 * poder cobrar.
 *
 * **Ponerlo solo donde corresponde.** La regla es que se bloquea *crear valor
 * nuevo*, no operar lo que ya existe: un negocio que debe tiene que poder
 * seguir viendo su agenda, cancelar y avisarle a su clientela. Cortarle la
 * lectura convierte un problema de cobranza en un problema para gente que no
 * tiene nada que ver.
 */
export const RequiresActiveSubscription = () =>
  SetMetadata(REQUIRES_ACTIVE_SUBSCRIPTION, true);
