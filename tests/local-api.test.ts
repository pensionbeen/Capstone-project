import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { OutputBuffer } from '../dist/desktop/electron/ai/contracts.js';
import { LocalApiClient } from '../dist/desktop/electron/local-api/client.js';
import { type SessionBackend, startLocalApi } from '../dist/desktop/electron/local-api/server.js';
import { emptyAISnapshot } from '../shared/ai.ts';

function fixture() {
  const id = randomUUID();
  let output = new OutputBuffer();
  let state = { ...emptyAISnapshot };
  let submissions = 0;
  let stops = 0;
  const backend: SessionBackend = {
    listProjects: () => [{ id, name: '한글 프로젝트', path: 'C:\\sample' }],
    hasProject: (value) => value === id,
    availabilityStatus: async () => ({ status: 'ready', message: '합성 검사' }),
    read: (_id, after) => ({
      ...state,
      outputId: output.id,
      chunks: output.read(after),
      nextSequence: output.next,
      firstSequence: output.chunks[0]?.sequence ?? output.next,
      retainedBytes: output.bytes,
      truncated: output.truncated,
    }),
    submit: () => {
      submissions++;
      state = { ...state, id: randomUUID(), state: 'running' };
      return { ok: true };
    },
    requirements: (_id, _action, input) => {
      submissions++;
      state = {
        ...state,
        id: randomUUID(),
        state: 'running',
        purpose: 'requirements',
        requirementsGoal: input,
      };
      return { ok: true, runId: state.id ?? undefined, outputId: output.id };
    },
    stop: () => {
      stops++;
      state = { ...state, state: 'interrupted' };
      return { ok: true };
    },
    reset: () => {
      output = new OutputBuffer();
      state = { ...emptyAISnapshot };
      return { ok: true };
    },
    resize: () => ({ ok: true }),
  };
  return {
    id,
    backend,
    get output() {
      return output;
    },
    get submissions() {
      return submissions;
    },
    get stops() {
      return stops;
    },
  };
}
type Service = Awaited<ReturnType<typeof startLocalApi>>;
function headers(service: Service) {
  return {
    Authorization: `Bearer ${service.endpoint.token}`,
    Origin: service.endpoint.origin,
    'x-request-id': randomUUID(),
    'x-request-time': String(Date.now()),
  };
}
async function http(
  service: Service,
  path: string,
  options: { body?: string; headers?: Record<string, string | undefined>; method?: string } = {},
) {
  const allHeaders: Record<string, string | number | undefined> = {
    ...headers(service),
    ...options.headers,
  };
  if (options.body !== undefined) {
    allHeaders['Content-Type'] ??= 'application/json';
    allHeaders['Content-Length'] = Buffer.byteLength(options.body);
  }
  const defined = Object.fromEntries(
    Object.entries(allHeaders).filter(([, value]) => value !== undefined),
  );
  return new Promise<{ status: number; text: string; data: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        `${service.endpoint.baseUrl}${path}`,
        {
          method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
          headers: defined,
          agent: false,
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8').on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, text, data: JSON.parse(text) }),
          );
          response.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(options.body);
    },
  );
}
async function connect(service: Service) {
  const ws = new WebSocket(`${service.endpoint.baseUrl.replace('http:', 'ws:')}/v1/events`, {
    headers: headers(service),
  });
  await once(ws, 'open');
  return ws;
}
async function receive(ws: WebSocket, data: unknown) {
  const message = once(ws, 'message');
  ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  return JSON.parse(String((await message)[0]));
}

test('실제 REST: 메모리 프로젝트 조회, 인증·Origin·Host·미등록 경계와 비밀 미노출', async (t) => {
  const f = fixture();
  const service = await startLocalApi(f.backend, 'orbit://app');
  t.after(() => service.close());
  const list = await http(service, '/v1/projects');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.data, {
    projects: f.backend.listProjects(),
    storage: 'memory',
    activeProjectId: null,
  });
  assert.equal(list.text.includes(service.endpoint.token), false);
  for (const [override, expected] of [
    [{ Authorization: undefined }, 401],
    [{ Authorization: 'Bearer wrong' }, 401],
    [{ Origin: undefined }, 403],
    [{ Origin: 'null' }, 403],
    [{ Origin: 'https://other.example' }, 403],
    [{ Host: 'localhost' }, 403],
    [{ 'x-forwarded-host': '127.0.0.1' }, 403],
    [{ 'x-request-id': 'invalid' }, 400],
  ] as const) {
    const result = await http(service, '/v1/projects', { headers: override });
    assert.equal(result.status, expected);
    assert.equal(result.text.includes(service.endpoint.token), false);
    assert.equal(result.text.includes('stack'), false);
    assert.ok((result.data.error as { requestId: string }).requestId);
  }
  assert.equal((await http(service, `/v1/projects/${randomUUID()}/session`)).status, 404);
  assert.equal((await http(service, '/v1/projects/no-id')).status, 400);
  assert.equal((await http(service, '/v1/projects?token=never-accepted')).status, 400);
  assert.equal((await http(service, '/v1/projects', { method: 'OPTIONS' })).status, 404);
  assert.equal((await http(service, '/v1/events')).status, 400);
  for (let i = 0; i < 105; i++)
    assert.equal(
      (await http(service, '/v1/projects', { headers: { Authorization: 'wrong' } })).status,
      401,
    );
  assert.equal(
    (await http(service, '/v1/projects')).status,
    200,
    'unauthenticated traffic cannot spend the authenticated request budget',
  );
});

test('요구분석 REST는 인증·형식·중복·오래된 대화 요청을 구분한다', async (t) => {
  const f = fixture();
  const service = await startLocalApi(f.backend, 'orbit://app');
  t.after(() => service.close());
  const path = `/v1/projects/${f.id}/session/requirements`;
  const draft = {
    action: 'start',
    input: '학생을 위한 앱',
    expectedOutputId: f.output.id,
    expectedRunId: null,
  };
  for (const invalid of [
    { ...draft, action: 'execute' },
    { ...draft, input: '' },
    { ...draft, input: '가'.repeat(6001) },
    { ...draft, cwd: 'C:\\private' },
    { ...draft, expectedRunId: 'invalid' },
  ])
    assert.equal((await http(service, path, { body: JSON.stringify(invalid) })).status, 400);
  assert.equal(
    (
      await http(service, path, {
        body: JSON.stringify(draft),
        headers: { Authorization: undefined },
      })
    ).status,
    401,
  );
  assert.equal(f.submissions, 0);
  const requestHeaders = headers(service);
  const first = await http(service, path, { body: JSON.stringify(draft), headers: requestHeaders });
  assert.equal(first.status, 200);
  const duplicate = await http(service, path, {
    body: JSON.stringify(draft),
    headers: requestHeaders,
  });
  assert.deepEqual(duplicate.data, first.data);
  assert.equal(f.submissions, 1);
  assert.equal((await http(service, path, { body: JSON.stringify(draft) })).status, 409);
  assert.equal(
    (
      await http(service, path, {
        body: JSON.stringify({ ...draft, input: '변경' }),
        headers: requestHeaders,
      })
    ).status,
    409,
  );
  const client = new LocalApiClient(service.endpoint);
  t.after(() => client.close());
  const state = f.backend.read(f.id, 0);
  const result = await client.command(f.id, 'requirements', {
    action: 'answer',
    input: '한글 답변',
    expectedOutputId: state.outputId,
    expectedRunId: state.id,
  });
  assert.equal(result.ok, true);
  assert.ok(result.runId);
  assert.equal(result.outputId, state.outputId);
  assert.equal(f.submissions, 2);
});

test('실제 REST: 잘못된 입력·과대 본문·중복 실행·세대 충돌·오래된 요청 거부', async (t) => {
  const f = fixture();
  const service = await startLocalApi(f.backend, 'orbit://app');
  t.after(() => service.close());
  const path = `/v1/projects/${f.id}/session/submit`;
  const body = JSON.stringify({
    prompt: '한글',
    expectedOutputId: f.output.id,
    expectedRunId: null,
  });
  const duplicate = headers(service);
  const [a, b] = await Promise.all([
    http(service, path, { body, headers: duplicate }),
    http(service, path, { body, headers: duplicate }),
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, b.data);
  assert.equal(f.submissions, 1);
  assert.equal(
    (await http(service, path, { body: body.replace('한글', '다른 요청'), headers: duplicate }))
      .status,
    409,
  );
  assert.equal(
    (await http(service, path, { body: JSON.stringify({ prompt: 123, expectedOutputId: null }) }))
      .status,
    400,
  );
  assert.equal(
    (
      await http(service, path, {
        body: JSON.stringify({ prompt: 'text', expectedOutputId: null, cwd: 'C:\\private' }),
      })
    ).status,
    400,
  );
  assert.equal((await http(service, path, { body: '{' })).status, 400);
  assert.equal(
    (
      await http(service, path, {
        body: JSON.stringify({ prompt: 'a'.repeat(40000), expectedOutputId: null }),
      })
    ).status,
    413,
  );
  assert.equal(
    (await http(service, path, { body, headers: { 'Content-Type': 'text/plain' } })).status,
    415,
  );
  assert.equal(
    (await http(service, path, { body, headers: { 'x-request-time': String(Date.now() - 65000) } }))
      .status,
    409,
  );
  const firstRun = f.backend.read(f.id, 0).id;
  f.backend.submit(f.id, 'new');
  for (const action of ['submit', 'reset']) {
    const staleBody = {
      expectedOutputId: f.output.id,
      expectedRunId: firstRun,
      ...(action === 'submit' ? { prompt: 'stale' } : {}),
    };
    assert.equal(
      (
        await http(service, `/v1/projects/${f.id}/session/${action}`, {
          body: JSON.stringify(staleBody),
        })
      ).status,
      409,
    );
  }
  assert.equal(
    (
      await http(service, `/v1/projects/${f.id}/session/stop`, {
        body: JSON.stringify({ expectedRunId: firstRun }),
      })
    ).status,
    409,
  );
  assert.equal(f.stops, 0);
  const generation = f.output.id;
  f.backend.reset(f.id);
  assert.equal(
    (
      await http(service, `/v1/projects/${f.id}/session/reset`, {
        body: JSON.stringify({ expectedOutputId: generation, expectedRunId: null }),
      })
    ).status,
    409,
  );
  service.beginClose();
  assert.equal((await http(service, path, { body })).status, 503);
  assert.equal((await http(service, `/v1/projects/${f.id}/session/status`)).status, 200);
});

test('실제 WebSocket: 업그레이드 전 인증/출처 거부, 메시지 검사와 크기 한도', async (t) => {
  const f = fixture();
  const service = await startLocalApi(f.backend, 'orbit://app');
  t.after(() => service.close());
  for (const override of [{ Authorization: 'Bearer wrong' }, { Origin: 'null' }]) {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${service.endpoint.baseUrl.replace('http:', 'ws:')}/v1/events`, {
        headers: { ...headers(service), ...override },
      });
      ws.on('error', () => {});
      ws.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
        ws.terminate();
      });
      ws.on('open', () => {
        ws.terminate();
        reject(new Error('unauthorized upgrade'));
      });
    });
    assert.equal(status, 'Origin' in override ? 403 : 401);
  }
  const ws = await connect(service);
  t.after(() => ws.terminate());
  for (const malformed of [
    '{',
    JSON.stringify({
      type: 'session.read',
      requestId: [randomUUID()],
      projectId: f.id,
      outputId: null,
      after: 0,
    }),
  ]) {
    const bad = await connect(service);
    const closed = once(bad, 'close');
    bad.send(malformed);
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(
    (
      await receive(ws, {
        type: 'session.read',
        requestId: randomUUID(),
        projectId: randomUUID(),
        outputId: null,
        after: 0,
      })
    ).error.code,
    'PROJECT_NOT_FOUND',
  );
  const invalidId = randomUUID();
  const invalid = await receive(ws, {
    type: 'session.read',
    requestId: invalidId,
    projectId: f.id,
    outputId: null,
    after: -1,
  });
  assert.equal(invalid.error.code, 'INVALID_REQUEST');
  assert.equal(invalid.requestId, invalidId);
  const closed = once(ws, 'close');
  ws.send('x'.repeat(4097));
  assert.ok([1006, 1009].includes((await closed)[0]));
});

test('실제 WebSocket: 64KiB 분할·세대/미래 커서 재동기화·보관 누락 표시', async (t) => {
  const f = fixture();
  const service = await startLocalApi(f.backend, 'orbit://app');
  t.after(() => service.close());
  const ws = await connect(service);
  t.after(() => ws.terminate());
  f.output.append('한글'.repeat(30000), 100, 28);
  const read = (after: number, outputId: string | null = f.output.id) =>
    receive(ws, {
      type: 'session.read',
      requestId: randomUUID(),
      projectId: f.id,
      outputId,
      after,
    });
  const first = await read(0);
  const chunks = first.snapshot.chunks;
  assert.ok(
    Buffer.byteLength(chunks.map((chunk: { data: string }) => chunk.data).join('')) <= 65536,
  );
  const cursor = chunks.at(-1).sequence + 1;
  assert.ok(cursor < first.snapshot.nextSequence);
  const second = await read(cursor);
  assert.equal(second.snapshot.chunks[0].sequence, cursor);
  assert.equal((await read(99999)).reset, true);
  const old = f.output.id;
  f.backend.reset(f.id);
  f.output.append('new-generation', 80, 24);
  const fresh = await read(cursor, old);
  assert.equal(fresh.reset, true);
  assert.equal(fresh.snapshot.chunks[0].data, 'new-generation');
  f.output.append('x'.repeat(600000), 80, 24);
  const gap = await read(0);
  assert.equal(gap.gap, true);
  assert.equal(gap.snapshot.truncated, true);
  assert.ok(gap.snapshot.retainedBytes <= 512 * 1024);
  let unsolicited = 0;
  ws.on('message', () => {
    unsolicited++;
  });
  await delay(300);
  assert.equal(unsolicited, 0, 'slow renderer receives no unsolicited output queue');
});

test('main 클라이언트: 연결 끊김 후 마지막 소비 위치부터 복원, 변경 자동 재전송 없음, 종료 후 소켓 닫힘', async (t) => {
  const f = fixture();
  const service = await startLocalApi(f.backend, 'orbit://app');
  const client = new LocalApiClient(service.endpoint);
  t.after(async () => {
    client.close();
    await service.close();
  });
  f.output.append('before', 100, 28);
  const first = await client.readSession(f.id, 0, null);
  const last = first.chunks.at(-1);
  assert.ok(last);
  const cursor = last.sequence + 1;
  assert.equal((await client.listProjects()).projects[0]?.id, f.id);
  assert.equal((await client.status(f.id)).chunks.length, 0);
  const socket = Reflect.get(client, 'socket') as WebSocket;
  const closed = once(socket, 'close');
  socket.terminate();
  await closed;
  f.output.append('after 한글', 100, 28);
  await assert.rejects(client.readSession(f.id, cursor, first.outputId));
  await delay(300);
  const resumed = await client.readSession(f.id, cursor, first.outputId);
  assert.equal(resumed.chunks.map((chunk) => chunk.data).join(''), 'after 한글');
  assert.equal(f.submissions, 0);
  client.close();
  await service.close();
  await assert.rejects(client.readSession(f.id, 0, null));
  const reply = await client.command(f.id, 'submit', {
    prompt: 'never',
    expectedOutputId: f.output.id,
  });
  assert.equal(reply.ok, false);
  assert.equal(f.submissions, 0);
  await assert.rejects(http(service, '/v1/projects'));
});

test('submit 수락 후 HTTP 응답 유실: 실행은 1회, 상태 재조회만 수행', async (t) => {
  const f = fixture();
  const service = await startLocalApi(f.backend, 'orbit://app');
  const client = new LocalApiClient(service.endpoint);
  t.after(async () => {
    client.close();
    await service.close();
  });
  const submit = f.backend.submit;
  f.backend.submit = (id, prompt) => {
    const result = submit(id, prompt);
    for (const req of Reflect.get(client, 'requests')) req.destroy();
    return result;
  };
  const reply = await client.command(f.id, 'submit', {
    prompt: 'once',
    expectedOutputId: f.output.id,
    expectedRunId: null,
  });
  assert.equal(reply.ok, false);
  assert.match(reply.message ?? '', /결과를 확인하지 못했어요/);
  assert.equal(f.submissions, 1);
  assert.equal((await client.readSession(f.id, 0, null)).state, 'running');
  await delay(300);
  assert.equal(f.submissions, 1);
});

test('재연결 횟수 한도와 명시적 재시도, 인증 오류는 즉시 자동 복구 중단', async (t) => {
  const f = fixture();
  const service = await startLocalApi(f.backend, 'orbit://app');
  const badAuth = new LocalApiClient({ ...service.endpoint, token: 'invalid' });
  await assert.rejects(badAuth.readSession(f.id, 0, null));
  assert.equal(badAuth.readFailure().connectionError.code, 'retry-required');
  badAuth.close();
  const client = new LocalApiClient(service.endpoint);
  t.after(() => client.close());
  await service.close();
  for (let i = 0; i < 8; i++) {
    // Advance only the backoff clock; each attempt still uses a real refused TCP connection.
    Reflect.set(client, 'retryAt', 0);
    await assert.rejects(client.readSession(f.id, 0, null));
    await delay(5);
  }
  assert.equal(Reflect.get(client, 'attempts'), 8);
  assert.equal(client.readFailure().connectionError.code, 'retry-required');
  await assert.rejects(client.readSession(f.id, 0, null));
  assert.equal(Reflect.get(client, 'attempts'), 8);
  assert.equal(client.reconnect().ok, true);
  assert.equal(client.readFailure().connectionError.code, 'reconnecting');
});
