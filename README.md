# SQX Analyzer v3 — Web App

Herramienta profesional de análisis de WF Matrix para StrategyQuant.
**100% procesamiento local** — los archivos .sqx nunca salen de tu navegador.

## Deploy en Vercel (5 minutos)

### 1. Subir a GitHub

```bash
# En la carpeta sqx-web:
git init
git add .
git commit -m "SQX Analyzer v3"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/sqx-analyzer.git
git push -u origin main
```

O más fácil: ve a github.com → New repository → arrastra esta carpeta.

### 2. Conectar con Vercel

1. Ve a [vercel.com](https://vercel.com) → Log in with GitHub
2. Click **"Add New Project"**
3. Selecciona el repositorio `sqx-analyzer`
4. Click **Deploy** (sin cambiar nada)
5. En 30 segundos tienes tu URL: `sqx-analyzer.vercel.app`

### 3. Dominio personalizado (opcional)

En el dashboard de Vercel → Settings → Domains → añade tu dominio.

## Actualizar

Cada vez que hagas push a GitHub, Vercel redespliega automáticamente:

```bash
git add .
git commit -m "Actualización"
git push
```

## Estructura

```
sqx-web/
├── index.html      # Interfaz completa
├── analyzer.js     # Toda la lógica de análisis
├── web-adapter.js  # Adaptador web (drag&drop, PDF)
├── vercel.json     # Configuración de deploy
└── README.md
```

## Privacidad

- Los `.sqx` se procesan en el navegador del usuario
- Ningún archivo se sube a ningún servidor
- Sin cookies, sin tracking, sin analytics
- Código fuente 100% visible y auditable

## Funcionalidades

- ✅ Análisis de WF Matrix completo
- ✅ RetDD Full (IS+OOS) — valor exacto del Overview de SQ
- ✅ Regla de zona 2×2 para selección del run central
- ✅ Risk flags automáticos (8 controles de calidad)
- ✅ Idoneidad: Capital propio / Prop Firm / Darwin
- ✅ Comparación de hasta 3 estrategias
- ✅ Pesos del scoring personalizables
- ✅ Heatmap interactivo
- ✅ Exportar a PDF (Ctrl+P)
- ✅ Drag & drop de archivos
- ✅ Funciona en cualquier navegador y dispositivo
