import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  checkFeaturePaths,
  featureSessionPrompt,
  storedFeatureContext,
} from '../dist/desktop/electron/ai/feature-context.js';
import { SessionManager } from '../dist/desktop/electron/ai/session-manager.js';
import type { StoredFeature } from '../shared/feature-plan.ts';
import { featureContextMatches, validFeatureSessionInput } from '../shared/feature-session.ts';

function leaf(patch: Partial<StoredFeature> = {}): StoredFeature {
  return {
    id: randomUUID(),
    parentId: null,
    kind: 'leaf',
    title: '한글 기능',
    description: '설명 원문',
    criteria: '첫 조건\n두 번째 조건',
    included: true,
    revision: 1,
    order: 0,
    relatedPaths: [],
    ...patch,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  options: {
    check?: typeof checkFeaturePaths;
    prepare?: (cwd: string, prompt: string, conversation?: string) => Promise<never>;
  } = {},
) {
  await mkdir('.runtime/feature-session-tests', { recursive: true });
  const base = await mkdtemp(resolve('.runtime/feature-session-tests/case-'));
  const root = join(base, '한글 프로젝트');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', '기능.txt'), 'fixture only');
  let stored: StoredFeature | undefined = leaf();
  const calls: { cwd: string; prompt: string; conversation?: string }[] = [];
  const manager = new SessionManager({
    loadFeature: (_projectId, featureId) => (stored?.id === featureId ? stored : undefined),
    checkFeaturePaths: options.check,
    prepare: async (cwd, prompt, conversation) => {
      calls.push({ cwd, prompt, conversation });
      if (options.prepare) return options.prepare(cwd, prompt, conversation);
      throw new Error('SYNTHETIC_NO_PROCESS');
    },
  });
  const id = manager.registerProject(root);
  assert.ok(id);
  return {
    base,
    root,
    id,
    manager,
    calls,
    get stored() {
      return stored;
    },
    set stored(value: StoredFeature | undefined) {
      stored = value;
    },
    send(action: 'start' | 'answer' = 'start', input = '', feature = stored) {
      assert.ok(feature);
      const snapshot = manager.read(id, 0);
      return manager.feature(
        id,
        action,
        feature.id,
        feature.revision,
        input,
        snapshot.outputId,
        snapshot.id,
      );
    },
  };
}

async function settled(manager: SessionManager) {
  const deadline = Date.now() + 5000;
  while (manager.busy && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
  assert.equal(manager.busy, false);
}

test('새 보호 요청은 로그인 확인을 취소하고 준비 중인 실행이 프로세스를 시작하기 전에 정리를 기다린다', async () => {
  const prepared = deferred();
  const finish = deferred();
  let held = false;
  let loginAborted = false;
  let snapshots = 0;
  const manager = new SessionManager({
    launchHold: () => (held ? '보호 실행 보류' : null),
    inspect: (signal) =>
      new Promise((done) =>
        signal?.addEventListener(
          'abort',
          () => {
            loginAborted = true;
            done({ status: 'error', message: '시험 로그인 확인 취소' });
          },
          { once: true },
        ),
      ),
    prepare: async () => {
      prepared.resolve();
      await finish.promise;
      return { file: 'synthetic-unused', args: [], inspectHeader: false };
    },
    snapshot: async () => {
      snapshots++;
      throw new Error('unexpected process preparation');
    },
  });
  const id = manager.registerProject(resolve('.'));
  assert.ok(id);
  const login = manager.availabilityStatus();
  assert.equal(manager.canChangeProtection, false);
  assert.equal(manager.submit(id, '가짜 요청').ok, true);
  await prepared.promise;
  held = true;
  const cleanup = manager.stopForProtection();
  assert.ok(loginAborted);
  assert.equal(manager.submit(id, '추가 요청').ok, false);
  finish.resolve();
  assert.equal(await cleanup, true);
  assert.equal((await login).status, 'error');
  assert.equal(snapshots, 0);
  assert.equal(manager.read(id, 0).cleanupConfirmed, true);
});

test('기능 입력은 시작 빈문자·답변 필수·2천자·제어문자 경계를 지킨다', () => {
  assert.equal(validFeatureSessionInput('start', ''), true);
  assert.equal(validFeatureSessionInput('answer', ' \n\t'), false);
  for (const action of ['start', 'answer'] as const) {
    assert.equal(validFeatureSessionInput(action, '가'.repeat(2000)), true);
    assert.equal(validFeatureSessionInput(action, '가'.repeat(2001)), false);
    assert.equal(validFeatureSessionInput(action, '한글\n\r\t"$(문자)"'), true);
    for (const input of [null, {}, 1, '\u0000', '\u0003', '\u001b', '\u007f'])
      assert.equal(validFeatureSessionInput(action, input), false);
  }
  assert.equal(validFeatureSessionInput('execute' as never, 'hello'), false);
});

test('문맥 비교는 포함된 말단·버전뿐 아니라 제목·설명·조건·경로의 변경을 구분한다', () => {
  const feature = leaf({ relatedPaths: ['src', 'src/기능.txt'] });
  const context = storedFeatureContext(feature, feature.id, feature.revision);
  assert.equal(featureContextMatches(feature, context), true);
  for (const patch of [
    { id: randomUUID() },
    { revision: 2 },
    { kind: 'group' as const },
    { included: false },
    { title: '새 제목' },
    { description: '새 설명' },
    { criteria: '새 조건' },
    { relatedPaths: ['src'] },
    { relatedPaths: ['src/기능.txt', 'src'] },
  ])
    assert.equal(featureContextMatches({ ...feature, ...patch }, context), false);
  assert.equal(
    featureContextMatches(leaf({ id: feature.id, relatedPaths: undefined }), {
      ...context,
      relatedPaths: [],
    }),
    true,
  );
});

test('저장한 기능만 시작하고 문맥·입력·cwd를 보존하며 조회한 문맥으로 내부 상태를 바꿀 수 없다', async () => {
  const f = await fixture();
  const stored = leaf({ relatedPaths: ['src/기능.txt'], description: '설명 "문자"\n$(literal)' });
  f.stored = stored;
  const input = '--옵션\n한글 $(문자); &';
  const reply = await f.send('start', input);
  assert.equal(reply.ok, true, reply.message);
  await settled(f.manager);
  assert.equal(f.calls.length, 1);
  const context = storedFeatureContext(stored, stored.id, stored.revision);
  assert.deepEqual(f.manager.read(f.id, 0).featureContext, context);
  assert.equal(f.calls[0]?.cwd, f.root);
  assert.equal(f.calls[0]?.prompt, featureSessionPrompt('start', context, input));
  assert.equal(f.calls[0]?.conversation, undefined);
  const snapshot = f.manager.read(f.id, 0);
  assert.ok(snapshot.featureContext);
  snapshot.featureContext.title = '조회자가 바꾼 제목';
  snapshot.featureContext.relatedPaths.push('outside');
  assert.deepEqual(f.manager.read(f.id, 0).featureContext, context);
  stored.title = '뒤늦은 저장 변경';
  stored.relatedPaths?.push('src');
  assert.deepEqual(f.manager.read(f.id, 0).featureContext, context);
  assert.equal(f.manager.read(f.id, 0).purpose, 'feature');
  assert.equal(f.manager.read(f.id, 0).generationState, 'idle');
  await f.manager.shutdown();
});

test('없음·제외·묶음·오래된 버전·다른 프로젝트·잘못된 요청은 실행 전에 거부한다', async () => {
  const f = await fixture();
  const valid = f.stored as StoredFeature;
  for (const changed of [
    undefined,
    { ...valid, included: false },
    { ...valid, kind: 'group' as const, criteria: '' },
  ]) {
    f.stored = changed;
    assert.equal((await f.send('start', '', valid)).ok, false);
  }
  f.stored = valid;
  for (const revision of [0, 2, NaN, 1.1, 2147483648])
    assert.equal(
      (await f.manager.feature(f.id, 'start', valid.id, revision, '', null, null)).ok,
      false,
    );
  assert.equal(
    (await f.manager.feature(randomUUID(), 'start', valid.id, 1, '', null, null)).ok,
    false,
  );
  assert.equal((await f.manager.feature(f.id, 'start', randomUUID(), 1, '', null, null)).ok, false);
  assert.equal(
    (await f.manager.feature(f.id, 'answer', valid.id, 1, '대화 없음', null, null)).ok,
    false,
  );
  assert.equal(
    (await f.manager.feature(f.id, 'execute' as never, valid.id, 1, '', null, null)).ok,
    false,
  );
  assert.equal(
    (await f.manager.feature(f.id, 'start', valid.id, 1, '\u0003', null, null)).ok,
    false,
  );
  assert.equal(
    (await f.manager.feature(f.id, 'start', valid.id, 1, '', randomUUID(), null)).ok,
    false,
  );
  assert.equal(
    (await f.manager.feature(f.id, 'start', valid.id, 1, '', null, randomUUID())).ok,
    false,
  );
  assert.equal(f.calls.length, 0);
  const untrusted = new SessionManager();
  const other = untrusted.registerProject(f.root);
  assert.ok(other);
  assert.equal((await untrusted.feature(other, 'start', valid.id, 1, '', null, null)).ok, false);
  assert.equal(f.manager.canChangeProjects, true);
});

test('관련 경로가 없으면 프로젝트 루트를 검사하고 링크·없는 경로·바깥 경로를 거부한다', async () => {
  const f = await fixture();
  const outside = join(f.base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'synthetic');
  await symlink(outside, join(f.root, 'linked'), 'junction');
  await symlink(f.root, join(f.base, 'linked-root'), 'junction');
  await checkFeaturePaths(f.root, []);
  await checkFeaturePaths(f.root, ['src', 'src/기능.txt']);
  for (const paths of [
    ['missing'],
    ['linked/secret.txt'],
    ['../outside/secret.txt'],
    [outside],
    ['src/../src/기능.txt'],
  ])
    await assert.rejects(checkFeaturePaths(f.root, paths), /FEATURE_PATH_UNAVAILABLE/);
  for (const root of [
    join(f.base, 'missing-root'),
    join(f.base, 'linked-root'),
    join(f.root, 'src', '기능.txt'),
  ])
    await assert.rejects(checkFeaturePaths(root, []), /FEATURE_PATH_UNAVAILABLE/);
  f.stored = leaf({ relatedPaths: ['linked/secret.txt'] });
  assert.equal((await f.send()).ok, false);
  assert.equal(f.calls.length, 0);
});

test('완전한 문맥이 8천자를 넘으면 핵심 내용을 자르지 않고 명시적으로 거부한다', async () => {
  let checked = 0;
  const f = await fixture({
    check: async () => {
      checked++;
    },
  });
  f.stored = leaf({
    description: '설'.repeat(2000),
    criteria: '조'.repeat(2000),
    relatedPaths: Array.from({ length: 6 }, (_, index) => `${index}${'경'.repeat(900)}`),
  });
  const reply = await f.send('start', '입'.repeat(2000));
  assert.equal(reply.ok, false);
  assert.match(reply.message ?? '', /8,000자/u);
  assert.match(reply.message ?? '', /생략해 보내지 않았/u);
  assert.equal(checked, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.read(f.id, 0).featureContext, null);
});

test('비동기 경로 검사 동안 시작·일반 대화·목표·reset·프로젝트 변경을 겹칠 수 없다', async () => {
  const gate = deferred();
  const f = await fixture({ check: () => gate.promise });
  const pending = f.send();
  assert.equal(f.manager.busy, true);
  assert.equal(f.manager.canChangeProjects, false);
  assert.equal((await f.send()).ok, false);
  assert.equal(f.manager.submit(f.id, '겹친 일반 대화').ok, false);
  assert.equal(f.manager.requirements(f.id, 'start', '겹친 목표').ok, false);
  assert.equal(f.manager.reset(f.id).ok, false);
  assert.equal(f.manager.replaceProjects([], true), false);
  assert.equal(f.manager.registerProject(f.base), null);
  assert.equal(f.manager.hasProject(f.id), true);
  gate.resolve();
  assert.equal((await pending).ok, true);
  await settled(f.manager);
  assert.equal(f.calls.length, 1);
});

test('경로 검사 중 저장된 기능이 바뀌면 버전이 같아도 실행하지 않는다', async () => {
  for (const patch of [
    { title: '변경 제목' },
    { description: '변경 설명' },
    { criteria: '변경 조건' },
    { relatedPaths: ['src'] },
    { revision: 2 },
    { included: false },
    { kind: 'group' as const },
  ]) {
    const gate = deferred();
    const f = await fixture({ check: () => gate.promise });
    const pending = f.send();
    f.stored = { ...(f.stored as StoredFeature), ...patch };
    gate.resolve();
    const reply = await pending;
    assert.equal(reply.ok, false, JSON.stringify(patch));
    assert.match(reply.message ?? '', /바뀌었/u);
    assert.equal(f.calls.length, 0);
    assert.equal(f.manager.busy, false);
  }
});

test('경로 검사 뒤 output ID와 run ID를 다시 대조한다', async () => {
  for (const field of ['outputId', 'id'] as const) {
    const gate = deferred();
    const f = await fixture({ check: () => gate.promise });
    const pending = f.send();
    const read = f.manager.read.bind(f.manager);
    f.manager.read = (id, after) => ({ ...read(id, after), [field]: randomUUID() });
    gate.resolve();
    const reply = await pending;
    assert.equal(reply.ok, false);
    assert.match(reply.message ?? '', /대화 상태가 바뀌었/u);
    assert.equal(f.calls.length, 0);
  }
});

test('준비 중 일반 중단은 거부하고 앱 종료는 예약을 취소한다', async () => {
  for (const action of ['stop', 'shutdown'] as const) {
    const gate = deferred();
    const f = await fixture({ check: () => gate.promise });
    const pending = f.send();
    if (action === 'stop') assert.equal(f.manager.stop(f.id).ok, false);
    const shutdown = action === 'shutdown' ? f.manager.shutdown() : undefined;
    gate.resolve();
    const reply = await pending;
    assert.equal(reply.ok, action === 'stop');
    await settled(f.manager);
    assert.equal(f.calls.length, action === 'stop' ? 1 : 0);
    assert.equal(f.manager.busy, false);
    if (shutdown) {
      assert.match(reply.message ?? '', /취소/u);
      assert.equal(await shutdown, true);
    }
  }
});

test('다른 프로젝트 준비 중 이전 종료 세션의 늦은 stop은 상태를 stopping에 가두지 않는다', async () => {
  const gate = deferred();
  let block = false;
  const f = await fixture({
    check: async () => {
      if (block) await gate.promise;
    },
  });
  assert.equal(f.manager.submit(f.id, '기존 프로젝트 대화').ok, true);
  await settled(f.manager);
  const previous = f.manager.read(f.id, 0);
  const otherId = f.manager.registerProject(f.base);
  assert.ok(otherId);
  block = true;
  const feature = f.stored as StoredFeature;
  const pending = f.manager.feature(otherId, 'start', feature.id, 1, '', null, null);
  assert.equal(f.manager.stop(f.id).ok, false);
  assert.equal(f.manager.read(f.id, 0).state, previous.state);
  gate.resolve();
  assert.equal((await pending).ok, true);
  await settled(f.manager);
  assert.equal(f.manager.read(otherId, 0).purpose, 'feature');
  assert.equal(f.calls.length, 2);
});

test('기능·요구분석·일반 대화의 답변을 섞지 않으며 새 대화에서 문맥을 비운다', async () => {
  const f = await fixture();
  assert.equal((await f.send()).ok, true);
  await settled(f.manager);
  const first = f.manager.read(f.id, 0);
  assert.equal(f.manager.submit(f.id, '일반 답변').ok, false);
  assert.equal(f.manager.requirements(f.id, 'answer', '요구 답변').ok, false);
  assert.equal(f.manager.generate(f.id).ok, false);
  assert.equal(f.manager.requirements(f.id, 'start', '새 요구 목표').ok, true);
  await settled(f.manager);
  assert.equal(f.manager.read(f.id, 0).featureContext, null);
  assert.equal(f.manager.read(f.id, 0).purpose, 'requirements');
  assert.notEqual(f.manager.read(f.id, 0).outputId, first.outputId);
  assert.equal((await f.send('answer', '기능 답변')).ok, false);
  assert.equal(f.manager.reset(f.id).ok, true);
  assert.equal(f.manager.read(f.id, 0).featureContext, null);
  assert.equal(f.manager.submit(f.id, '새 일반 대화').ok, true);
  await settled(f.manager);
  assert.equal(f.manager.read(f.id, 0).purpose, 'chat');
  assert.equal(f.manager.read(f.id, 0).featureContext, null);
});

test('실행 드라이버 준비 중 DB 내용이 바뀌면 호스트를 띄우기 전 재대조하여 멈춘다', async () => {
  const ready = deferred();
  const prepared = deferred();
  const f = await fixture();
  const feature = f.stored as StoredFeature;
  const manager = new SessionManager({
    loadFeature: () => f.stored,
    // This missing host is never spawned when the final context comparison works.
    hostExecutable: join(f.base, 'missing-host.exe'),
    snapshot: async () => [],
    prepare: async () => {
      prepared.resolve();
      await ready.promise;
      return { file: process.execPath, args: [], inspectHeader: false };
    },
  });
  const id = manager.registerProject(f.root);
  assert.ok(id);
  assert.equal((await manager.feature(id, 'start', feature.id, 1, '', null, null)).ok, true);
  await prepared.promise;
  f.stored = { ...feature, description: '드라이버 준비 중 변경된 설명' };
  ready.resolve();
  await settled(manager);
  assert.equal(manager.read(id, 0).state, 'error');
  assert.equal(manager.read(id, 0).cleanupConfirmed, true);
  assert.equal(manager.diagnostic.reason, 'FEATURE_CHANGED');
  assert.deepEqual(manager.diagnostic.owned, []);
});
