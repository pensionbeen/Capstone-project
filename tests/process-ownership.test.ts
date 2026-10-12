import assert from 'node:assert/strict';
import test from 'node:test';
import { ProcessAudit, type ProcessIdentity } from '../dist/desktop/electron/ai/process-audit.js';
import { SessionProcesses } from '../experiments/x-001-ai-terminal/managed-processes.mjs';

function row(pid: number, parent: number, created: number, name = 'node.exe'): ProcessIdentity {
  return { pid, parent, created: new Date(created).toISOString(), name };
}

const supervisor = row(90, 4, 500);
const external = row(5684, 4, 400, 'editor.exe');
const owner = row(100, 90, 1000);
const oldCli = row(13940, 100, 2000, 'agy.exe');
const reused = row(13940, 5684, 5000, 'git.exe');
const gitChild = row(24956, 13940, 5020, 'git.exe');

interface Audit {
  owned: Map<string, ProcessIdentity>;
  uncertain: boolean;
  uncertainProcesses: Map<string, ProcessIdentity & { observedParent: ProcessIdentity | null }>;
  observe: (rows: ProcessIdentity[]) => unknown;
  alive: () => ProcessIdentity[] | number[];
}

const trackers: [string, (baseline: ProcessIdentity[]) => Audit][] = [
  ['앱 ProcessAudit', (baseline) => new ProcessAudit(baseline, owner.pid, supervisor.pid)],
  [
    '검토 SessionProcesses',
    (baseline) => new SessionProcesses(baseline, owner.pid, supervisor.pid),
  ],
];

for (const [name, create] of trackers) {
  const observed = (baseline: ProcessIdentity[] = [supervisor, external]) => {
    const audit = create(baseline);
    audit.observe([...baseline, owner, oldCli]);
    return audit;
  };
  test(`${name}: 종료된 소유 PID를 외부 Git 부모가 재사용한 자식을 불확실로 오판하지 않는다`, () => {
    const audit = create([supervisor, external]);
    audit.observe([supervisor, external, owner, oldCli]);
    audit.observe([supervisor, external, reused, gitChild]);
    assert.equal(audit.uncertain, false);
    assert.deepEqual(audit.alive(), []);
    assert.equal(audit.owned.size, 2, '외부 Git 부모와 자식을 소유 목록에 추가하지 않는다');
    assert.equal(audit.uncertainProcesses.size, 0);
  });

  test(`${name}: 부모 누락·생성 순서 모순·외부 조상 누락과 재사용에서는 불확실 판정을 유지한다`, () => {
    for (const [reason, rows] of [
      ['부모가 없음', [supervisor, external, gitChild]],
      [
        '자식보다 늦은 부모',
        [supervisor, external, { ...reused, created: new Date(6000).toISOString() }, gitChild],
      ],
      [
        '소유 부모보다 오래된 새 identity',
        [supervisor, external, { ...reused, created: new Date(1500).toISOString() }, gitChild],
      ],
      ['조상 조회 누락', [supervisor, reused, gitChild]],
      [
        '외부 기준 조상도 PID 재사용',
        [supervisor, { ...external, created: new Date(4500).toISOString() }, reused, gitChild],
      ],
      [
        '상위 관계 순환',
        [supervisor, { ...reused, parent: 7000 }, row(7000, reused.pid, 5000), gitChild],
      ],
    ] as [string, ProcessIdentity[]][]) {
      const audit = observed();
      audit.observe(rows);
      assert.equal(audit.uncertain, true, reason);
      assert.equal(audit.owned.size, 2, '불확실 자식을 소유 프로세스로 취급하지 않는다');
      const evidence = audit.uncertainProcesses.get(`${gitChild.pid}:${gitChild.created}`);
      assert.ok(evidence, reason);
      assert.deepEqual(
        evidence.observedParent,
        rows.find((item) => item.pid === gitChild.parent) ?? null,
      );
    }
  });

  test(`${name}: 같은 감독자와 그 기존 자식 아래의 재사용 PID는 외부 근거가 아니다`, () => {
    const baselineChild = row(8000, supervisor.pid, 700, 'helper.exe');
    for (const parent of [supervisor.pid, baselineChild.pid]) {
      const audit = observed([supervisor, external, baselineChild]);
      audit.observe([supervisor, external, baselineChild, { ...reused, parent }, gitChild]);
      assert.equal(audit.uncertain, true);
      assert.equal(audit.owned.size, 2);
      assert.equal(audit.uncertainProcesses.size, 1);
    }
  });

  test(`${name}: 실제 소유 부모가 살아 있을 때의 새 후손과 재배치된 기존 후손은 계속 소유한다`, () => {
    const audit = observed();
    const newOwned = { ...reused, parent: owner.pid };
    audit.observe([supervisor, external, owner, newOwned, gitChild]);
    assert.equal(audit.uncertain, false);
    assert.equal(audit.owned.size, 4);
    assert.equal(audit.alive().length, 3);
    // Once observed as owned, moving a helper to an external parent cannot erase it.
    audit.observe([supervisor, external, { ...gitChild, parent: external.pid }]);
    assert.equal(audit.alive().length, 1);
    assert.equal(audit.uncertain, false);
    assert.ok(audit.owned.has(`${gitChild.pid}:${gitChild.created}`));
  });

  test(`${name}: 고아·외부 조상 없는 콘솔은 불확실하며 이후 증거가 있어도 과거 불확실을 지우지 않는다`, () => {
    const audit = observed();
    const console = row(7777, 6000, 7000, 'conhost.exe');
    audit.observe([supervisor, external, console]);
    assert.equal(audit.uncertain, true);
    assert.equal(audit.uncertainProcesses.size, 1);
    assert.deepEqual(
      audit.uncertainProcesses.get(`${console.pid}:${console.created}`)?.observedParent,
      null,
    );
    audit.observe([supervisor, external, reused, gitChild]);
    assert.equal(audit.uncertain, true);
    assert.equal(audit.uncertainProcesses.size, 1);
    assert.deepEqual(audit.alive(), []);
  });

  test(`${name}: 정상 외부 콘솔만 제외하며 미확인 상위 PID의 증거는 최대16개 보존한다`, () => {
    const audit = observed();
    const console = row(7777, reused.pid, 6000, 'OpenConsole.exe');
    audit.observe([supervisor, external, reused, console]);
    assert.equal(audit.uncertain, false);
    const unknown = Array.from({ length: 25 }, (_, index) =>
      row(30000 + index, oldCli.pid, 8000 + index, 'git.exe'),
    );
    audit.observe([supervisor, external, ...unknown]);
    assert.equal(audit.uncertain, true);
    assert.equal(audit.uncertainProcesses.size, 16);
    assert.ok([...audit.uncertainProcesses.values()].every((item) => item.observedParent === null));
    assert.equal(audit.owned.size, 2);
    assert.deepEqual(audit.alive(), []);
  });

  test(`${name}: 외부 계보를 확인한 같은 콘솔은 부모가 먼저 종료되어도 불확실로 바뀌지 않는다`, () => {
    for (const consoleName of ['conhost.exe', 'OpenConsole.exe']) {
      const audit = observed();
      const parent = row(6000, external.pid, 2000, 'helper.exe');
      const console = row(7777, parent.pid, 3000, consoleName);
      audit.observe([supervisor, external, parent, console]);
      assert.equal(audit.uncertain, false);
      audit.observe([supervisor, console]);
      assert.equal(audit.uncertain, false, '이미 확인한 PID와 생성 시각의 외부 증거를 보존한다');
      assert.equal(audit.uncertainProcesses.size, 0);
      assert.equal(audit.owned.size, 2, '외부 콘솔을 종료할 소유 프로세스로 취급하지 않는다');
      assert.deepEqual(audit.alive(), []);
    }
  });

  test(`${name}: 확인한 외부 콘솔의 PID를 새 콘솔이 재사용해도 이전 증거를 적용하지 않는다`, () => {
    const audit = observed();
    const parent = row(6000, external.pid, 2000, 'helper.exe');
    const console = row(7777, parent.pid, 3000, 'conhost.exe');
    audit.observe([supervisor, external, parent, console]);
    assert.equal(audit.uncertain, false);
    const reusedConsole = row(console.pid, 8888, 4000, 'conhost.exe');
    audit.observe([supervisor, reusedConsole]);
    assert.equal(audit.uncertain, true);
    assert.ok(audit.uncertainProcesses.has(`${reusedConsole.pid}:${reusedConsole.created}`));
    assert.equal(audit.owned.size, 2);
  });

  test(`${name}: 외부 부모만 먼저 관측한 증거로 처음 보는 고아 콘솔을 제외하지 않는다`, () => {
    const audit = observed();
    const parent = row(6000, external.pid, 2000, 'helper.exe');
    const console = row(7777, parent.pid, 3000, 'conhost.exe');
    audit.observe([supervisor, external, parent]);
    audit.observe([supervisor, console]);
    assert.equal(audit.uncertain, true);
    assert.equal(
      audit.uncertainProcesses.get(`${console.pid}:${console.created}`)?.observedParent,
      null,
    );
    assert.equal(audit.owned.size, 2);
  });

  test(`${name}: 같은 고아 콘솔의 외부 계보를 나중에 알아도 이전 불확실 판정은 보존한다`, () => {
    const audit = observed();
    const parent = row(6000, external.pid, 2000, 'helper.exe');
    const console = row(7777, parent.pid, 3000, 'conhost.exe');
    const key = `${console.pid}:${console.created}`;
    audit.observe([supervisor, console]);
    assert.equal(audit.uncertain, true);
    const evidence = audit.uncertainProcesses.get(key);
    assert.ok(evidence);
    assert.equal(evidence.observedParent, null);
    audit.observe([supervisor, external, parent, console]);
    audit.observe([supervisor, console]);
    assert.equal(audit.uncertain, true);
    assert.deepEqual(audit.uncertainProcesses.get(key), evidence);
    assert.equal(audit.owned.size, 2);
  });

  test(`${name}: 실제 소유 계보가 관측되면 기존 외부 콘솔 증거보다 우선하여 계속 추적한다`, () => {
    const audit = observed();
    const parent = row(6000, external.pid, 2000, 'helper.exe');
    const console = row(7777, parent.pid, 3000, 'conhost.exe');
    const key = `${console.pid}:${console.created}`;
    audit.observe([supervisor, external, parent, console]);
    assert.equal(audit.owned.has(key), false);
    audit.observe([supervisor, owner, { ...console, parent: owner.pid }]);
    assert.ok(audit.owned.has(key));
    audit.observe([supervisor, external, parent, console]);
    assert.ok(audit.owned.has(key), '한 번 관측한 소유 프로세스는 외부 증거로 숨기지 않는다');
    assert.equal(audit.alive().length, 1);
    assert.equal(audit.uncertain, false);
  });

  test(`${name}: 확인한 외부 콘솔을 근거로 계보가 끊긴 새 자식 콘솔까지 제외하지 않는다`, () => {
    const audit = observed();
    const parent = row(6000, external.pid, 2000, 'helper.exe');
    const console = row(7777, parent.pid, 3000, 'conhost.exe');
    const child = row(8888, console.pid, 4000, 'conhost.exe');
    audit.observe([supervisor, external, parent, console]);
    audit.observe([supervisor, console, child]);
    assert.equal(audit.uncertain, true);
    assert.deepEqual([...audit.uncertainProcesses.keys()], [`${child.pid}:${child.created}`]);
    assert.equal(audit.owned.size, 2);
  });
}
