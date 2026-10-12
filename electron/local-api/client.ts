import { randomUUID } from 'node:crypto';
import { type ClientRequest, request } from 'node:http';
import { WebSocket } from 'ws';
import type { AIAvailability, AIReply, AISnapshot } from '../../shared/ai.js';
import type {
  ApiResult,
  ConnectionFailure,
  LocalProject,
  SessionEvent,
  SessionRead,
} from '../../shared/local-api.js';
import type { ProjectCatalog } from '../../shared/storage.js';
import { ApiError, type LocalEndpoint } from './server.js';

const disconnected = () =>
  new ApiError(
    503,
    'DISCONNECTED',
    '앱 내부 연결을 복구하고 있어요. 실행 상태를 다시 확인해 주세요.',
    true,
  );

export class LocalApiClient {
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private closed = false;
  private retryAt = 0;
  private backoff = 250;
  private fatal = false;
  private attempts = 0;
  private requests = new Set<ClientRequest>();
  private pending = new Map<
    string,
    {
      resolve: (event: SessionEvent) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      projectId: string;
    }
  >();
  constructor(private readonly endpoint: LocalEndpoint) {}

  readFailure(): ConnectionFailure {
    const stopped = this.closed || this.fatal || this.attempts >= 8;
    return {
      connectionError: {
        code: stopped ? 'retry-required' : 'reconnecting',
        message: stopped
          ? '자동 연결 복구를 멈췄어요. 다시 연결을 눌러 상태를 확인해 주세요.'
          : '앱 내부 연결을 복구하고 있어요. 현재 출력과 입력은 유지돼요.',
      },
    };
  }
  reconnect(): AIReply {
    if (this.closed) return { ok: false, message: '앱 실행을 정리하고 있어요.' };
    this.attempts = 0;
    this.fatal = false;
    this.retryAt = 0;
    this.backoff = 250;
    return { ok: true };
  }

  private headers(id: string) {
    return {
      Authorization: `Bearer ${this.endpoint.token}`,
      Origin: this.endpoint.origin,
      'x-request-id': id,
    };
  }
  private http<T>(path: string, body?: object): Promise<T> {
    if (this.closed || this.requests.size >= 16) return Promise.reject(disconnected());
    const id = randomUUID();
    const payload = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, data?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.requests.delete(req);
        if (error) reject(error);
        else resolve(data as T);
      };
      const req = request(
        new URL(path, this.endpoint.baseUrl),
        {
          method: body ? 'POST' : 'GET',
          agent: false,
          headers: {
            ...this.headers(id),
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                  'x-request-time': String(Date.now()),
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              finish(disconnected());
              req.destroy();
            } else chunks.push(chunk);
          });
          response.on('error', () => finish(disconnected()));
          response.on('end', () => {
            try {
              const data: ApiResult<T> = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (data.schemaVersion !== 1 || data.requestId !== id) throw disconnected();
              if ('error' in data)
                finish(
                  new ApiError(
                    response.statusCode ?? 500,
                    data.error.code,
                    data.error.message,
                    data.error.retryable,
                  ),
                );
              else if (response.statusCode === 200) finish(undefined, data.data);
              else finish(disconnected());
            } catch {
              finish(disconnected());
            }
          });
        },
      );
      const timer = setTimeout(() => {
        finish(disconnected());
        req.destroy();
      }, 15000);
      this.requests.add(req);
      req.on('error', () => finish(disconnected()));
      req.end(payload);
    });
  }
  listProjects() {
    return this.http<ProjectCatalog>('/v1/projects');
  }
  project(id: string) {
    return this.http<LocalProject>(`/v1/projects/${id}`);
  }
  availability() {
    return this.http<AIAvailability>('/v1/ai/availability');
  }
  status(id: string) {
    return this.http<AISnapshot>(`/v1/projects/${id}/session/status`);
  }
  async command(
    id: string,
    action: 'submit' | 'requirements' | 'generate' | 'stop' | 'reset' | 'resize',
    body: object,
  ): Promise<AIReply> {
    try {
      return await this.http<AIReply>(`/v1/projects/${id}/session/${action}`, body);
    } catch (error) {
      if (error instanceof ApiError && error.code !== 'DISCONNECTED')
        return { ok: false, message: error.message };
      // A missing response does not prove rejection. Never replay a mutation automatically.
      return {
        ok: false,
        message:
          '요청 결과를 확인하지 못했어요. 자동 재전송하지 않았어요. 현재 실행 상태를 확인해 주세요.',
      };
    }
  }
  private connect(): Promise<WebSocket> {
    if (this.closed || this.fatal || this.attempts >= 8 || Date.now() < this.retryAt)
      return Promise.reject(disconnected());
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.attempts++;
    const socket = new WebSocket(`${this.endpoint.baseUrl.replace('http:', 'ws:')}/v1/events`, {
      headers: this.headers(randomUUID()),
      maxPayload: 512 * 1024,
      perMessageDeflate: false,
      handshakeTimeout: 3000,
      followRedirects: false,
    });
    this.socket = socket;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      socket.once('open', () => resolve(socket));
      socket.on('error', () => {
        reject(disconnected());
        socket.terminate();
      });
      socket.once('unexpected-response', (_request, response) => {
        if (response.statusCode === 401 || response.statusCode === 403) this.fatal = true;
        response.resume();
        reject(disconnected());
        socket.terminate();
      });
      socket.once('close', () => {
        reject(disconnected());
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.retryAt = Date.now() + this.backoff;
        this.backoff = Math.min(4000, this.backoff * 2);
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(disconnected());
        }
        this.pending.clear();
      });
      socket.on('message', (raw, binary) => {
        try {
          if (binary) throw disconnected();
          const event: SessionEvent | ApiResult<never> = JSON.parse(raw.toString());
          const pending = this.pending.get(event.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(event.requestId);
          if ('error' in event) {
            pending.reject(
              new ApiError(400, event.error.code, event.error.message, event.error.retryable),
            );
            return;
          }
          if (
            !('type' in event) ||
            event.schemaVersion !== 1 ||
            event.type !== 'session.snapshot' ||
            event.projectId !== pending.projectId ||
            !Array.isArray(event.snapshot?.chunks)
          ) {
            pending.reject(disconnected());
            throw disconnected();
          }
          this.backoff = 250;
          this.attempts = 0;
          this.retryAt = 0;
          pending.resolve(event);
        } catch {
          socket.terminate();
        }
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  async readSession(
    projectId: string,
    after: number,
    outputId: string | null,
  ): Promise<AISnapshot> {
    if (this.pending.size >= 8) throw disconnected();
    const socket = await this.connect();
    if (this.closed || socket.readyState !== WebSocket.OPEN || this.pending.size >= 8)
      throw disconnected();
    const requestId = randomUUID();
    const event = await new Promise<SessionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(disconnected());
        socket.terminate();
      }, 3000);
      this.pending.set(requestId, { resolve, reject, timer, projectId });
      const data: SessionRead = { type: 'session.read', requestId, projectId, after, outputId };
      socket.send(JSON.stringify(data), (error) => {
        if (error) socket.terminate();
      });
    });
    // The renderer acknowledges each written chunk by supplying its next cursor on the next pull.
    return event.snapshot;
  }
  close() {
    this.closed = true;
    for (const req of this.requests) req.destroy();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(disconnected());
    }
    this.pending.clear();
    this.socket?.terminate();
  }
}
