# syntax=docker/dockerfile:1

# Imagen de producción de la API.
#
# Tres stages y una sola imagen final, que sirve para las dos cosas: atender
# requests (el `CMD` por defecto) y aplicar migraciones (pasándole otro
# comando). Ver el bloque de migraciones más abajo, que es la decisión menos
# obvia del archivo.

# Alpine y no `slim` porque las zonas horarias andan igual: toda la aritmética
# de horarios de este proyecto pasa por `Intl` con la tz del negocio, y el ICU
# que Node trae embebido ya resuelve `America/Argentina/Buenos_Aires` sin el
# paquete `tzdata`. Verificado adentro de esta misma imagen.
ARG NODE_VERSION=24-alpine

# ── Dependencias de producción ──────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ── Build ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# `prisma generate` va SÍ o SÍ y va antes del build: con driver adapters no hay
# engine binario que descargar, pero los tipos del cliente se generan igual, y
# sin ellos `nest build` no compila una sola línea que toque la base.
RUN npx prisma generate && npm run build


# ── La app ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# El árbol de producción, más el cliente que generó el stage de build.
#
# ⚠️ Los dos `COPY` de `node_modules` son necesarios y no son redundantes.
# `prisma-client-js` escribe el cliente generado en `node_modules/.prisma/`, o
# sea adentro de un árbol que este stage arma con `--omit=dev` y que por lo
# tanto no lo tiene. Sin la segunda línea, la imagen levanta y revienta en el
# primer request con "@prisma/client did not initialize yet".
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

# `prisma/` y su config viajan aunque la app no los lea: son lo que necesita
# `migrate deploy`, que se corre con esta misma imagen (ver abajo). Pesan unos
# pocos KB.
COPY package.json prisma.config.ts ./
COPY prisma ./prisma

# ── Sobre el tamaño (~550 MB) y las migraciones ─────────────────────────────
#
# Los dos temas son el mismo tema. `@prisma/client` declara `prisma` y
# `typescript` como **peerDependencies**, y npm las instala igual con
# `--omit=dev`: el CLI completo (~40 MB, más engines y Studio) termina en el
# árbol de producción lo quiera uno o no. `--omit=peer` no lo saca —probado:
# baja 20 MB y `prisma` sigue ahí—, y borrar paquetes a mano de `node_modules`
# es frágil de un modo que no se nota hasta producción.
#
# Ya que el CLI está, se aprovecha: no hace falta una segunda imagen para
# migrar. Pero **las migraciones NO van en el arranque de la app**, y no es por
# gusto: la app corre con el rol restringido de RLS, que **no tiene permisos de
# DDL**. No es que no convenga migrar desde la app, es que no puede. Van como
# release command / pre-deploy del destino, con la URL del rol DUEÑO:
#
#   docker run --rm -e DATABASE_URL="<la del rol DUEÑO>" <imagen> \
#     npx prisma migrate deploy
#
# ⚠️ Y antes del primer deploy, una sola vez: `npm run db:rls-role` para crear
# el rol restringido, y apuntar la `DATABASE_URL` de la app ahí. Con el rol
# dueño las 29 políticas de RLS están puestas y **no cortan nada** — es un
# fallo mudo, no hay error que avise.

# El usuario `node` (uid 1000) ya viene en la imagen base. Nada de esto se
# escribe en runtime, así que alcanza con que sea legible.
USER node

EXPOSE 3001

# `/health` **toca la base**: es un readiness, no un liveness. Sirve para que el
# balanceador no le mande tráfico a un contenedor que todavía no conectó, y
# para ver el estado en un `docker ps`. Si el destino usa este healthcheck para
# reiniciar contenedores, ojo: una caída de Postgres marcaría toda la flota
# como unhealthy, y reiniciar la app no arregla una base caída.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node queda como PID 1 y eso está bien **porque `main.ts` llama a
# `enableShutdownHooks()`**: hay un handler de SIGTERM registrado, así que la
# señal del orquestador cierra el pool de `pg` en vez de matar el proceso de
# una. Sin ese handler, un proceso PID 1 sin manejador ignora SIGTERM y el
# apagado terminaría siempre en SIGKILL.
CMD ["node", "dist/main"]
