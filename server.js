const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secreto_seguro_para_firmar_tokens';

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
} else {
  console.warn('⚠️ ADVERTENCIA: Supabase URL o Anon Key no están definidos. El login con Google no funcionará hasta que se configuren.');
}

// Configuración de PostgreSQL (Pool de conexiones)
const dbUrl = process.env.DATABASE_URL;
let pool = null;

if (dbUrl) {
  pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false } // Requerido para Supabase y Railway
  });
} else {
  console.error('❌ ERROR CRÍTICO: La variable DATABASE_URL de PostgreSQL no está definida en el .env');
  process.exit(1);
}

// Inicializar tablas en base de datos si no existen al arrancar
async function initDb() {
  const client = await pool.connect();
  try {
    // Tabla Users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        role VARCHAR(50) DEFAULT 'Usuario' NOT NULL CHECK (role IN ('Admin', 'Usuario')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabla Active Sessions (Sesión Única)
    await client.query(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        session_token VARCHAR(255) UNIQUE NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Base de datos PostgreSQL inicializada con éxito.');
  } catch (err) {
    console.error('❌ Error al inicializar la base de datos:', err);
  } finally {
    client.release();
  }
}

initDb();

// Middlewares
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public')); // Servir archivos estáticos del frontend

// Middleware para verificar autenticación y verificar Sesión Única
async function authenticateToken(req, res, next) {
  const token = req.cookies.session_token;

  if (!token) {
    return res.status(401).json({ error: 'No autenticado. Por favor inicia sesión.' });
  }

  try {
    // Descodificar token firmado
    const decoded = jwt.verify(token, SESSION_SECRET);
    
    // Verificar en la DB si esta sesión específica sigue activa y válida
    const sessionRes = await pool.query(
      'SELECT s.*, u.email, u.role FROM active_sessions s JOIN users u ON s.user_id = u.id WHERE s.session_token = $1',
      [token]
    );

    if (sessionRes.rows.length === 0) {
      // La sesión fue eliminada en base de datos (por ejemplo, cerrada por inicio simultáneo)
      res.clearCookie('session_token');
      return res.status(401).json({ 
        error: 'Sesión invalidada.', 
        code: 'SESSION_INVALIDATED', 
        message: 'Tu sesión ha sido cerrada debido a que se inició sesión en otro navegador.' 
      });
    }

    req.user = {
      id: decoded.userId,
      email: sessionRes.rows[0].email,
      role: sessionRes.rows[0].role,
      token: token
    };

    next();
  } catch (err) {
    res.clearCookie('session_token');
    return res.status(401).json({ error: 'Sesión expirada o inválida.' });
  }
}

// Middleware para autorizar roles
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Acceso denegado. Se requiere rol de ${role}.` });
    }
    next();
  };
}

// --- ENDPOINTS DE AUTENTICACIÓN ---

// 1. Registro de Usuario Local (con contraseña encriptada)
app.post('/api/auth/register', async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son obligatorios.' });
  }

  try {
    // Comprobar si el usuario existe
    const userExist = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExist.rows.length > 0) {
      return res.status(400).json({ error: 'El email ya está registrado.' });
    }

    // Encriptar contraseña
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Asignar rol (por defecto 'Usuario', a menos que se defina)
    const finalRole = (role === 'Admin' || role === 'Usuario') ? role : 'Usuario';

    // Insertar en la DB
    const newUser = await pool.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email.toLowerCase(), passwordHash, finalRole]
    );

    res.status(201).json({
      message: 'Usuario registrado con éxito.',
      user: newUser.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al registrar usuario.' });
  }
});

// Helper para crear una nueva sesión activa en DB y generar cookie JWT
async function createSession(userId, email, role, req, res) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const userAgent = req.headers['user-agent'] || 'Desconocido';

  // Generar token JWT firmado
  const token = jwt.sign({ userId, email, role }, SESSION_SECRET, { expiresIn: '24h' });

  // Guardar sesión activa en base de datos
  await pool.query(
    'INSERT INTO active_sessions (user_id, session_token, ip_address, user_agent) VALUES ($1, $2, $3, $4)',
    [userId, token, ip, userAgent]
  );

  // Guardar en cookie segura
  res.cookie('session_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 horas
  });

  return token;
}

// 2. Login Local (con control de sesión única)
app.post('/api/auth/login', async (req, res) => {
  const { email, password, force } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son obligatorios.' });
  }

  try {
    // Buscar usuario en base de datos
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const user = userRes.rows[0];

    // Verificar si es un usuario que solo se loguea con Google (no tiene hash de contraseña)
    if (!user.password_hash) {
      return res.status(400).json({ error: 'Este usuario se autentica con Google. Por favor, usa el inicio de sesión de Google.' });
    }

    // Verificar contraseña encriptada
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // --- LÓGICA DE CONTROL DE SESIÓN ÚNICA ---
    const existingSessions = await pool.query(
      'SELECT * FROM active_sessions WHERE user_id = $1',
      [user.id]
    );

    if (existingSessions.rows.length > 0) {
      // Existe una sesión previa activa en otro navegador
      if (!force) {
        // Enviar advertencia con código 409 Conflict
        const oldSession = existingSessions.rows[0];
        return res.status(409).json({
          code: 'SESSION_EXISTS',
          message: 'Existe otra sesión activa en este momento.',
          details: {
            ip: oldSession.ip_address,
            userAgent: oldSession.user_agent,
            createdAt: oldSession.created_at
          }
        });
      } else {
        // Cierre forzado: invalidar todas las sesiones anteriores
        await pool.query('DELETE FROM active_sessions WHERE user_id = $1', [user.id]);
        console.log(`🧹 Sesiones anteriores revocadas para el usuario ${user.email}`);
      }
    }

    // Crear la nueva sesión
    const token = await createSession(user.id, user.email, user.role, req, res);

    res.json({
      message: 'Inicio de sesión exitoso.',
      user: { id: user.id, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor en el login.' });
  }
});

// 3. Login con Google (Integración de JWT de Supabase Auth)
app.post('/api/auth/google-login', async (req, res) => {
  const { access_token, force } = req.body;

  if (!access_token) {
    return res.status(400).json({ error: 'El access token de Supabase es requerido.' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase no está configurado en el servidor.' });
  }

  try {
    // Validar el JWT de Supabase utilizando la API de Supabase Auth
    const { data: { user: supabaseUser }, error } = await supabase.auth.getUser(access_token);

    if (error || !supabaseUser) {
      return res.status(401).json({ error: 'Token de Google/Supabase inválido o expirado.' });
    }

    const email = supabaseUser.email;

    // Verificar si el usuario ya existe en nuestra base de datos PostgreSQL
    let userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    let user;

    if (userRes.rows.length === 0) {
      // Registrar automáticamente al usuario de Google con el rol por defecto
      const newUser = await pool.query(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, NULL, $2) RETURNING *',
        [email.toLowerCase(), 'Usuario']
      );
      user = newUser.rows[0];
      console.log(`🆕 Usuario registrado mediante Google: ${email}`);
    } else {
      user = userRes.rows[0];
    }

    // --- LÓGICA DE CONTROL DE SESIÓN ÚNICA PARA GOOGLE AUTH ---
    const existingSessions = await pool.query(
      'SELECT * FROM active_sessions WHERE user_id = $1',
      [user.id]
    );

    if (existingSessions.rows.length > 0) {
      if (!force) {
        const oldSession = existingSessions.rows[0];
        return res.status(409).json({
          code: 'SESSION_EXISTS',
          message: 'Existe otra sesión activa en este momento.',
          details: {
            ip: oldSession.ip_address,
            userAgent: oldSession.user_agent,
            createdAt: oldSession.created_at
          }
        });
      } else {
        await pool.query('DELETE FROM active_sessions WHERE user_id = $1', [user.id]);
        console.log(`🧹 Sesiones anteriores de Google revocadas para el usuario ${user.email}`);
      }
    }

    // Crear la sesión en Express y poner la cookie
    await createSession(user.id, user.email, user.role, req, res);

    res.json({
      message: 'Inicio de sesión con Google exitoso.',
      user: { id: user.id, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al autenticar con Google.' });
  }
});

// 4. Obtener Información de la Sesión Actual (Verificación de Sesión Única constante)
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// 5. Cerrar Sesión (Logout)
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    // Eliminar sesión activa de la DB
    await pool.query('DELETE FROM active_sessions WHERE session_token = $1', [req.user.token]);
    res.clearCookie('session_token');
    res.json({ message: 'Sesión cerrada con éxito.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al cerrar sesión.' });
  }
});

// --- ENDPOINTS ADMINISTRATIVOS (PROTEGIDOS POR ROL ADMIN) ---

// 1. Listar Usuarios y Roles
app.get('/api/admin/users', authenticateToken, requireRole('Admin'), async (req, res) => {
  try {
    const usersRes = await pool.query(
      'SELECT id, email, role, created_at FROM users ORDER BY id ASC'
    );
    res.json({ users: usersRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar usuarios.' });
  }
});

// 2. Modificar Rol de Usuario
app.post('/api/admin/assign-role', authenticateToken, requireRole('Admin'), async (req, res) => {
  const { userId, role } = req.body;

  if (!userId || !role) {
    return res.status(400).json({ error: 'El ID de usuario y el rol son obligatorios.' });
  }

  if (role !== 'Admin' && role !== 'Usuario') {
    return res.status(400).json({ error: 'Rol inválido. Debe ser Admin o Usuario.' });
  }

  try {
    const userExist = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userExist.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);

    // Opcional: Cerrar sesión del usuario al cambiarle de rol para que se reautentique
    await pool.query('DELETE FROM active_sessions WHERE user_id = $1', [userId]);

    res.json({ message: `Rol del usuario actualizado a ${role} con éxito.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al modificar rol.' });
  }
});

// Redirigir cualquier ruta no coincidente al frontend principal (index.html)
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de Ciberseguridad corriendo en http://localhost:${PORT}`);
});
