# Mis Apuestas

Control personal de apuestas deportivas: registro de apuestas simples y parlays, cálculo automático de retorno y resultado neto, dashboard con ROI, % de aciertos y gráficos, historial con filtros y respaldo en CSV.

Hecho con HTML, CSS y JavaScript, empaquetado con Vite. Usa Chart.js para los gráficos y **Supabase** como base de datos e inicio de sesión.

---

## 1. Crear la base de datos en Supabase

1. Entra a https://supabase.com y crea un proyecto (o usa uno que ya tengas).
2. Ve a **SQL Editor → New query**, pega todo el contenido de `supabase/schema.sql` y presiona **Run**.
   Esto crea:
   - `bets`: tus apuestas (monto y cash out guardados en centavos para que no haya errores de redondeo).
   - `user_settings`: tu moneda (MXN o USD).
   - Reglas de seguridad (RLS) para que cada usuario solo pueda ver y modificar sus propias apuestas.
   - Tiempo real, para que lo que registres en el celular aparezca al instante en la computadora.
3. Ve a **Authentication → Sign In / Providers → Email**:
   - Para una app personal, lo más cómodo es **desactivar "Confirm email"**, así entras en cuanto creas tu cuenta.
   - Si la dejas activa, al crear tu cuenta te llega un correo de confirmación. En **Authentication → URL Configuration** agrega la URL de tu app (la de StackBlitz o Vercel) en **Site URL** y **Redirect URLs** para que el enlace te regrese a la app.
4. Ve a **Project Settings → API** y copia:
   - **Project URL**
   - **anon public key**

## 2. Configurar la app

Crea un archivo `.env` en la raíz del proyecto (puedes copiar `.env.example`):

```
VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_ANON_KEY=tu-anon-public-key
```

La anon key es pública por diseño: la seguridad la dan las reglas RLS. **Nunca** pongas la `service_role` key en la app.

Si no hay `.env`, la app funciona igual pero guarda todo solo en el navegador.

## 3. Ejecutar en StackBlitz

1. En https://stackblitz.com crea un proyecto con la plantilla **Vite → Vanilla (JavaScript)**.
2. Borra los archivos de ejemplo y arrastra el contenido de esta carpeta (sin `node_modules`).
3. Crea el archivo `.env` con tus datos (paso 2).
4. Si no arranca solo, en la terminal: `npm install` y luego `npm run dev`. Si agregaste el `.env` con la app ya corriendo, reinicia con `npm run dev`.

## Ejecutar en tu computadora

Necesitas Node.js 18 o más reciente.

```bash
npm install
npm run dev       # desarrollo
npm run build     # producción en /dist
npm run preview   # probar la versión de producción
```

## Publicar en Vercel

1. Sube el proyecto a GitHub (el `.env` no se sube; está en `.gitignore`).
2. En Vercel importa el repositorio. Build: `npm run build`. Carpeta de salida: `dist`.
3. En **Settings → Environment Variables** agrega `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` y vuelve a desplegar.
4. Agrega la URL de Vercel en Supabase → Authentication → URL Configuration.

## Cómo se guardan los datos

- Al entrar con tu cuenta, tus apuestas se leen y se guardan en Supabase. Cada alta, edición, cambio de estado o borrado se escribe al momento.
- La app guarda una copia en el navegador para mostrarte tus datos rápido al abrirla; la fuente de verdad es Supabase.
- Si ya tenías apuestas guardadas solo en el navegador, al iniciar sesión la app te ofrece subirlas a tu cuenta (sin duplicar las que ya existan).
- Los datos de demostración nunca se suben: viven aparte, solo en el navegador.
- **Pasar tus apuestas desde la versión de Claude:** en la app de Claude ve a Historial → Exportar CSV, y en esta versión Historial → Importar CSV.

## Estructura

```
index.html              Estructura de la página y navegación
src/main.js             Lógica: cálculos, vistas, filtros, CSV, gráficos, sincronización
src/supabase.js         Cliente de Supabase (lee las variables del .env)
src/style.css           Estilos (tema oscuro, responsive)
src/data/schedule.json  Calendario de partidos incluido (cargado el 1 oct 2026)
supabase/schema.sql     Tablas, reglas de seguridad y tiempo real
.env.example            Plantilla de variables
```

Los cálculos de dinero están en el bloque `CALC-START` / `CALC-END` de `src/main.js` y trabajan en centavos enteros. En **Configuración** hay una tabla que verifica las fórmulas en vivo.
