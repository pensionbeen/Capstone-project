import assert from 'node:assert/strict';
import test from 'node:test';
import { promptIsValid } from '../dist/desktop/electron/ai/contracts.js';
import { requirementsPrompt, validRequirementsInput } from '../shared/requirements.ts';

test('요구분석 목표·답변은 길이와 제어문자를 검사하고 한글 줄바꿈을 보존한다', () => {
  for (const action of ['start', 'revise-goal', 'answer'] as const) {
    const limit = action === 'answer' ? 6000 : 2000;
    assert.equal(validRequirementsInput(action, '가'.repeat(limit)), true);
    assert.equal(validRequirementsInput(action, '가'.repeat(limit + 1)), false);
    assert.equal(promptIsValid(requirementsPrompt(action, '가'.repeat(limit))), true);
    for (const invalid of ['', ' \n ', '\u0003중단', '\u001b[31m', '\u007f', null, 1])
      assert.equal(validRequirementsInput(action, invalid), false);
  }
  assert.equal(validRequirementsInput('execute', '명령'), false);
  const input = '--옵션\n한글 "답변"\t$(literal)';
  assert.equal(validRequirementsInput('answer', input), true);
  assert.ok(requirementsPrompt('answer', input).endsWith(`\n${input}`));
  assert.match(requirementsPrompt('revise-goal', '새 목표'), /이전 목표보다 이 내용을 우선/u);
});
