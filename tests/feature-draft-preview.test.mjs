import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const groupId = '11111111-1111-4111-8111-111111111111';
const loginId = '22222222-2222-4222-8222-222222222222';
const logoutId = '33333333-3333-4333-8333-333333333333';
const fixture = {
  features: [
    {
      id: groupId,
      parentId: null,
      kind: 'group',
      title: '계정 관리',
      description: '',
      criteria: '',
      included: true,
      revision: 1,
      order: 0,
    },
    {
      id: loginId,
      parentId: groupId,
      kind: 'leaf',
      title: '로그인',
      description: '계정에 로그인한다.',
      criteria: '성공하면 시작 화면이 열린다.\n실패하면 오류를 안내한다.',
      included: true,
      revision: 1,
      order: 0,
      relatedPaths: ['src/login.ts'],
    },
    {
      id: logoutId,
      parentId: null,
      kind: 'leaf',
      title: '로그아웃',
      description: '',
      criteria: '로그아웃하면 로그인 화면이 열린다.',
      included: true,
      revision: 1,
      order: 1,
    },
  ],
  dependencies: [{ featureId: logoutId, prerequisiteId: loginId }],
  verifications: [],
};

const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureDraftPreview } from '/src/components/FeatureDraftPreview.tsx';
import '/src/styles.css';
function Harness() {
  const [plan, setPlan] = useState(window.initialPlan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  window.currentPlan = plan;
  window.setBusy = setBusy;
  window.setError = setError;
  return <main style={{ padding: 16 }}><FeatureDraftPreview plan={plan} busy={busy} error={error}
    onChange={(value) => { window.changes += 1; setPlan(value); }}
    onApply={() => { window.applies += 1; }} onCancel={() => { window.cancels += 1; }} /></main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;
let server;
let browser;
let baseUrl;

before(async () => {
  server = await createServer({
    root,
    cacheDir: `${root}/.runtime/draft-preview-vite-cache`,
    configFile: false,
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'draft-preview-test-harness',
        resolveId(id) {
          if (id === '/__draft-preview-test.jsx') return id;
        },
        load(id) {
          if (id === '/__draft-preview-test.jsx') return harness;
        },
        configureServer(instance) {
          instance.middlewares.use((request, response, next) => {
            if (request.url !== '/__draft-preview-test') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(
              '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__draft-preview-test.jsx"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/__draft-preview-test`;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.DRAFT_PREVIEW_BROWSER_CHANNEL ?? 'chrome',
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(plan = fixture, viewport = { width: 1000, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(6000);
  await page.addInitScript((value) => {
    window.initialPlan = value;
    window.changes = 0;
    window.applies = 0;
    window.cancels = 0;
  }, plan);
  await page.goto(baseUrl);
  await page.getByRole('heading', { name: '기능 초안 미리보기' }).waitFor();
  return page;
}

test('edits reach the parent only after reflection; invalid dependency cycles preserve the candidate', async () => {
  const page = await open();
  try {
    if (process.env.DRAFT_PREVIEW_CAPTURE === '1') {
      await mkdir(`${root}/.runtime/draft-preview-screens`, { recursive: true });
      await page.screenshot({
        path: `${root}/.runtime/draft-preview-screens/normal.png`,
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: '로그인 초안 수정', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('기능 이름', { exact: true }).fill('한글 로그인 수정');
    await dialog.getByLabel('기능 설명').fill('새 설명');
    await dialog
      .getByLabel('완료 조건', { exact: true })
      .fill('올바른 비밀번호를 입력하면 화면이 열린다.');
    assert.deepEqual(await page.evaluate(() => window.currentPlan), fixture);
    await dialog.getByRole('checkbox', { name: '로그아웃', exact: true }).check();
    await dialog.getByRole('button', { name: '초안에 반영' }).click();
    assert.match(await dialog.getByRole('alert').innerText(), /순환/);
    assert.deepEqual(await page.evaluate(() => window.currentPlan), fixture);
    await dialog.getByRole('checkbox', { name: '로그아웃', exact: true }).uncheck();
    await dialog.getByRole('button', { name: '초안에 반영' }).click();
    await page.getByRole('heading', { name: '한글 로그인 수정' }).waitFor();
    const actual = await page.evaluate(() => window.currentPlan);
    assert.equal(
      actual.features.find((item) => item.id === loginId).criteria,
      '올바른 비밀번호를 입력하면 화면이 열린다.',
    );
    assert.deepEqual(actual.dependencies, fixture.dependencies);
    assert.deepEqual(actual.verifications, []);
    assert.equal(await page.evaluate(() => window.applies), 0);
    await page.getByRole('button', { name: '초안 적용', exact: true }).click();
    assert.equal(await page.evaluate(() => window.applies), 1);
  } finally {
    await page.close();
  }
});

test('excluded features and links remain; excluding every leaf blocks apply and re-inclusion restores it', async () => {
  const page = await open();
  try {
    await page.getByRole('checkbox', { name: '로그인 포함', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: '로그아웃 포함', exact: true }).uncheck();
    const actual = await page.evaluate(() => window.currentPlan);
    assert.equal(actual.features.length, 3);
    assert.deepEqual(actual.dependencies, fixture.dependencies);
    assert.equal(
      await page.getByRole('button', { name: '초안 적용', exact: true }).isDisabled(),
      true,
    );
    assert.match(await page.getByRole('status').innerText(), /최소 1개/);
    await page.getByRole('checkbox', { name: '로그인 포함', exact: true }).check();
    assert.equal(
      await page.getByRole('button', { name: '초안 적용', exact: true }).isEnabled(),
      true,
    );
  } finally {
    await page.close();
  }
});

test('group deletion confirms its descendants and prunes links while deletion cancel preserves the plan', async () => {
  const page = await open();
  try {
    await page.getByRole('button', { name: '계정 관리 초안 삭제' }).click();
    assert.match(await page.getByRole('dialog').innerText(), /총 2개/);
    await page.getByRole('button', { name: '삭제 취소', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.currentPlan), fixture);
    await page.getByRole('button', { name: '계정 관리 초안 삭제' }).click();
    await page.getByRole('button', { name: '초안에서 삭제', exact: true }).click();
    await page.getByRole('heading', { name: '로그인', exact: true }).waitFor({ state: 'detached' });
    const actual = await page.evaluate(() => window.currentPlan);
    assert.deepEqual(
      actual.features.map((item) => item.id),
      [logoutId],
    );
    assert.deepEqual(actual.dependencies, []);
    assert.deepEqual(actual.verifications, []);
    assert.equal(await page.evaluate(() => window.applies), 0);
  } finally {
    await page.close();
  }
});

test('empty candidate allows manual addition; missing criteria and unsafe paths cannot be reflected', async () => {
  const page = await open({ features: [], dependencies: [], verifications: [] });
  try {
    assert.equal(
      await page.getByRole('button', { name: '초안 적용', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: '기능 직접 추가', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('기능 이름', { exact: true }).fill('직접 추가한 기능');
    assert.equal(await dialog.getByRole('button', { name: '초안에 반영' }).isDisabled(), true);
    await dialog.getByLabel('완료 조건', { exact: true }).fill('직접 동작을 확인한다.');
    await dialog.getByLabel('관련 경로').fill('../outside.ts');
    assert.equal(await dialog.getByRole('button', { name: '초안에 반영' }).isDisabled(), true);
    await dialog.getByLabel('관련 경로').fill('src/새 기능.ts');
    await dialog.getByRole('button', { name: '초안에 반영' }).click();
    await page.getByRole('heading', { name: '직접 추가한 기능' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '초안 적용', exact: true }).isEnabled(),
      true,
    );
    const actual = await page.evaluate(() => window.currentPlan);
    assert.equal(actual.features[0].revision, 1);
    assert.deepEqual(actual.features[0].relatedPaths, ['src/새 기능.ts']);
    await page.getByRole('button', { name: '초안 취소', exact: true }).click();
    assert.equal(await page.evaluate(() => window.cancels), 1);
  } finally {
    await page.close();
  }
});

test('busy disables changes and applying; saving errors retain the edited candidate', async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      window.setBusy(true);
    });
    await page.getByRole('button', { name: '처리 중…', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '기능 직접 추가', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: '초안 취소', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('checkbox', { name: '로그인 포함', exact: true }).isDisabled(),
      true,
    );
    await page.evaluate(() => {
      window.setBusy(false);
      window.setError('저장에 실패했어요. 다시 적용해 주세요.');
    });
    await page.getByRole('alert').waitFor();
    assert.deepEqual(await page.evaluate(() => window.currentPlan), fixture);
    assert.equal(
      await page.getByRole('button', { name: '초안 적용', exact: true }).isEnabled(),
      true,
    );
  } finally {
    await page.close();
  }
});

test('invalid graph and supplied verification records cannot be applied or edited', async () => {
  for (const plan of [
    {
      ...fixture,
      dependencies: [...fixture.dependencies, { featureId: loginId, prerequisiteId: logoutId }],
    },
    {
      ...fixture,
      verifications: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          featureId: loginId,
          featureTitle: '로그인',
          revision: 1,
          result: 'passed',
          observation: '확인했다',
          evidence: '검사',
          checkedCriteria: ['성공하면 시작 화면이 열린다.', '실패하면 오류를 안내한다.'],
          createdAt: '2026-10-12T00:00:00Z',
        },
      ],
    },
  ]) {
    const page = await open(plan);
    try {
      assert.equal(
        await page.getByRole('button', { name: '초안 적용', exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole('button', { name: '기능 직접 추가', exact: true }).isDisabled(),
        true,
      );
      assert.match(await page.getByRole('alert').innerText(), /다시 생성/);
      assert.equal(await page.evaluate(() => window.changes), 0);
    } finally {
      await page.close();
    }
  }
});

test('small viewport wraps long content and native keyboard controls remain usable', async () => {
  const plan = structuredClone(fixture);
  plan.features[1].title = '아주긴기능이름'.repeat(10);
  plan.features[1].description = 'verylongunbrokendescription'.repeat(30);
  const page = await open(plan, { width: 390, height: 844 });
  try {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert.equal(overflow, false);
    if (process.env.DRAFT_PREVIEW_CAPTURE === '1') {
      await mkdir(`${root}/.runtime/draft-preview-screens`, { recursive: true });
      await page.screenshot({
        path: `${root}/.runtime/draft-preview-screens/narrow.png`,
        fullPage: true,
      });
    }
    const checkbox = page.getByRole('checkbox', {
      name: `${plan.features[1].title} 포함`,
      exact: true,
    });
    await checkbox.focus();
    await page.keyboard.press('Space');
    assert.equal((await page.evaluate(() => window.currentPlan)).features[1].included, false);
    await page
      .getByRole('button', { name: `${plan.features[1].title} 초안 수정`, exact: true })
      .click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally {
    await page.close();
  }
});

test('group cannot select itself or its descendants as a parent; adding a nested group stays in the draft', async () => {
  const plan = structuredClone(fixture);
  const subgroupId = '44444444-4444-4444-8444-444444444444';
  plan.features.push({
    id: subgroupId,
    parentId: groupId,
    kind: 'group',
    title: '보안 관리',
    description: '',
    criteria: '',
    included: true,
    revision: 1,
    order: 1,
  });
  const page = await open(plan);
  try {
    await page.getByRole('button', { name: '계정 관리 초안 수정' }).click();
    const dialog = page.getByRole('dialog');
    assert.deepEqual(await dialog.getByLabel('상위 묶음').locator('option').allTextContents(), [
      '최상위',
    ]);
    await dialog.getByRole('button', { name: '수정 취소', exact: true }).click();
    await page.getByRole('button', { name: '묶음 추가', exact: true }).click();
    await page.getByRole('dialog').getByLabel('기능 이름', { exact: true }).fill('프로필 관리');
    await page.getByRole('dialog').getByLabel('상위 묶음').selectOption(groupId);
    await page.getByRole('button', { name: '초안에 반영', exact: true }).click();
    await page.getByRole('heading', { name: '프로필 관리', exact: true }).waitFor();
    const actual = await page.evaluate(() => window.currentPlan);
    assert.equal(actual.features.find((item) => item.title === '프로필 관리').parentId, groupId);
    assert.equal(await page.evaluate(() => window.applies), 0);
  } finally {
    await page.close();
  }
});

test('100 valid items remain readable and prevent further additions', async () => {
  const features = Array.from({ length: 100 }, (_, index) => ({
    id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    parentId: null,
    kind: 'leaf',
    title: `기능 ${index + 1}`,
    description: '',
    criteria: '동작을 확인한다.',
    included: true,
    revision: 1,
    order: index,
  }));
  const page = await open({ features, dependencies: [], verifications: [] });
  try {
    assert.equal(await page.locator('.feature-draft-row').count(), 100);
    assert.equal(
      await page.getByRole('button', { name: '기능 직접 추가', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: '묶음 추가', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: '초안 적용', exact: true }).isEnabled(),
      true,
    );
  } finally {
    await page.close();
  }
});
