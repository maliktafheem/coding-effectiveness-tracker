import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './routes.js';


export interface ServerOptions {
  dataDir: string;
  port?: number;
  host?: string;
}

export interface DashboardServer {
  address(): { address: string; port: number } | null;
  close(): Promise<void>;
  inject(opts: { method: string; url: string; payload?: unknown; headers?: Record<string,string> }): Promise<{ statusCode: number; payload: string; headers: Record<string,string> }>;
}

/**
 * Create the local API server for the dashboard.
 * Binds ONLY to 127.0.0.1 (loopback) for privacy.
 */
export async function createApiServer(opts: ServerOptions): Promise<DashboardServer & { listen: () => Promise<void> }> {
  const port = opts.port ?? 43187;
  const host = opts.host ?? '127.0.0.1';

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('Dashboard API must bind to loopback only (127.0.0.1). Refusing to bind to ' + host);
  }

  const app = Fastify({
    logger: false,
    trustProxy: false,
  });

  // Consistent JSON error handler for all unhandled errors
  app.setErrorHandler(async (error, _request, reply) => {
    const err = error as { statusCode?: number; message?: string };
    const statusCode = err.statusCode ?? 500;
    if (statusCode === 500) {
      console.error('Unhandled error:', error);
    }
    const message = statusCode === 500 ? 'Internal server error' : (err.message ?? 'Unknown error');
    return reply.code(statusCode).send({ error: 'Internal server error', message });
  });

  // Cross-origin protection middleware
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      const allowed = [
        'http://127.0.0.1:' + port,
        'http://localhost:' + port,
        'http://[::1]:' + port,
      ];
      if (!allowed.includes(origin)) {
        // Block cross-origin writes (POST, PUT, PATCH, DELETE)
        const method = request.method.toUpperCase();
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          reply.code(403).send({ error: 'Cross-origin write rejected' });
          return;
        }
      }
    }
  });

  registerRoutes(app, opts);

  // Serve built dashboard assets if available (VAL-SEC-002: all local)
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const distDir = join(currentDir, '..', '..', 'dist', 'dashboard');
  if (existsSync(distDir)) {
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      
    });
    app.setNotFoundHandler(async (request, reply) => {
      // Return JSON error for unmatched API routes (404) instead of SPA fallback
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found', message: 'API endpoint not found or method not allowed' });
      }
      return reply.sendFile('index.html');
    });
  }

  return {
    async listen() {
      await app.listen({ port, host });
    },
    address() {
      const addr = app.server.address();
      if (typeof addr === 'string') return { address: addr, port: 0 };
      return addr ? { address: addr.address, port: addr.port } : null;
    },
    async close() {
      await app.close();
    },
    async inject(request) {
      const res = await app.inject({
        method: request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS',
        url: request.url,
        payload: request.payload as string | undefined,
        headers: request.headers as Record<string, string>,
      });
      return {
        statusCode: res.statusCode,
        payload: res.payload.toString(),
        headers: res.headers as Record<string, string>,
      };
    },
  };
}



