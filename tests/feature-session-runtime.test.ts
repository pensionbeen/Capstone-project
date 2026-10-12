import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../dist/desktop/electron/ai/session-manager.js';
import { ProjectStore } from '../dist/desktop/electron/storage/project-store.js';
import type { StoredFeature } from '../shared/feature-plan.ts';

const electron = createRequire(import.meta.url)('electron') as string;

async function waitFor(check: () => boolean, ms = 45000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(check(), 'state deadline exceeded');
}

test('기능 세션 실제 PTY: 신뢰 DB 문맥·cwd·재개·새 실행 ID·중단·앱 종료와 검증 상태 분리', {
  timeout: 150000,
  skip: process.platform !== 'win32',
}, async () => {
  await mkdir('.runtime/feature-session-runtime', { recursive: true });
  const base = await mkdtemp(resolve('.runtime/feature-session-runtime/case-'));
  const cwd = join(base, '한글 기능 프로젝트');
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src', '작업.txt'), 'fixture only');
  const store = new ProjectStore(join(base, 'data'));
  const project = store.register(cwd, true);
  const first: StoredFeature = {
    id: randomUUID(),
    parentId: null,
    kind: 'leaf',
    title: '과제 등록',
    description: '사용자 입력과 저장 결과를 분석한다.',
    criteria: '과제 이름을 입력할 수 있다.\n저장 결과를 확인한다.',
    included: true,
    revision: 1,
    order: 0,
    relatedPaths: ['src/작업.txt'],
  };
  const second: StoredFeature = {
    ...first,
    id: randomUUID(),
    title: '과제 목록',
    order: 1,
    relatedPaths: [],
  };
  const plan = store.saveFeaturePlan(project.id, {
    features: [first, second],
    dependencies: [],
    verifications: [],
  });
  const calls: { cwd: string; prompt: string; conversation?: string }[] = [];
  let changed: StoredFeature | undefined;
  const manager = new SessionManager({
    hostExecutable: electron,
    loadFeature: (id, featureId) =>
      changed ?? store.featurePlan(id).features.find((feature) => feature.id === featureId),
    prepare: async (root, prompt, conversation) => {
      calls.push({ cwd: root, prompt, conversation });
      return {
        file: process.execPath,
        args: [
          resolve('tests/fixtures/ai-cli.cjs'),
          Buffer.from(JSON.stringify({ prompt, conversation })).toString('base64'),
        ],
        inspectHeader: true,
      };
    },
  });
  manager.replaceProjects(store.catalog().projects);
  const send = (action: 'start' | 'answer', feature: StoredFeature, input = '') => {
    const snapshot = manager.read(project.id, 0);
    return manager.feature(
      project.id,
      action,
      feature.id,
      feature.revision,
      input,
      snapshot.outputId,
      snapshot.id,
    );
  };
  try {
    const started = await send('start', first);
    assert.equal(started.ok, true, started.message);
    await waitFor(() => !manager.busy);
    const initial = manager.read(project.id, 0);
    assert.equal(initial.state, 'exited', JSON.stringify(manager.diagnostic));
    assert.equal(initial.cleanupConfirmed, true);
    assert.equal(initial.purpose, 'feature');
    assert.deepEqual(initial.featureContext, {
      featureId: first.id,
      revision: first.revision,
      title: first.title,
      description: first.description,
      criteria: first.criteria,
      relatedPaths: first.relatedPaths,
    });
    assert.equal(calls[0]?.cwd, await realpath(cwd));
    assert.equal(calls[0]?.conversation, undefined);
    assert.ok(calls[0]?.prompt.includes(JSON.stringify(initial.featureContext)));
    assert.match(initial.message, /검증 완료를 뜻하지/u);
    assert.equal(initial.conversationReady, true);
    assert.deepEqual(store.featurePlan(project.id), plan);
    assert.equal(manager.submit(project.id, '일반 대화로 섞기').ok, false);
    assert.equal(manager.requirements(project.id, 'answer', '요구분석으로 섞기').ok, false);
    assert.equal(manager.generate(project.id).ok, false);
    assert.equal(
      (await manager.feature(project.id, 'answer', first.id, 1, '오래된 요청', null, null)).ok,
      false,
    );

    const answered = await send('answer', first, '두 번째 조건의 구현 계획을 설명해 주세요.');
    assert.equal(answered.ok, true, answered.message);
    assert.equal(answered.outputId, started.outputId);
    assert.notEqual(answered.runId, started.runId);
    await waitFor(() => !manager.busy);
    assert.equal(manager.read(project.id, 0).state, 'exited', JSON.stringify(manager.diagnostic));
    assert.equal(calls[1]?.conversation, '12345678-1234-4234-8234-123456789012');
    assert.deepEqual(manager.read(project.id, 0).featureContext, initial.featureContext);

    for (const patch of [
      { title: '수정된 제목' },
      { description: '수정된 설명' },
      { criteria: '새 완료 조건' },
      { relatedPaths: [] },
    ]) {
      changed = { ...first, ...patch };
      assert.equal((await send('answer', first, '바뀐 조건')).ok, false);
    }
    changed = undefined;
    assert.equal((await send('answer', second, '다른 기능 답변')).ok, false);
    const other = manager.registerProject(base);
    assert.ok(other);
    assert.equal(
      (await manager.feature(other, 'answer', first.id, 1, '다른 프로젝트', null, null)).ok,
      false,
    );

    const next = await send('start', second, 'WAIT: 사용자 중단 검사');
    assert.equal(next.ok, true, next.message);
    assert.notEqual(next.outputId, started.outputId);
    await waitFor(() => manager.read(project.id, 0).state === 'running');
    assert.equal(calls[2]?.conversation, undefined);
    assert.equal(manager.read(project.id, 0).featureContext?.featureId, second.id);
    assert.equal(manager.stop(project.id).ok, true);
    await waitFor(() => !manager.busy);
    assert.equal(
      manager.read(project.id, 0).state,
      'interrupted',
      JSON.stringify(manager.diagnostic),
    );
    assert.deepEqual(store.featurePlan(project.id), plan);

    assert.equal((await send('answer', second, 'WAIT: 앱 종료 검사')).ok, true);
    await waitFor(() => manager.read(project.id, 0).state === 'running');
    assert.equal(await manager.shutdown(), true);
    assert.equal(manager.busy, false);
    assert.deepEqual(store.featurePlan(project.id), plan);
  } finally {
    await manager.shutdown();
    store.close();
  }
});
