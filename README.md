# Práctica Juris · Gestión de Causas

Gestor de Trabajo Jurídico privado: cada abogada/o autenticada administra sus
propias causas, con datos sincronizados en la nube (Supabase), documentos
vinculados a Google Drive, agenda de eventos, gestiones de trabajo diario y
exportación de fichas en PDF.

## 1. Requisitos

- Node.js 18 o superior
- Una cuenta gratuita en [supabase.com](https://supabase.com)
- Una cuenta en [GitHub](https://github.com) y [Vercel](https://vercel.com) (para desplegar)

## 2. Crear el proyecto en Supabase

1. Entra a [supabase.com](https://supabase.com) → **New project**.
2. Cuando el proyecto esté listo, ve a **SQL Editor** → **New query**.
3. Copia y pega **todo** el contenido de `sql/schema.sql` y ejecútalo (botón *Run*).
   Esto crea todas las tablas, índices, triggers y políticas de seguridad (RLS)
   con la estructura actual y completa del proyecto (v1.2).
4. Ve a **Project Settings → API** y copia:
   - **Project URL** → lo usarás como `VITE_SUPABASE_URL`
   - **anon public key** → lo usarás como `VITE_SUPABASE_ANON_KEY`
5. (Opcional pero recomendado) En **Authentication → Providers → Email**, revisa si
   quieres exigir confirmación de correo antes del primer inicio de sesión. Si no
   quieres ese paso mientras pruebas la app, puedes desactivar "Confirm email".

> **¿Ya tienes un proyecto Supabase con datos reales de una versión anterior?**
> No vuelvas a ejecutar `schema.sql` completo. Ve directo a la sección
> **9. Migraciones para proyectos existentes**.

## 3. Configurar variables de entorno

En la raíz del proyecto:

```bash
cp .env.example .env
```

Edita `.env` y reemplaza los valores:

```
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_ANON_KEY=tu-anon-key
```

**Nunca subas el archivo `.env` a GitHub** (ya está excluido en `.gitignore`).

## 4. Ejecutar en tu computador

```bash
npm install
npm run dev
```

Abre la URL que muestra la terminal (por defecto `http://localhost:5173`).

Crea tu primera cuenta desde la pantalla de registro. Cada usuario solo ve sus
propias causas y datos (esto lo garantizan las políticas RLS de `schema.sql`).

## 5. Desplegar en GitHub + Vercel

```bash
git init
git add .
git commit -m "Práctica Juris - Gestor de Trabajo Jurídico v1.2"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

Luego en [vercel.com](https://vercel.com):

1. **Add New… → Project** → importa el repositorio de GitHub.
2. Framework preset: **Vite** (Vercel lo detecta automáticamente).
3. En **Environment Variables**, agrega:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy.

Cada vez que hagas `git push`, Vercel vuelve a desplegar automáticamente.

## 6. Estructura del proyecto

```
├── index.html                        Estructura HTML (login + app)
├── sql/
│   ├── schema.sql                    Esquema completo y actual (instalaciones nuevas)
│   ├── migration_agenda.sql          Migración: agrega la Agenda (agenda_eventos)
│   ├── migration_v1_2_gestor_trabajo.sql   Migración: Gestor de Trabajo Jurídico
│   ├── migration_v1_3_receptores.sql       Migración: normalización y receptores
│   ├── migration_v1_4_caratulado.sql       Migración: caratulado procesal e Informe Final
│   ├── migration_programacion_salas_baj.sql Migración: BAJ y Programación de salas
│   └── migration_google_calendar.sql       Migración: integración con Google Calendar
├── api/
│   └── google/                       Backend (Vercel Functions) — OAuth, sincronización
│       ├── auth-url.js, callback.js, status.js, list-calendars.js,
│       │   select-calendar.js, disconnect.js, preferences.js,
│       │   sync-event.js, delete-event.js, sync-pending.js, pending-count.js
│       └── _lib/                     Helpers: Supabase admin, cliente OAuth, payload de eventos
├── src/
│   ├── main.js                       Punto de entrada
│   ├── app.js                        Toda la lógica de la interfaz
│   ├── auth.js                       Registro, login, logout, recuperación de contraseña
│   ├── config.js                     URLs externas (SAJ, Oficina Judicial Virtual, correo)
│   ├── supabaseClient.js             Cliente de Supabase (usa las variables VITE_*)
│   ├── style.css                     Estilos (tema oscuro)
│   └── lib/api.js                    Funciones de acceso a datos (CRUD por tabla)
├── .env.example
├── package.json
└── vite.config.js
```

## 7. Filosofía de la aplicación

La pantalla de entrada no es el listado de causas: es el **Centro de
Trabajo**, que responde a la pregunta "¿qué debo hacer hoy?". La causa es el
contexto; las **gestiones** son la unidad real de trabajo diario; la
**instrucción del tutor** es solo un antecedente histórico; la **Agenda**
administra exclusivamente eventos (audiencias, reuniones, citas, llamadas).

## 8. Funcionalidades actuales

### Causas
- Carpetas por estado (En tramitación / Nueva / Terminada) y subcarpetas por
  tipo de juicio, con filtros y buscador (ROL, RUT, Código SAJ, patrocinado, materia).
- Ficha de causa con pestañas: **Resumen · Gestiones · Agenda · Notificación ·
  Contacto · Editar · Exportar ficha**.
- **Prioridad de la causa**: se define manualmente (Urgente / Semi urgente /
  No prioritaria) desde la pestaña Editar. Clasifica visualmente tu cartera;
  no depende de ninguna instrucción ni fecha límite.
- Tarjetas superiores (clicables, funcionan como filtro): Causas activas,
  Urgente, Semi urgente, No prioritario, Agenda.
- **Última revisión PJUD**: campo de solo lectura + botón "Actualizar
  revisión" en la pestaña Editar de cada causa. Solo registra fecha y hora;
  no genera gestiones ni eventos.

### Gestiones (la unidad de trabajo)
- Cada gestión tiene: descripción, categoría, prioridad (Urgente / Semi
  urgente / No prioritaria), estado (**Pendiente / En espera / Realizada /
  Cancelada**), fecha de revisión, fecha límite opcional, enlace de Drive
  opcional y observaciones.
- El estado **"En espera"** representa gestiones que dependen de un tercero
  (tribunal, institución, patrocinado, receptor, etc.): nunca se muestran
  como vencidas ni atrasadas, y permanecen visibles hasta la fecha de
  revisión que definas.
- Una gestión marcada **Realizada** o **Cancelada** deja de aparecer de
  inmediato en el Centro de Trabajo, en los indicadores y en cualquier lista
  de pendientes — sin importar su fecha.
- Botón **"+ Agenda"** en cada gestión: abre la pestaña Agenda de la misma
  causa con un evento nuevo pre-cargado con el título de la gestión, para
  programarlo cuando tú decidas. Las gestiones nunca se convierten en eventos
  automáticamente.

### Instrucción del tutor (antecedente histórico)
- Historial dentro de la pestaña Gestiones: tutor, fecha, instrucción, fecha
  límite y estado (**Pendiente / Cumplida**).
- No calcula prioridades, no genera tareas ni recordatorios, no afecta al
  Centro de Trabajo ni a ningún indicador. Su única función es dejar
  constancia de qué instrucciones se recibieron y cuándo.

### Centro de Trabajo
- Vista principal (pantalla de entrada). Reúne automáticamente las gestiones
  Pendiente/En espera de **todas** las causas, organizadas en 5 bloques: **Hoy**,
  **Próximos 7 días**, **En espera**, **Vencidas**, **Sin fecha**.
- Cada tarjeta muestra prioridad, estado, fecha de revisión, ROL, patrocinado
  y descripción. Un clic abre la causa correspondiente en su pestaña Gestiones.

### Agenda (exclusivamente eventos)
- Administra solo eventos: Audiencia, Cita con usuario, Reunión con tutor,
  Llamada, Plazo procesal, Presentación de escrito, Revisión de causa, Gestión
  importante, Recordatorio, Otro.
- Cada evento: causa asociada, tipo, título, descripción, fecha, hora de
  inicio/término, modalidad, ubicación, enlace de videollamada, estado
  (Pendiente/Confirmado/Realizado/Suspendido/Reprogramado/Cancelado),
  prioridad y observaciones.
- Vista global "Agenda" en la barra lateral: filtros (causa, tipo, estado,
  prioridad, fecha), buscador y 4 vistas (Lista, Mes, Semana, Día).
- Bloques en el panel principal: **"Hoy"** (avisos simples: hoy, mañana,
  vencidos, plazos próximos) y **"Próximos compromisos"** (los 5 eventos más
  cercanos) — ambos muestran únicamente eventos de la Agenda, nunca gestiones.
- Preparada para una futura integración con Google Calendar (no incluida
  todavía: sin OAuth, sin tokens, sin Edge Functions).

### Notificación / Contacto
- Estado de notificación y persona a notificar, con tabla editable de
  domicilios (domicilio, resultado, fecha, folio, informado por).
- Datos de contacto del patrocinado (correo, correo alternativo, teléfono,
  nota, tutor, fecha de ingreso) y accesos a claves del portal PJUD / Clave
  Única (nunca se incluyen en la ficha exportable ni en el PDF).

### Cronología jurídica
- Historial narrativo libre de la causa: solo contenido, editar y eliminar.
  La fecha de cada actuación se escribe como parte del texto, no se muestra
  por separado.

### Revisión PJUD
- Módulo independiente en la barra lateral. Lista todas las causas en
  tramitación con ROL, patrocinado, tribunal y última revisión, con botón
  **"Revisado"** que actualiza fecha y hora. Es puramente informativo: no
  genera gestiones, eventos ni entradas en la cronología (comparte el mismo
  dato que "Última revisión" dentro de cada causa).

### Encargo receptor
- Registro independiente de diligencias encargadas a un receptor judicial.
- Incluye **Estado de gestión** (Pendiente de encargo / Encargado), que se
  muestra junto a la urgencia de la diligencia en cada tarjeta.

### Expediente / Documentación
- Cada causa se vincula a una carpeta de Google Drive (solo se guarda el
  enlace; los documentos permanecen en Drive). Se administra desde la pestaña
  Editar: campo editable, indicador de vínculo y botón "Abrir carpeta en
  Google Drive". Se guarda junto con el resto de los cambios de esa pestaña.

### Accesos rápidos (cabecera de cada causa)
- **Drive** — abre `drive_folder_url` de la causa (avisa si aún no existe).
- **SAJ** — abre la aplicación SAJ.
- **OJV** — abre la Oficina Judicial Virtual.
- **Correo** — abre Gmail.
- Las tres URLs generales están centralizadas en `src/config.js`.

### Exportar ficha (PDF e impresión)
- Ficha profesional generada con texto real (no captura de pantalla):
  márgenes de 2,5 cm, numeración "Página X de Y", fecha/hora de generación y
  usuario que la generó, formato de fechas chileno (dd-mm-aaaa).
- Solo incluye secciones y campos con información real (oculta lo vacío).
- Orden de secciones: Datos generales · Resumen · Instrucciones del tutor
  (historial) · Gestiones pendientes · Historial de gestiones · Notificación ·
  Domicilios de notificación · Contacto · Audiencia · Próximos eventos ·
  Documentación.
- Nunca incluye Clave portal PJUD ni Clave Única.

### Diseño
- Tema oscuro, menú lateral contraíble en celular, sin desplazamiento
  horizontal, tarjetas de una columna en pantallas angostas.

## 9. Migraciones para proyectos existentes

Si ya tienes datos reales en Supabase de una versión anterior, ejecuta las
migraciones **en este orden** (todas son no destructivas: no eliminan tablas,
columnas ni registros, y son seguras de ejecutar más de una vez):

1. **`sql/migration_agenda.sql`** — crea `agenda_eventos` y migra las
   audiencias que ya tenías (columna `fecha_audiencia` de `causas`) como
   eventos de tipo "Audiencia".
2. **`sql/migration_v1_2_gestor_trabajo.sql`** — amplía `gestiones_pendientes`
   con categoría/prioridad/estado/fecha de revisión/fecha límite/observaciones
   (tus gestiones existentes quedan en estado "Pendiente"); crea
   `instrucciones_tutor` y migra la instrucción que tenía cada causa; agrega
   `causas.ultima_revision_at` y `encargos_receptor.estado_gestion`.
3. **`sql/migration_v1_3_receptores.sql`** — agrega el tribunal normalizado y
   la contraparte a `causas`; agrega los campos del receptor de turno a
   `encargos_receptor`; crea `receptores_judiciales` y `turnos_receptores`.
   Detalle completo en la sección 11.
4. **`sql/migration_v1_4_caratulado.sql`** — agrega `demandante_nombre`,
   `demandado_nombre`, `parte_representada`, `resultado_beneficio` y
   `observaciones_traspaso` a `causas`. Detalle completo en la sección 12.
5. **`sql/migration_programacion_salas_baj.sql`** — agrega `baj_estado` a
   `causas`; crea `revisiones_sala`. Detalle completo en la sección 13.
   **Debes ejecutarla antes de desplegar/probar esta versión.**
6. **`sql/migration_google_calendar.sql`** — agrega campos de sincronización
   a `agenda_eventos`; crea `google_calendar_conexiones` (sin RLS para el
   frontend) y `calendar_sync_log`. Detalle completo en la sección 14.
   **Debes ejecutarla antes de desplegar/probar esta versión.**

En todos los casos: copia el contenido completo del archivo en el **SQL
Editor** de tu proyecto Supabase y presiona **Run**. Ninguna migración toca
RLS, autenticación, ni ninguna otra tabla fuera de lo descrito.

Si estás creando un proyecto Supabase **nuevo**, no necesitas ejecutar estas
migraciones por separado: `sql/schema.sql` ya incluye toda la estructura
actual de una sola vez.

## 10. Pasos de prueba sugeridos

1. Ejecuta las migraciones (o `schema.sql` si es un proyecto nuevo) y
   `npm install && npm run dev`.
2. Confirma que la pantalla de entrada es el **Centro de Trabajo**.
3. Crea una gestión con fecha de revisión = hoy → debe aparecer en "Hoy".
   Cámbiala a "En espera" → debe aparecer en ese bloque sin importar la
   fecha. Márcala "Realizada" → debe desaparecer de todos los bloques e
   indicadores.
4. Usa "+ Agenda" en una gestión y confirma que abre el formulario de nuevo
   evento con el título prellenado.
5. En Editar, cambia la Prioridad de una causa y confirma que la tarjeta
   superior correspondiente se actualiza.
6. Presiona "Actualizar revisión" en una causa y confirma que se refleja en
   el módulo Revisión PJUD.
7. Revisa que el historial de "Instrucciones del tutor" muestre correctamente
   las instrucciones migradas (Pendiente/Cumplida).
8. Prueba los 4 accesos rápidos (Drive, SAJ, OJV, Correo) y las 4 vistas de
   la Agenda global (Lista/Mes/Semana/Día).
9. Genera el PDF de una causa con datos reales y confirma que las secciones
   vacías no aparecen y que las fechas están en formato dd-mm-aaaa.
10. Prueba todo lo anterior también en una pantalla angosta (celular).

## 11. v1.3 — Normalización de causas, Encargo receptor y Administración de receptores

### 12.1 Cómo ejecutar la migración

Ejecuta `sql/migration_v1_3_receptores.sql` en el **SQL Editor** de tu proyecto
Supabase (después de las migraciones de versiones anteriores, si las tienes
pendientes). Es no destructiva y segura de ejecutar más de una vez:

- Agrega a `causas`: `tipo_tribunal`, `numero_tribunal`, `ciudad_tribunal`,
  `contraparte_nombre`. La columna antigua `tribunal` (texto libre) **no se
  elimina** y queda visible como respaldo hasta que normalices cada causa
  manualmente desde Editar → Tribunal.
- Agrega a `encargos_receptor` los campos del receptor de turno y la
  trazabilidad de la asignación (sugerido/confirmado).
- Crea las tablas `receptores_judiciales` y `turnos_receptores`, con FKs,
  índices, triggers de `updated_at` y RLS.

Si es un proyecto Supabase nuevo, `sql/schema.sql` ya incluye todo esto.

### 12.2 Qué cambia

- **ROL sin duplicar**: en vistas compactas (tarjetas, Centro de Trabajo,
  Agenda, Revisión PJUD, buscador) se muestra solo el ROL (`C-10560-2026`),
  sin la palabra "ROL" ni repetirlo en el título.
- **Tribunal normalizado**: se construye desde tipo + número + ciudad
  (ej. "2° Juzgado Civil de Santiago"). Es la única fuente usada en toda la
  aplicación (tarjeta, ficha, Centro de Trabajo, Agenda, Revisión PJUD, PDF).
  Se edita desde Editar → Tribunal.
- **Partes abreviadas**: la tarjeta de causa muestra "Apellido / Contraparte"
  (ej. "Arcos / Ilustre Municipalidad de Pudahuel") en vez del nombre
  completo. Los nombres completos se mantienen en Contacto, Resumen, Encargo
  receptor y la ficha exportable.
- **Corregido un bug real**: el ROL de la causa nunca había sido editable en
  la interfaz — por eso Revisión PJUD podía parecer desactualizada. Ahora es
  editable desde Editar, junto con el tribunal y la contraparte.
- **Encargo receptor**: si el estado es "Encargado", ya no se muestra
  "Urgente" (la urgencia queda como dato histórico interno). Formulario
  reorganizado en 2 columnas con los campos nuevos del receptor de turno y
  la fecha de resolución (distinta de la fecha de encargo).
- **Administración de receptores** (nuevo, en la barra lateral): catálogo de
  receptores judiciales, catálogo de turnos, e importación mensual de PDF/CSV.

### 12.3 Sugerencia automática de receptor (Encargo receptor)

Al ingresar la **fecha de resolución** y la **jurisdicción**, el botón
"Buscar receptor sugerido" consulta el catálogo interno de turnos:

- **Un turno aplicable** → muestra el receptor sugerido con sus datos de
  contacto; el botón **"Confirmar receptor"** completa los campos del
  formulario (no guarda nada hasta que presionas "Guardar registro").
- **Varios turnos superpuestos** → se listan todos para que elijas
  manualmente; nunca se asigna uno automáticamente en ese caso.
- **Ningún turno cargado** para esa fecha/jurisdicción → mensaje claro con
  accesos directos a "Administración de receptores" o a seleccionar un
  receptor del catálogo manualmente.

Los encargos ya confirmados no se modifican automáticamente si el catálogo de
turnos cambia después.

### 12.4 Importar PDF / CSV de turnos (mensual)

Desde **Administración de receptores → Importar PDF / CSV**:

1. Arrastra el PDF oficial de turnos (o un CSV/TXT) al recuadro, o elige el
   archivo.
2. La aplicación intenta leerlo automáticamente:
   - **PDF**: extrae el texto y busca líneas con dos fechas (rango de turno),
     usando el resto de la línea como nombre candidato. Es una heurística
     simple — **no reemplaza tu revisión**.
   - **CSV/TXT**: columnas esperadas `nombre,telefono,correo,domicilio,
     jurisdiccion,fecha_inicio,fecha_fin` (fechas en `AAAA-MM-DD`; puede
     llevar o no una fila de encabezado).
3. Se muestra siempre una **vista previa editable** — corrige nombres,
   fechas o jurisdicción, agrega filas manuales o quita las que no
   correspondan.
4. Al presionar **"Confirmar importación"**: se validan fechas, se avisa de
   filas duplicadas dentro del mismo archivo y de turnos superpuestos con
   los ya guardados (no se bloquea, pero se te avisa), y recién ahí se
   guarda en Supabase. Los receptores nuevos que no existan en el catálogo
   se crean automáticamente con el nombre detectado; los existentes se
   reutilizan (no se duplican).
5. Si el PDF no puede leerse (formato no compatible, error de red al cargar
   el lector), se te avisa explícitamente y puedes seguir con ingreso manual
   o un archivo CSV — nunca se inventa información.

> Nota técnica: la lectura de PDF usa `pdfjs-dist` cargado bajo demanda (no
> aumenta el tamaño inicial de la app) con su *worker* servido desde CDN. Si
> por cualquier motivo no carga (por ejemplo, sin conexión a esa CDN), la
> aplicación lo indica y permite continuar con carga manual o CSV — la
> función nunca queda bloqueada.

Fuentes oficiales de referencia (configurables en `src/app.js`, constantes
`FUENTE_TURNOS_URL` / `FUENTE_CONTACTO_URL`): turnos de receptores (PJUD) y
listado de receptores judiciales (Corte de Santiago).

### 12.5 Archivos modificados o agregados

- `sql/migration_v1_3_receptores.sql` — **nuevo**, migración no destructiva.
- `sql/schema.sql` — actualizado para instalaciones nuevas.
- `src/lib/api.js` — mapeo de tribunal normalizado y contraparte; campos
  nuevos de Encargo receptor; CRUD de `receptores_judiciales` y
  `turnos_receptores`.
- `src/app.js` — helpers `tribunalTexto()`, `tituloSinRol()`,
  `partesAbreviadas()`; ROL editable (corrección de bug); Editar con
  Tribunal normalizado y Contraparte; Encargo receptor con badge corregido,
  formulario de 2 columnas y sugerencia automática de receptor; módulo
  completo de Administración de receptores (catálogo, turnos, importación).
- `src/style.css` — responsividad de formularios de 2 columnas, tarjetas de
  receptor, zona de importación.
- `index.html` — ítem de navegación "Administración de receptores".
- `package.json` — agregada la dependencia `pdfjs-dist`.
- `README.md` — esta sección.

### 12.6 Pasos de prueba sugeridos

1. Ejecuta `sql/migration_v1_3_receptores.sql`, luego `npm install && npm run dev`
   (necesario por la nueva dependencia `pdfjs-dist`).
2. Edita el ROL de una causa existente → confirma que se refleja de
   inmediato en la tarjeta, en Revisión PJUD y en el buscador.
3. Completa el tribunal normalizado de una causa (tipo + número + ciudad) →
   confirma la vista previa en vivo y que se refleje en tarjeta/ficha/PDF.
4. Agrega una contraparte a una causa con patrocinado → confirma que la
   tarjeta muestra "Apellido / Contraparte".
5. En un Encargo receptor marcado "Urgente", cambia el estado a "Encargado"
   → confirma que la etiqueta "Urgente" desaparece.
6. Ve a Administración de receptores → agrega un receptor manualmente →
   agrega un turno manual para ese receptor con fechas superpuestas a otro
   ya existente → confirma que aparece la advertencia.
7. Importa un CSV de prueba con 2-3 filas → revisa la vista previa, corrige
   una fecha, confirma la importación → verifica que aparecen en "Turnos" y
   que el receptor nuevo quedó en el catálogo.
8. En un Encargo receptor, ingresa una fecha de resolución dentro de un
   turno cargado → presiona "Buscar receptor sugerido" → confirma que
   aparecen los datos correctos → "Confirmar receptor" → guarda el registro.
9. Prueba con una fecha sin turno cargado → confirma el mensaje y las
   opciones ofrecidas (ir a Administración de receptores / seleccionar
   manualmente).
10. Prueba todo lo anterior en una pantalla angosta (celular): formularios en
    una columna, tablas convertidas en tarjetas, sin desplazamiento
    horizontal.

## 12. v1.4 — Caratulado procesal, Informe Final e importación de receptores

### 12.1 Cómo ejecutar la migración

Ejecuta `sql/migration_v1_4_caratulado.sql` en el **SQL Editor** de tu proyecto
Supabase (después de las migraciones anteriores si las tienes pendientes).
No destructiva, segura de ejecutar más de una vez:

- Agrega a `causas`: `demandante_nombre`, `demandado_nombre`, `parte_representada`,
  `resultado_beneficio`, `observaciones_traspaso`.
- **No elimina** `patrocinado` ni `contraparte_nombre`; quedan intactos como
  respaldo y compatibilidad.

Si es un proyecto Supabase nuevo, `sql/schema.sql` ya incluye todo esto.

### 12.2 Regularizar causas antiguas (importante)

Las causas creadas antes de esta versión no tienen `demandante_nombre` /
`demandado_nombre` definidos. La aplicación **nunca invierte ni infiere
automáticamente** quién era demandante y quién demandado: mientras no los
definas, verás el aviso **"Pendiente definir posición procesal de las
partes"** en Editar, y el caratulado se sigue mostrando con el respaldo
anterior (patrocinado/contraparte, sin garantía de orden procesal).

Para regularizar una causa: entra a **Editar → Caratulado procesal**,
completa Demandante y Demandado, y elige qué parte representas. Al guardar,
el caratulado pasa a mostrarse en el orden procesal correcto en toda la
aplicación, y el campo "Patrocinado" se sincroniza automáticamente (sin
tener que volver a escribirlo).

### 12.3 Caratulado procesal

- El caratulado **siempre** respeta el orden `Demandante / Demandado`,
  representes a quien representes. Nunca se invierte según la parte
  patrocinada.
- Para personas naturales usa el primer apellido; para personas jurídicas
  conserva el nombre institucional completo.
- Se aplica en todas las vistas compactas: tarjeta de causa, Centro de
  Trabajo, Revisión PJUD, Próximos compromisos, Agenda, buscador, y en la
  ficha/PDF individual (sección "Caratulado", justo después del ROL).
- En la ficha/PDF individual: el campo "Parte" pasó a llamarse "Patrocinado"
  (nombre completo de la parte que representas, derivado automáticamente de
  `parte_representada`); el campo "Contraparte" ya no aparece por separado
  porque queda reflejado dentro del caratulado.

### 12.4 Informe Final

Nuevo ítem en la barra lateral, en su propio grupo (separado de Encargo
receptor y Administración de receptores). Genera el informe de cierre de
práctica para traspasar las causas al siguiente postulante:

1. **Configurador**: elige qué causas incluir (todas / solo en tramitación /
   solo nuevas / solo terminadas / selección manual con "seleccionar todas"
   y contador), el orden (por ROL, tribunal, caratulado, estado, fecha de
   ingreso, prioridad, o "agrupar por estado" — recomendado), y qué campos
   incluir (checkboxes agrupados en Datos básicos, Gestión y Agenda).
2. **Vista previa**: muestra el total de causas y el desglose por carpeta
   antes de generar nada.
3. **Generar PDF**: un único archivo con portada (título, tu nombre, área,
   institución, fecha) y un bloque por causa con el modelo mínimo (ROL,
   tribunal, caratulado, materia, gestiones realizadas y resultado obtenido,
   gestiones pendientes) más los campos adicionales que hayas marcado.
   Las causas terminadas **nunca se excluyen automáticamente**.

Es una operación **solo de lectura**: no modifica causas, gestiones, estados
ni la Agenda bajo ninguna circunstancia.

Las "gestiones realizadas" se toman de las gestiones con estado *Realizada*;
las "gestiones pendientes" de las gestiones *Pendiente*/*En espera* — nunca
se inventa ni se reclasifica automáticamente una gestión.

### 12.5 Nuevos campos por causa

- **Resultado o beneficio obtenido para el usuario** (Resumen): texto libre,
  editable manualmente, nunca autocompletado. Incluible en la ficha
  individual y en el Informe Final.
- **Observaciones de traspaso** (Resumen): texto libre para dejar contexto a
  quien reciba la causa después. No genera gestiones, eventos ni entradas en
  la cronología.

### 12.6 Importación de receptores: PDF reales de la Corte de Santiago

Se corrigió el importador para reconocer los dos formatos oficiales reales:

- **Listado de receptores** (bloques: nombre, domicilio, teléfono, celular,
  correo) — el nombre se identifica por texto tipo "Nombre Apellido"; las
  líneas siguientes se clasifican automáticamente como correo, teléfono/
  celular o domicilio hasta el próximo nombre.
- **Turno mensual** — extrae un registro por cada línea que coincida con
  "N° Juzgado Civil de Santiago" (1° a 30°), ignorando Corte Suprema, Corte
  de Apelaciones, Cobranza Laboral y otras materias no civiles. El mes y año
  se detectan automáticamente desde el documento.

Al subir un PDF, la aplicación **detecta automáticamente** cuál de los dos
formatos corresponde y lo indica ("Tipo de documento detectado"), pero
siempre puedes corregirlo manualmente con un selector antes de confirmar —
la vista previa se vuelve a generar con el tipo que elijas.

**Vinculación turno ↔ receptor**: al importar un turno, se busca el receptor
por nombre normalizado (sin tildes, mayúsculas ni espacios repetidos); si ya
existe en el catálogo se reutiliza (nunca se duplica), si no existe se crea
desde la propia vista previa.

**PDF escaneado (sin texto)**: si el PDF no tiene una capa de texto útil, la
aplicación **no** se limita a decir "no reconocido" — lo indica claramente y
ofrece continuar con ingreso manual de filas o con un archivo CSV/TXT.

> **Sobre OCR**: esta versión no incorpora reconocimiento óptico de
> caracteres (OCR) para PDFs escaneados. Añadir OCR confiable normalmente
> requiere un servicio externo (con sus propios costos y credenciales) o una
> librería pesada en el navegador cuya precisión es limitada para este tipo
> de documentos legales. Dado que ninguna extracción automática debe
> guardarse sin revisión humana de todas formas, se priorizó una alternativa
> **siempre funcional y confiable**: ingreso manual o CSV/TXT, que nunca
> bloquea la carga de datos. Si más adelante quieres integrar un servicio de
> OCR específico (por ejemplo uno compatible con Vercel Functions), puede
> añadirse en una versión posterior sin afectar lo ya construido.

### 12.7 Archivos modificados o agregados

- `sql/migration_v1_4_caratulado.sql` — **nuevo**, migración no destructiva.
- `sql/schema.sql` — actualizado para instalaciones nuevas.
- `src/lib/api.js` — mapeo de los 5 campos nuevos de `causas`.
- `src/app.js` — `caratuladoTexto()`, `patrocinadoEfectivo()`,
  `tieneRolProcesalDefinido()`; Editar con sección "Caratulado procesal";
  Resumen con Resultado/beneficio y Observaciones de traspaso; ficha PDF con
  Caratulado/Patrocinado y sin Contraparte independiente; módulo completo
  **Informe Final** (`crearEscritorPdf` reutilizable, configurador, vista
  previa, generación de PDF multi-causa); importador de receptores
  reescrito (`detectarTipoDocumento`, `parsearListadoReceptoresPdf`,
  `parsearTurnoMensualCivilPdf`, detección de PDF escaneado).
- `src/style.css` — grilla de campos del Informe Final.
- `index.html` — ítem de navegación "Informe Final".
- `README.md` — esta sección.

### 12.8 Pasos de prueba sugeridos

1. Ejecuta `sql/migration_v1_4_caratulado.sql`, luego `npm install && npm run dev`.
2. En una causa con solo `patrocinado`/`contraparte_nombre` (sin regularizar),
   confirma que aparece el aviso "Pendiente definir posición procesal".
3. Define Demandante/Demandado y marca "Parte que represento = Demandado" →
   confirma que el caratulado se muestra **Demandante / Demandado** (no al
   revés) en la tarjeta, Centro de Trabajo, Revisión PJUD y el PDF.
4. Exporta la ficha de esa causa → confirma "Caratulado" después del ROL,
   "Patrocinado" con el nombre correcto, y que no aparece "Contraparte".
5. Ve a Informe Final → prueba los 5 filtros de causas (todas/tramitación/
   nuevas/terminadas/selección manual con contador), cambia el orden,
   desmarca algunos campos → genera el PDF y confirma portada + bloques por
   causa + numeración de páginas.
6. Confirma que generar el Informe Final no modificó ninguna causa (revisa
   `updated_at` o el estado antes/después).
7. En Administración de receptores → Importar, prueba con un CSV de listado
   simulando el formato de bloques, y verifica la detección de tipo, la
   vista previa y la importación.
8. Prueba con un PDF de turno mensual (o simula uno) y confirma que se
   generan varios turnos (uno por tribunal civil) vinculados al receptor
   correcto, y que Corte Suprema/Corte de Apelaciones quedan excluidas.
9. Prueba subir un archivo que no tenga texto (por ejemplo, una imagen
   guardada como PDF) y confirma que se muestra el aviso de PDF escaneado
   con las alternativas (manual/CSV), no un error genérico.

## 13. BAJ, Antecedentes y Programación de salas

### 13.1 Cómo ejecutar la migración

**Debes ejecutar esta migración en Supabase antes de desplegar/probar la
nueva versión.** Ejecuta `sql/migration_programacion_salas_baj.sql` en el
**SQL Editor** de tu proyecto Supabase (después de las migraciones
anteriores si las tienes pendientes). Es no destructiva y segura de
ejecutar más de una vez:

- Agrega `baj_estado` a `causas` (valores: `acompanado`, `solicitar`,
  `no_acompanado`).
- Crea la tabla `revisiones_sala` (historial de Programación de salas), con
  `user_id`, `causa_id` (FK a `causas`, `on delete cascade` — eliminar una
  revisión nunca elimina la causa), índices, trigger de `updated_at` y RLS.

Si es un proyecto Supabase nuevo, `sql/schema.sql` ya incluye todo esto y no
necesitas ejecutar la migración por separado.

**Sin esta migración, la aplicación no cargará** (el selector BAJ y
Programación de salas dependen de estas columnas/tabla).

### 13.2 Resumen y Antecedentes reorganizados

- **Resumen** ahora contiene solo información general y descriptiva: Objetivo
  de la apelación (si existe), Clave para recordar, Estado actual, Resumen de
  la causa, **Carpeta de Google Drive** (recién movida aquí, entre "Resumen
  de la causa" y "Comentarios", con el mismo funcionamiento de siempre),
  Comentarios, Observaciones de traspaso y Próximos hitos.
- Los campos **Etapa, Materia, Código SAJ, Recurso y ROL ingreso Corte**
  se movieron a **Antecedentes** — no se duplicaron, solo cambiaron de
  ubicación.
- El campo **Parte** se eliminó de Resumen (la parte representada ya se
  define en Antecedentes → Caratulado procesal, con Demandante/Demandado).
- El campo **Resultado o beneficio obtenido para el usuario** ya no se
  muestra en Resumen. El dato **no se borró**: sigue disponible como
  columna en la base de datos y puede seguir incluyéndose en el **Informe
  Final** (checkbox "Resultado o beneficio obtenido").

### 13.3 BAJ (Beneficio de Asistencia Judicial)

- Nueva pestaña **Antecedentes** (antes llamada "Editar" — se renombró la
  pestaña existente, no se creó una nueva).
- Primera línea: **Código SAJ | Etapa | Materia | BAJ**. Segunda línea:
  **Recurso | ROL ingreso Corte**. Debajo continúa el resto del formulario
  ya existente (Título/ROL, Carpeta, Tipo de juicio, Prioridad, Tribunal,
  Caratulado procesal, Última revisión PJUD).
- BAJ es un selector con exactamente tres opciones: Acompañado, Solicitar,
  No acompañado. No identifica la parte representada — eso sigue siendo
  responsabilidad exclusiva de los campos procesales (Demandante/Demandado/
  Parte que represento).

### 13.4 Programación de salas

Nueva opción en la barra lateral, dentro del grupo renombrado
**"Revisiones y tareas"** (antes "Vistas"), inmediatamente después de
Revisión PJUD. Es un control independiente: no comparte checkbox ni fecha
de revisión con Revisión PJUD, no crea gestiones, no modifica la
tramitación ni la Agenda, y no crea eventos en Google Calendar.

- **Se alimenta automáticamente** de las causas cuyo campo Recurso (en
  Antecedentes) indique una apelación — comparación tolerante a mayúsculas y
  variaciones razonables ("Apelación", "Recurso de apelación", "Apelación
  subsidiaria", etc.). No hay selección manual: si cambias el Recurso de una
  causa, aparece o desaparece de esta vista automáticamente en el siguiente
  render.
- Cada causa muestra ROL, ROL ingreso Corte, tribunal, caratulado, recurso,
  estado de revisión, fecha de la última revisión y su resultado.
- **Marcar revisado**: registra fecha y hora automáticamente, con un
  selector de Resultado (Sin programación / En tabla / Suspendida /
  Reprogramada / Vista / Otro). Si el resultado es "En tabla", se habilitan
  campos opcionales de fecha de alegato, sala y número de tabla.
- **Historial completo** por causa (fecha, hora, resultado, observación),
  consultable con "Ver historial".
- **Periodicidad semanal (viernes/sábado después de las 17:00)**: la
  aplicación calcula automáticamente cuándo corresponde una nueva revisión
  (a partir del viernes más reciente). Cuando comienza un nuevo período, la
  causa vuelve a mostrarse como "Pendiente de revisión" **sin borrar nunca**
  la fecha ni el resultado de la revisión anterior — todo queda en el
  historial. La única excepción es el resultado **"Vista"**: una vez
  registrado, la causa deja de pedirse en revisiones semanales futuras
  (aunque sigue visible en el historial y en el filtro "Vistas").
- Contadores automáticos (Apelaciones activas, Pendientes de revisión, En
  tabla, Vistas), filtros (Todas/Pendientes/Revisadas/En tabla/Vistas) y
  buscador (ROL, ROL ingreso Corte, caratulado, tribunal).

### 13.5 Archivos modificados o agregados

- `sql/migration_programacion_salas_baj.sql` — **nueva**, migración no
  destructiva.
- `sql/schema.sql` — actualizado para instalaciones nuevas.
- `src/lib/api.js` — mapeo de `bajEstado`; CRUD de `revisiones_sala`.
- `src/app.js` — Resumen reorganizado; pestaña "Editar" renombrada a
  "Antecedentes" con las dos filas nuevas; helpers `esRecursoApelacion()`,
  `causasConApelacion()`, `calcularInicioPeriodoActual()`,
  `estadoRevisionSala()`; módulo completo de Programación de salas.
- `src/style.css` — grid de 4 columnas, tarjetas y contadores de
  Programación de salas.
- `index.html` — "Vistas" renombrado a "Revisiones y tareas"; ítem
  "Programación de salas" agregado.
- `README.md` — esta sección.

### 13.6 Pasos de prueba sugeridos

1. **Ejecuta primero la migración** (`sql/migration_programacion_salas_baj.sql`),
   luego `npm install && npm run dev`.
2. En Resumen, confirma que ya no aparecen "Resultado o beneficio" ni
   "Parte", y que Google Drive aparece entre "Resumen de la causa" y
   "Comentarios" y sigue abriendo/guardando correctamente.
3. En Antecedentes, confirma la primera línea (Código SAJ/Etapa/Materia/BAJ)
   y la segunda (Recurso/ROL ingreso Corte); guarda cambios y recarga para
   confirmar persistencia, incluyendo las 3 opciones de BAJ.
4. Cambia el Recurso de una causa a "Apelación" → confirma que aparece
   automáticamente en Programación de salas. Quítaselo → confirma que
   desaparece.
5. En una causa con apelación, marca "Revisado" con resultado "En tabla",
   completa fecha de alegato/sala/N° de tabla → guarda y confirma que se ve
   destacado y en el historial.
6. Marca otra revisión con resultado "Vista" → confirma que deja de
   contarse como pendiente aunque pase el tiempo, pero sigue en el
   historial y en el filtro "Vistas".
7. Verifica que Revisión PJUD y Programación de salas son independientes:
   marcar una no afecta la fecha ni el estado de la otra.
8. Confirma que todo lo demás sigue funcionando sin cambios: causas,
   Agenda, Centro de Trabajo, Encargo receptor, Administración de
   receptores, turnos importados, Informe Final (incluyendo que aún puedes
   incluir "Resultado o beneficio obtenido" ahí) y Exportar ficha.

## 14. Integración con Google Calendar

Sincronización unidireccional **Agenda de la app → Google Calendar**. La
Agenda interna sigue siendo la fuente principal de información: si Google
Calendar falla, tu evento nunca se pierde de la Agenda. Google Calendar solo
se usa como motor externo de avisos y recordatorios.

Esta integración agrega, por primera vez en el proyecto, una carpeta
`api/` con **Vercel Functions** (backend serverless). Antes de esta
versión, la aplicación era enteramente estática (Vite + Supabase); ahora,
Vercel desplegará automáticamente tanto el sitio estático (`dist/`) como
estas funciones, sin configuración adicional en `vercel.json`.

### 14.1 Orden exacto de despliegue (importante)

1. **Ejecuta primero la migración SQL** (`sql/migration_google_calendar.sql`)
   en el SQL Editor de Supabase.
2. **Configura Google Cloud Console** (sección 14.2) y obtén
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. **Configura las variables de entorno en Vercel** (sección 14.4) —
   incluida `SUPABASE_SERVICE_ROLE_KEY`.
4. **Recién entonces** haz `git push` / despliega en Vercel.
5. En Google Cloud Console, agrega la URL real de tu despliegue de Vercel
   como "Authorized redirect URI" (necesitas conocer el dominio antes de
   este paso — si es tu primer despliegue, despliega una vez, copia el
   dominio que Vercel te asigna, y luego vuelve a Google Cloud Console a
   completar este dato; no es necesario un segundo despliegue, basta con
   guardar el cambio en Google Cloud Console).
6. Prueba conectar Google Calendar desde Integraciones (sección 14.9 trae
   la lista completa de pruebas).

**No hagas Push a producción sin haber completado los pasos 1 a 3.** Sin la
migración, `agenda_eventos` no tiene las columnas nuevas y el backend
fallará; sin las variables de entorno, ninguna función de `api/google/*`
podrá ejecutarse.

### 14.2 Configurar Google Cloud Console (paso a paso)

1. Entra a [console.cloud.google.com](https://console.cloud.google.com) y
   crea un proyecto nuevo, o selecciona uno existente.
2. Ve a **APIs & Services → Library**, busca **Google Calendar API** y
   presiona **Enable**.
3. Ve a **APIs & Services → OAuth consent screen**.
   - Tipo de usuario: **External** (a menos que tengas Google Workspace y
     prefieras Internal).
   - Completa nombre de la app (ej. "Práctica Juris"), correo
     de soporte y correo de contacto del desarrollador.
   - En **Scopes**, no es necesario agregar nada aquí manualmente (los
     scopes se piden en tiempo de ejecución desde el backend); si Google te
     pide agregarlos, usa exactamente estos cuatro:
     - `https://www.googleapis.com/auth/calendar.events` — crear, modificar
       y eliminar eventos.
     - `https://www.googleapis.com/auth/calendar.calendarlist.readonly` —
       listar los calendarios disponibles para que elijas uno.
     - `https://www.googleapis.com/auth/calendar.calendars` — crear el
       calendario secundario opcional "Agenda CAJ" (solo si tú lo
       confirmas explícitamente desde Integraciones).
     - `openid` y `https://www.googleapis.com/auth/userinfo.email` —
       únicamente para identificar qué cuenta de Google quedó conectada
       (mostrar su correo en Integraciones). No dan acceso a Gmail ni a
       ningún otro dato de la cuenta.

     Estos permisos administran exclusivamente calendarios y eventos (más
     el correo de la cuenta, solo para mostrarlo). La aplicación **no**
     solicita acceso a Gmail, Google Drive ni Contactos, y nunca usa el
     scope genérico `calendar` (acceso total) — se pidió deliberadamente el
     conjunto más acotado que permite las tres operaciones que la app
     realmente necesita.
   - Mientras la app esté en modo "Testing", agrega tu cuenta de Gmail (y
     la de cualquier otra postulante) como **Test user** — si no, Google
     rechazará el login.
4. Ve a **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**.
   - Application type: **Web application**.
   - Nombre: el que prefieras (ej. "Práctica Juris Web").
5. **Authorized JavaScript origins**: agrega la URL de tu app, por ejemplo
   `https://caj-lo-prado-civil.vercel.app` (sin barra final). Agrega también
   `http://localhost:5173` si vas a probar con `vercel dev` en local.
6. **Authorized redirect URIs**: agrega exactamente
   `https://caj-lo-prado-civil.vercel.app/api/google/callback`
   (reemplaza el dominio por el real de tu proyecto en Vercel — revisa la
   arquitectura real: la ruta es literalmente el archivo
   `api/google/callback.js` de este proyecto, Vercel la expone en
   `/api/google/callback`). Si usas `vercel dev` en local, agrega también
   `http://localhost:3000/api/google/callback` (o el puerto que uses).
7. Guarda y copia el **Client ID**.
8. Copia también el **Client Secret**.
9. Ve a Vercel y crea las variables de entorno (sección 14.4).
10. Haz **Redeploy** en Vercel después de guardar las variables (Vercel no
    aplica variables de entorno nuevas a un despliegue ya existente sin un
    redeploy).

### 14.3 ¿Por qué existe una carpeta `api/`?

Google exige que el intercambio del código de autorización por tokens, y
toda llamada a la API de Calendar, se haga con el `client_secret` — un
secreto que **nunca** puede vivir en el navegador. Por eso esta integración
agrega funciones serverless en `api/google/*.js`, que Vercel despliega
automáticamente junto al sitio estático. El frontend nunca llama a Google
directamente: solo llama a estas funciones, enviando el token de sesión de
Supabase de la usuaria para que el backend verifique su identidad.

### 14.4 Variables de entorno en Vercel

Ve a **Vercel → tu proyecto → Settings → Environment Variables** y agrega
(marca **Production**, **Preview** y **Development** en cada una, salvo que
tengas un motivo específico para restringir alguna):

| Variable | Valor | Notas |
|---|---|---|
| `SUPABASE_URL` | La misma URL que `VITE_SUPABASE_URL` | Sin prefijo `VITE_`: el backend no puede leer variables `VITE_*` |
| `SUPABASE_ANON_KEY` | La misma que `VITE_SUPABASE_ANON_KEY` | Pública, pero el backend necesita su propia copia |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` | **Secreto crítico.** Nunca la pongas con prefijo `VITE_` |
| `GOOGLE_CLIENT_ID` | De Google Cloud Console | — |
| `GOOGLE_CLIENT_SECRET` | De Google Cloud Console | **Secreto crítico** |
| `GOOGLE_REDIRECT_URI` | `https://TU-APP.vercel.app/api/google/callback` | Debe ser idéntica a la registrada en Google Cloud Console |
| `APP_URL` | `https://TU-APP.vercel.app` | Sin barra final |

Las variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` que ya
configurabas para el frontend **siguen siendo necesarias** — esta tabla es
adicional, no las reemplaza.

**Nunca** incluyas estos valores reales en el `.zip` del proyecto, en
`.env` (solo `.env.example` con placeholders se versiona), ni en GitHub.

### 14.5 Supabase: qué configurar (y qué NO)

**No es necesario tocar Authentication → Providers.** El login de la
aplicación sigue siendo el propio (email/contraseña vía Supabase Auth); no
se reemplaza por "Iniciar sesión con Google". La conexión de Google
Calendar es una integración aparte, exclusivamente para sincronizar la
Agenda, y se gestiona desde **Integraciones** dentro de la app ya
autenticada.

Lo único que debes hacer en Supabase es:
1. Ejecutar la migración (sección 14.1, paso 1).
2. Copiar la **Service Role Key** (Project Settings → API) para usarla como
   variable de entorno en Vercel (nunca en el frontend).

No es necesario modificar **URL Configuration** ni **Redirect URLs** de
Supabase Authentication — esas son para el login de la app, y no participan
en el flujo de Google Calendar (que usa su propio redirect,
`GOOGLE_REDIRECT_URI`, manejado enteramente por `api/google/callback.js`).

### 14.6 Cómo funciona la sincronización

- **Crear/editar un evento en Agenda** → se guarda primero en Supabase (como
  siempre) → si la sincronización automática está activada y hay una cuenta
  conectada, se intenta crear/actualizar el evento en Google Calendar → se
  guarda `google_event_id` y el estado pasa a `synced`. Si Google falla, el
  evento **permanece en la Agenda** con estado `error` y el motivo guardado;
  puedes reintentar con el botón "Reintentar sincronización".
- **Eliminar un evento** → primero se intenta eliminar/cancelar en Google
  Calendar (si tenía `google_event_id`); si eso falla, se avisa con un
  mensaje claro, pero el evento igual se elimina de la Agenda si así lo
  confirmaste.
- **Evento "Realizado"** → no se elimina de Google Calendar; queda como
  registro histórico.
- **Evento "Cancelado"** → se actualiza en Google Calendar con estado
  cancelado.
- **Título del evento en Google**: `TIPO — ROL — CARATULADO` (se omite lo
  que no exista). **Descripción**: ROL, ROL ingreso Corte, caratulado,
  tribunal, materia, tipo de evento, modalidad, observaciones — nunca
  incluye claves ni credenciales.
- **Con hora** → evento con horario en `America/Santiago`; si falta la hora
  de término, se usa una hora de duración. **Sin hora** → evento de día
  completo (nunca se inventa una hora).
- **Recordatorios**: los propios del evento (si se configuraron) → si no,
  los definidos por tipo de evento → si no, los recordatorios
  predeterminados generales (configurables en Integraciones; por defecto
  1 día antes + 1 hora antes).
- **Eventos ya existentes**: nunca se sincronizan automáticamente al
  conectar Google. Desde Integraciones → "Sincronizar eventos existentes"
  puedes ver cuántos hay y su rango de fechas, y elegir sincronizar solo los
  futuros o todos — siempre con tu confirmación explícita.
- **Reintentar pendientes**: en Integraciones, procesa de una vez todos los
  eventos en estado `pending` o `error` de tu cuenta.
- **Desconectar**: elimina la conexión y los tokens guardados; tus eventos
  de Agenda no se tocan, y los eventos ya creados en Google Calendar
  tampoco se eliminan automáticamente (se te avisa esto antes de confirmar).

### 14.7 Programación de salas → Agenda

Cuando una causa en Programación de salas tiene resultado **"En tabla"** y
se registró una **fecha de alegato**, aparece el botón **"Agregar alegato a
Agenda"**. Al usarlo, se crea un evento de Agenda (tipo Audiencia) con la
sala y el número de tabla en la descripción, y sigue la sincronización
normal con Google Calendar. Esto **nunca ocurre automáticamente** — siempre
requiere que presiones el botón.

### 14.8 Archivos nuevos o modificados

- `sql/migration_google_calendar.sql` — **nueva**, migración no destructiva.
- `sql/schema.sql` — actualizado para instalaciones nuevas.
- `api/google/` — **carpeta nueva** (Vercel Functions): `auth-url.js`,
  `callback.js`, `status.js`, `list-calendars.js`, `select-calendar.js`,
  `disconnect.js`, `preferences.js`, `sync-event.js`, `delete-event.js`,
  `sync-pending.js`, `pending-count.js`, y `_lib/` (helpers de Supabase
  admin, cliente OAuth de Google, y construcción del payload del evento).
- `src/lib/api.js` — mapeo de campos `google_*` de `agenda_eventos`;
  funciones cliente para hablar con `api/google/*`.
- `src/app.js` — página Integraciones completa; badges de estado por
  evento; hooks de sincronización en crear/editar/eliminar evento; botón
  "Agregar alegato a Agenda"; manejo del retorno del flujo OAuth.
- `src/style.css` — estilos de Integraciones y de los badges de estado.
- `index.html` — grupo "Configuración" con el ítem "Integraciones".
- `package.json` — agregada la dependencia `googleapis` (uso exclusivo del
  backend; no afecta el tamaño del bundle del frontend — verificado).
- `.env.example` — variables nuevas documentadas.
- `README.md` — esta sección.

### 14.9 Pruebas antes de entregar / antes de hacer Push

**Antes de hacer Push a producción**, verifica que completaste: migración
SQL ejecutada, credenciales de Google Cloud Console creadas, las 7
variables de entorno configuradas en Vercel (Production + Preview +
Development), y el redirect URI en Google Cloud Console coincide
exactamente con `GOOGLE_REDIRECT_URI`.

Después de desplegar, probar:

1. **Conexión**: Integraciones → Conectar → aceptar permisos en Google →
   confirmar que vuelve a la app y muestra "Conectado" con la cuenta
   correcta.
2. **Elegir calendario**: listar calendarios, seleccionar uno existente, y
   probar también "Crear calendario Agenda CAJ".
3. **Crear evento**: crear un evento con hora en Agenda → verificar en
   Google Calendar: título, fecha, hora, zona horaria (América/Santiago),
   descripción, recordatorios, y que `google_event_id` quedó guardado.
4. **Actualizar**: cambiar la hora del mismo evento → confirmar que se
   actualiza el mismo evento en Google (no aparece uno duplicado).
5. **Eliminar**: eliminar el evento → confirmar que se cancela/elimina en
   Google Calendar.
6. **Error simulado**: desconecta tu internet o revoca el acceso desde
   [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
   y crea un evento → confirma que el evento se guarda igual en la Agenda
   con estado "Error", y que "Reintentar sincronización" funciona al
   restaurar el acceso.
7. **Renovación de token**: no es fácil de forzar manualmente (los access
   tokens de Google duran ~1 hora); el mecanismo ya renueva automáticamente
   en cada sincronización usando el refresh token — puedes verificarlo
   revisando que `token_expiry` se actualiza en la tabla
   `google_calendar_conexiones` después de varias sincronizaciones
   separadas por más de una hora.
8. **Evento de día completo**: crear un evento sin hora → confirmar que
   aparece como "todo el día" en Google Calendar.
9. **Eventos antiguos**: confirmar que, al conectar por primera vez, tus
   eventos ya existentes **no** se sincronizan solos — deben aparecer en
   "Sincronizar eventos existentes" esperando tu confirmación.
10. **Compatibilidad**: confirmar que causas, Antecedentes, Resumen,
    Gestiones, Revisión PJUD, Programación de salas, Centro de Trabajo,
    Encargo receptor, Administración de receptores, turnos, Informe Final,
    Exportar ficha y Google Drive siguen funcionando exactamente igual que
    antes.

## 15. Notas importantes

- Los documentos (demandas, escritos, resoluciones, oficios, etc.) no se
  suben a esta aplicación: se guardan en la carpeta de Google Drive vinculada
  a cada causa. Supabase solo almacena el enlace.
- No hay credenciales de Supabase escritas en el código; todo viene de las
  variables de entorno `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.
- La integración con Google Calendar **no está implementada todavía**
  (quedará para una versión posterior): no hay OAuth, tokens ni Edge
  Functions de Google en este proyecto.
- Si pierdes acceso a tu cuenta, usa "¿Olvidaste tu contraseña?" en la
  pantalla de inicio de sesión.
