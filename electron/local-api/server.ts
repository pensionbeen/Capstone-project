import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { AIReply } from '../../shared/ai.js';
import type { ApiResult, SessionEvent, SessionRead } from '../../shared/local-api.js';
import type { RequirementsAction } from '../../shared/requirements.js';
import type { ProjectCatalog } from '../../shared/storage.js';
import { UUID } from '../ai/contracts.js';
import type { SessionManager } from '../ai/session-manager.js';

const uuidSchema = { type: 'string', pattern: UUID.source };
const nullableId = { anyOf: [uuidSchema, { type: 'null' }] };
function objectSchema(properties: Record<string, object>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const paramsSchema = objectSchema({ id: uuidSchema });

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface LocalEndpoint {
  baseUrl: string;
  token: string;
  origin: string;
}

export type SessionBackend = Pick<
  SessionManager,
  | 'listProjects'
  | 'hasProject'
  | 'read'
  | 'availabilityStatus'
  | 'submit'
  | 'requirements'
  | 'stop'
  | 'reset'
  | 'resize'
>;
export async function startLocalApi(
  manager: SessionBackend,
  origin: string,
  catalog?: () => ProjectCatalog,
) {
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let closing = false;
  let requestWindow = 0;
  let requests = 0;
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024,
    requestTimeout: 5000,
    connectionTimeout: 10000,
    keepAliveTimeout: 1000,
    forceCloseConnections: true,
    exposeHeadRoutes: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
    genReqId: (request) => {
      const id = request.headers['x-request-id'];
      return typeof id === 'string' && UUID.test(id) ? id : randomUUID();
    },
  });
  app.server.maxConnections = 32;
  app.server.headersTimeout = 5000;
  app.server.maxHeadersCount = 32;
  const sockets = new Set<WebSocket>();
  // Register upgrade bookkeeping before authentication can reject a handshake.
  await app.register(websocket, {
    options: { maxPayload: 4096, perMessageDeflate: false },
    preClose(done) {
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(done);
    },
  });
  const cache = new Map<
    string,
    { fingerprint: string; expires: number; result: Promise<AIReply> }
  >();

  function result<T>(request: FastifyRequest, data: T): ApiResult<T> {
    return { schemaVersion: 1, requestId: request.id, data };
  }
  function failure(requestId: string, error: ApiError): ApiResult<never> {
    return {
      schemaVersion: 1,
      requestId,
      error: { code: error.code, message: error.message, retryable: error.retryable, requestId },
    };
  }
  function project(id: string) {
    if (!manager.hasProject(id))
      throw new ApiError(404, 'PROJECT_NOT_FOUND', '프로젝트 폴더를 다시 선택해 주세요.');
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const address = app.server.address();
    if (
      !address ||
      typeof address === 'string' ||
      request.headers.host !== `127.0.0.1:${address.port}` ||
      request.headers.origin !== origin ||
      request.headers['x-forwarded-host'] !== undefined ||
      request.headers['x-forwarded-for'] !== undefined ||
      request.headers.forwarded !== undefined
    )
      throw new ApiError(403, 'UNTRUSTED_SOURCE', '허용되지 않은 연결이에요.');
    for (const name of ['host', 'origin', 'authorization', 'x-request-id', 'x-request-time']) {
      let count = 0;
      for (let i = 0; i < request.raw.rawHeaders.length; i += 2)
        if (request.raw.rawHeaders[i]?.toLowerCase() === name) count++;
      if (count > 1) throw new ApiError(400, 'INVALID_REQUEST', '요청 형식을 확인해 주세요.');
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expectedAuth.length || !timingSafeEqual(supplied, expectedAuth))
      throw new ApiError(401, 'UNAUTHORIZED', '앱 연결 인증을 확인할 수 없어요.');
    const now = Date.now();
    if (now - requestWindow >= 1000) {
      requestWindow = now;
      requests = 0;
    }
    if (++requests > 100)
      throw new ApiError(
        429,
        'RATE_LIMIT',
        '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
        true,
      );
    if (closing && request.method === 'POST')
      throw new ApiError(503, 'CLOSING', '앱 실행을 정리하고 있어요.');
    if (
      !UUID.test(String(request.headers['x-request-id'] ?? '')) ||
      request.url.includes('?') ||
      !request.url.startsWith('/')
    )
      throw new ApiError(400, 'INVALID_REQUEST', '요청 형식을 확인해 주세요.');
    if (request.method === 'POST' && request.headers['content-type'] !== 'application/json')
      throw new ApiError(415, 'INVALID_CONTENT_TYPE', 'JSON 형식으로 요청해 주세요.');
  });
  app.setErrorHandler((error, request, reply) => {
    const code = (error as { code?: string }).code;
    const known =
      error instanceof ApiError
        ? error
        : code === 'FST_ERR_CTP_BODY_TOO_LARGE'
          ? new ApiError(413, 'INPUT_TOO_LARGE', '입력 크기 한도를 넘었어요.')
          : (error as { statusCode?: number }).statusCode === 400
            ? new ApiError(400, 'INVALID_REQUEST', '요청 형식을 확인해 주세요.')
            : new ApiError(
                500,
                'INTERNAL_ERROR',
                '요청을 처리하지 못했어요. 실행 상태를 확인해 주세요.',
              );
    void reply.code(known.status).send(failure(request.id, known));
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(failure(request.id, new ApiError(404, 'NOT_FOUND', '요청한 기능을 찾지 못했어요.'))),
  );
  app.get('/v1/projects', async (request) =>
    result(
      request,
      catalog
        ? catalog()
        : { projects: manager.listProjects(), storage: 'memory', activeProjectId: null },
    ),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/projects/:id',
    { schema: { params: paramsSchema } },
    async (request) => {
      project(request.params.id);
      return result(
        request,
        manager.listProjects().find((item) => item.id === request.params.id),
      );
    },
  );
  app.get('/v1/ai/availability', async (request) =>
    result(request, await manager.availabilityStatus()),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/projects/:id/session',
    { schema: { params: paramsSchema } },
    async (request) => {
      project(request.params.id);
      return result(request, manager.read(request.params.id, 0));
    },
  );
  app.get<{ Params: { id: string } }>(
    '/v1/projects/:id/session/status',
    { schema: { params: paramsSchema } },
    async (request) => {
      project(request.params.id);
      return result(request, manager.read(request.params.id, Number.MAX_SAFE_INTEGER));
    },
  );

  async function mutate(request: FastifyRequest, reply: FastifyReply, action: () => AIReply) {
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expires < now) cache.delete(id);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          request.method,
          request.url,
          request.headers['x-request-time'],
          request.body,
        ]),
      )
      .digest('hex');
    let entry = cache.get(request.id);
    if (entry && entry.fingerprint !== fingerprint)
      throw new ApiError(409, 'REQUEST_CONFLICT', '같은 요청 번호로 다른 내용을 보낼 수 없어요.');
    if (!entry) {
      const issued = Number(request.headers['x-request-time']);
      if (!Number.isSafeInteger(issued) || issued < now - 60000 || issued > now + 5000)
        throw new ApiError(
          409,
          'REQUEST_EXPIRED',
          '오래된 요청이에요. 현재 상태를 다시 확인해 주세요.',
        );
      if (cache.size >= 2048)
        throw new ApiError(
          429,
          'REQUEST_LIMIT',
          '요청 보관 한도에 도달했어요. 잠시 후 다시 시도해 주세요.',
          true,
        );
      // Register before execution: concurrent copies share even an in-flight result.
      entry = { fingerprint, expires: now + 120000, result: Promise.resolve().then(action) };
      cache.set(request.id, entry);
    }
    const data = await entry.result;
    if (!data.ok)
      throw new ApiError(409, 'SESSION_CONFLICT', data.message ?? '실행 상태를 확인해 주세요.');
    return reply.send(result(request, data));
  }
  const bodies = {
    submit: objectSchema({
      prompt: { type: 'string', minLength: 1, maxLength: 8000 },
      expectedOutputId: nullableId,
      expectedRunId: nullableId,
    }),
    requirements: objectSchema({
      action: { type: 'string', enum: ['start', 'answer', 'revise-goal'] },
      input: { type: 'string', minLength: 1, maxLength: 6000 },
      expectedOutputId: nullableId,
      expectedRunId: nullableId,
    }),
    stop: objectSchema({ expectedRunId: uuidSchema }),
    reset: objectSchema({ expectedOutputId: nullableId, expectedRunId: nullableId }),
    resize: objectSchema({
      cols: { type: 'integer', minimum: 20, maximum: 512 },
      rows: { type: 'integer', minimum: 5, maximum: 120 },
    }),
  };
  for (const action of ['submit', 'requirements', 'stop', 'reset', 'resize'] as const) {
    app.post<{
      Params: { id: string };
      Body: {
        prompt: string;
        action: RequirementsAction;
        input: string;
        cols: number;
        rows: number;
        expectedRunId: string;
        expectedOutputId: string | null;
      };
    }>(
      `/v1/projects/:id/session/${action}`,
      { schema: { params: paramsSchema, body: bodies[action] } },
      async (request, reply) =>
        mutate(request, reply, () => {
          if (closing) throw new ApiError(503, 'CLOSING', '앱 실행을 정리하고 있어요.');
          project(request.params.id);
          const id = request.params.id;
          const body = request.body;
          const state = manager.read(id, 0);
          if (
            (action === 'stop' && state.id !== body.expectedRunId) ||
            ((action === 'reset' || action === 'submit' || action === 'requirements') &&
              (state.outputId !== body.expectedOutputId || state.id !== body.expectedRunId))
          )
            throw new ApiError(
              409,
              'STALE_SESSION',
              '대화 상태가 바뀌었어요. 최신 상태를 확인한 뒤 다시 시도해 주세요.',
            );
          if (action === 'submit') return manager.submit(id, body.prompt);
          if (action === 'requirements') return manager.requirements(id, body.action, body.input);
          if (action === 'stop') return manager.stop(id);
          if (action === 'reset') return manager.reset(id);
          return manager.resize(id, body.cols, body.rows);
        }),
    );
  }

  app.route({
    method: 'GET',
    url: '/v1/events',
    handler(request, reply) {
      return reply
        .code(400)
        .send(
          failure(
            request.id,
            new ApiError(400, 'WEBSOCKET_REQUIRED', '이 접점은 실시간 연결에만 사용할 수 있어요.'),
          ),
        );
    },
    wsHandler(socket) {
      if (sockets.size >= 8) {
        socket.close(1013, 'Connection limit');
        return;
      }
      sockets.add(socket);
      let alive = true;
      let windowStart = Date.now();
      let messages = 0;
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 5000);
      socket.on('pong', () => {
        alive = true;
      });
      socket.on('error', () => socket.terminate());
      socket.on('close', () => {
        clearInterval(heartbeat);
        sockets.delete(socket);
      });
      socket.on('message', (raw, binary) => {
        let requestId: string | undefined;
        try {
          const now = Date.now();
          if (now - windowStart >= 1000) {
            windowStart = now;
            messages = 0;
          }
          if (++messages > 30 || socket.bufferedAmount > 256 * 1024) {
            socket.close(1013, 'Read limit');
            return;
          }
          if (binary) throw new ApiError(400, 'INVALID_REQUEST', '요청 형식을 확인해 주세요.');
          const data: SessionRead = JSON.parse(raw.toString());
          // Correlate a recoverable bad request before validating its other fields.
          if (data && typeof data.requestId === 'string' && UUID.test(data.requestId))
            requestId = data.requestId;
          if (
            !data ||
            typeof data !== 'object' ||
            Object.keys(data).sort().join(',') !== 'after,outputId,projectId,requestId,type' ||
            data.type !== 'session.read' ||
            typeof data.requestId !== 'string' ||
            !UUID.test(data.requestId) ||
            typeof data.projectId !== 'string' ||
            !UUID.test(data.projectId) ||
            (data.outputId !== null &&
              (typeof data.outputId !== 'string' || !UUID.test(data.outputId))) ||
            !Number.isSafeInteger(data.after) ||
            data.after < 0
          )
            throw new ApiError(400, 'INVALID_REQUEST', '요청 형식을 확인해 주세요.');
          requestId = data.requestId;
          project(data.projectId);
          let snapshot = manager.read(data.projectId, data.after);
          const reset = snapshot.outputId !== data.outputId || data.after > snapshot.nextSequence;
          if (reset) snapshot = manager.read(data.projectId, 0);
          const event: SessionEvent = {
            schemaVersion: 1,
            type: 'session.snapshot',
            requestId,
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            projectId: data.projectId,
            reset,
            gap: snapshot.firstSequence > (reset ? 0 : data.after),
            snapshot,
          };
          socket.send(JSON.stringify(event));
        } catch (error) {
          const known =
            error instanceof ApiError
              ? error
              : new ApiError(400, 'INVALID_REQUEST', '요청 형식을 확인해 주세요.');
          if (requestId) socket.send(JSON.stringify(failure(requestId, known)));
          else socket.close(1008, 'Invalid request');
        }
      });
    },
  });

  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    return {
      endpoint: { baseUrl, token, origin } satisfies LocalEndpoint,
      beginClose() {
        closing = true;
      },
      async close() {
        closing = true;
        for (const socket of sockets) socket.terminate();
        await app.close();
        cache.clear();
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}
