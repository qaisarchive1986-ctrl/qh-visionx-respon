const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const argon2 = require("argon2");
const { Pool } = require("pg");
const { createClient } = require("redis");
const { WebSocketServer } = require("ws");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_SECRET";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "*";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const redis = createClient({
  url: process.env.REDIS_URL || "redis://redis:6379",
});

redis.on("error", (err) => {
  console.error("Redis error:", err.message);
});

app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(
  cors({
    origin: PUBLIC_ORIGIN === "*" ? true : PUBLIC_ORIGIN,
  })
);

app.use(express.json({ limit: "1mb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function authenticate(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const token = header.substring(7);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: "Insufficient permissions",
      });
    }

    next();
  };
}

async function audit(userId, action, details = {}) {
  try {
    await pool.query(
      `
      INSERT INTO audit_logs (user_id, action, details)
      VALUES ($1, $2, $3)
      `,
      [userId || null, action, JSON.stringify(details)]
    );
  } catch (error) {
    console.error("Audit error:", error.message);
  }
}

app.get("/api/health", async (req, res) => {
  let database = "down";
  let redisStatus = "down";

  try {
    await pool.query("SELECT 1");
    database = "up";
  } catch (error) {
    console.error("Database health error:", error.message);
  }

  try {
    if (!redis.isOpen) {
      await redis.connect();
    }

    await redis.ping();
    redisStatus = "up";
  } catch (error) {
    console.error("Redis health error:", error.message);
  }

  const healthy = database === "up" && redisStatus === "up";

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "QH VisionX Response API",
    database,
    redis: redisStatus,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required",
      });
    }

    const result = await pool.query(
      `
      SELECT id, username, password_hash, full_name, role, active
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [username.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid credentials",
      });
    }

    const user = result.rows[0];

    if (!user.active) {
      return res.status(403).json({
        error: "User account is disabled",
      });
    }

    const validPassword = await argon2.verify(
      user.password_hash,
      password
    );

    if (!validPassword) {
      await audit(null, "login_failed", {
        username: username.trim(),
      });

      return res.status(401).json({
        error: "Invalid credentials",
      });
    }

    const token = jwt.sign(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        fullName: user.full_name,
      },
      JWT_SECRET,
      {
        expiresIn: "8h",
      }
    );

    await audit(user.id, "login_success");

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
      },
      expiresIn: 8 * 60 * 60,
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      error: "Login service unavailable",
    });
  }
});

app.get("/api/auth/me", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, username, full_name, role, active, created_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [req.user.sub]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Me error:", error.message);

    res.status(500).json({
      error: "Unable to load user",
    });
  }
});

app.get("/api/incidents", authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        title,
        description,
        severity,
        status,
        latitude,
        longitude,
        created_by,
        created_at,
        updated_at
      FROM incidents
      ORDER BY created_at DESC
      LIMIT 200
    `);

    res.json({
      incidents: result.rows,
    });
  } catch (error) {
    console.error("Incidents error:", error.message);

    res.status(500).json({
      error: "Unable to load incidents",
    });
  }
});

app.post(
  "/api/incidents",
  authenticate,
  async (req, res) => {
    try {
      const {
        title,
        description = "",
        severity = "medium",
        latitude,
        longitude,
      } = req.body || {};

      if (!title) {
        return res.status(400).json({
          error: "Incident title is required",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO incidents
        (
          title,
          description,
          severity,
          status,
          latitude,
          longitude,
          created_by
        )
        VALUES
        (
          $1,
          $2,
          $3,
          'open',
          $4,
          $5,
          $6
        )
        RETURNING *
        `,
        [
          title,
          description,
          severity,
          latitude ?? null,
          longitude ?? null,
          req.user.sub,
        ]
      );

      const incident = result.rows[0];

      await audit(req.user.sub, "incident_created", {
        incidentId: incident.id,
      });

      broadcast({
        type: "incident.created",
        data: incident,
      });

      res.status(201).json({
        incident,
      });
    } catch (error) {
      console.error("Create incident error:", error.message);

      res.status(500).json({
        error: "Unable to create incident",
      });
    }
  }
);

app.patch(
  "/api/incidents/:id",
  authenticate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, severity, description } = req.body || {};

      const result = await pool.query(
        `
        UPDATE incidents
        SET
          status = COALESCE($1, status),
          severity = COALESCE($2, severity),
          description = COALESCE($3, description),
          updated_at = NOW()
        WHERE id = $4
        RETURNING *
        `,
        [
          status ?? null,
          severity ?? null,
          description ?? null,
          id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Incident not found",
        });
      }

      const incident = result.rows[0];

      await audit(req.user.sub, "incident_updated", {
        incidentId: incident.id,
      });

      broadcast({
        type: "incident.updated",
        data: incident,
      });

      res.json({
        incident,
      });
    } catch (error) {
      console.error("Update incident error:", error.message);

      res.status(500).json({
        error: "Unable to update incident",
      });
    }
  }
);

app.get("/api/teams", authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        status,
        description,
        created_at
      FROM teams
      ORDER BY name ASC
    `);

    res.json({
      teams: result.rows,
    });
  } catch (error) {
    console.error("Teams error:", error.message);

    res.status(500).json({
      error: "Unable to load teams",
    });
  }
});

app.post(
  "/api/locations",
  authenticate,
  async (req, res) => {
    try {
      const {
        latitude,
        longitude,
        accuracy,
        altitude,
        speed,
        heading,
      } = req.body || {};

      if (
        typeof latitude !== "number" ||
        typeof longitude !== "number"
      ) {
        return res.status(400).json({
          error: "Valid latitude and longitude are required",
        });
      }

      if (
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return res.status(400).json({
          error: "Invalid coordinates",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO locations
        (
          user_id,
          latitude,
          longitude,
          accuracy,
          altitude,
          speed,
          heading
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )
        RETURNING *
        `,
        [
          req.user.sub,
          latitude,
          longitude,
          accuracy ?? null,
          altitude ?? null,
          speed ?? null,
          heading ?? null,
        ]
      );

      const location = result.rows[0];

      broadcast({
        type: "location.updated",
        data: location,
      });

      res.status(201).json({
        location,
      });
    } catch (error) {
      console.error("Location error:", error.message);

      res.status(500).json({
        error: "Unable to save location",
      });
    }
  }
);

app.get(
  "/api/locations/latest",
  authenticate,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT DISTINCT ON (user_id)
          id,
          user_id,
          latitude,
          longitude,
          accuracy,
          altitude,
          speed,
          heading,
          recorded_at
        FROM locations
        ORDER BY user_id, recorded_at DESC
      `);

      res.json({
        locations: result.rows,
      });
    } catch (error) {
      console.error("Latest locations error:", error.message);

      res.status(500).json({
        error: "Unable to load locations",
      });
    }
  }
);

app.get("/api/admin/stats", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const [users, incidents, teams] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM users"),
      pool.query("SELECT COUNT(*)::int AS count FROM incidents"),
      pool.query("SELECT COUNT(*)::int AS count FROM teams"),
    ]);

    res.json({
      users: users.rows[0].count,
      incidents: incidents.rows[0].count,
      teams: teams.rows[0].count,
    });
  } catch (error) {
    console.error("Admin stats error:", error.message);

    res.status(500).json({
      error: "Unable to load admin statistics",
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "API route not found",
    path: req.path,
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);

  res.status(500).json({
    error: "Internal server error",
  });
});

const server = app.listen(PORT, () => {
  console.log(
    `QH VisionX Response API running on port ${PORT}`
  );
});

const wss = new WebSocketServer({
  noServer: true,
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "connected",
      service: "QH VisionX Response",
      timestamp: new Date().toISOString(),
    })
  );
});

function broadcast(message) {
  const payload = JSON.stringify(message);

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);

  try {
    await pool.end();

    if (redis.isOpen) {
      await redis.quit();
    }

    server.close(() => {
      process.exit(0);
    });
  } catch (error) {
    console.error("Shutdown error:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
