# 병렬 개발 분담 — 2026-10-12

최신 사용자 지시: 주담당 Codex가 총괄하고 개발은 여러 Codex가 별도 worktree·브랜치에서 병렬 진행한다. 독립 검토는 Gemini가 읽기 전용으로 맡는다. 같은 작업 폴더의 수정자는 하나이며 노션·공통 기록·통합·푸시는 총괄만 수행한다. main 병합 금지와 기능 마무리 뒤 한 번 일반 push 규칙은 유지한다.

T-009의 보존된 구현과 재개 수정을 기능 완료가 아닌 통합 출발점으로 로컬 커밋한다. 시작 당시 미커밋20파일과 이번 추가 변경을 초기화하지 않는다. Gemini 호환성 미검증3파일과 실패 잠금은 별도로 보존한다.

| 담당 | 독립 작업·브랜치 | 수정 소유 범위 |
|---|---|---|
| 총괄 Codex | T-009 실제 연결·실패 검사, T-010 AI/API/화면 통합, Gemini 검토, 기록 | electron/, shared/ai.ts·desktop.ts·requirements.ts, src/App.tsx, tests/ui/ai.spec.ts, scripts/test-app-impact.mjs, 공통 문서 |
| Codex UX | feat/t-009-requirements-ux | src/components/AIConsole.tsx, src/pages/Requirements.tsx, src/styles.css, 전용 UX 검사 |
| Codex 기능 검사 | feat/t-010-generation-validation | shared/feature-generation.ts, tests/feature-generation.test.ts |
| Codex 미리보기 | feat/t-010-generation-preview | src/components/FeatureDraftPreview.tsx, 전용 CSS·검사 |
| Codex 프로세스 감시 후속 | fix/m4-process-ownership | electron/ai/process-audit.ts, experiments/x-001-ai-terminal/managed-processes.mjs, tests/process-ownership.test.ts. 기존 기능 검사 담당이 반환 뒤 별도 폴더에서 수행 |

작업 폴더는 .runtime/worktrees 아래에 각각 둔다. 기존 의존성 설치본을 참조하되 설치·lockfile·전역 설정을 바꾸지 않는다. 각 담당은 자기 폴더에서만 수정·로컬 커밋하며 push·main 병합·공통 문서 변경을 하지 않는다. Electron/실제 AI 검사는 총괄이 실행 순서를 배정하며 소스 개발·순수 로직 검사는 병렬로 수행한다.

공통 인터페이스는 shared/feature-generation-contract.ts다. AI 응답은 key·parentKey 기반 기능/관계 JSON만 받아 검증 후 새 UUID로 바꾼다. 검증 기록이나 완료 상태를 AI가 생성하지 않는다. 파서는 parseGeneratedPlan(text, createId), 적용 준비는 appendGeneratedPlan(current, candidate)로 GeneratedPlanResult를 반환한다. 기존 기능과 검증은 유지하고 새 기능을 추가하며 사용자의 적용 전 저장하지 않는다.

미리보기 컴포넌트는 FeatureDraftPreviewProps로 편집·제외·추가·삭제·적용 취소를 제공한다. DB·IPC는 직접 호출하지 않는다. 요구분석 페이지는 선택적인 children 위치를 제공하여 총괄이 생성 패널을 연결한다. 인터페이스 변경이 필요하면 먼저 총괄과 조정한다.

통합 순서: T-009 실행 계약 확인 → 기능 응답 검사 → 미리보기 연결 → 실제 AI 생성·편집·SQLite 저장/재시작·실패 보존 검사. UX 개선은 별도 확인 후 함께 통합한다. Gemini는 새 버전·실제 읽기/쓰기/명령 거부·설정/파일 불변·잔존 프로세스 확인 후 사용한다. 이전 Astra 검토는 전환 이전 이력으로 남긴다.

노션 기획·일정·현황을 재조회했다. 원래 일정의 M2 체크와 최신 저장소의 보호 미구현 상태는 다르므로 실제 완료 판정은 STATUS·검증 근거를 따른다. 기획의 핵심 요구와 원문 기록은 보존한다.

## 결과 회수·통합

시작 보존 커밋은 2a58c708f94836c03870bec2693a314b692eece3이며 기존 미커밋20파일의 사본과 패치를 .runtime에 보관했다. 완료를 선언하는 커밋이 아닌 분담 기준이다. 아래 개발 담당은 Codex의 GPT-6.1 Sol/High를 요청했으며 실행 모델 메타데이터는 독립 미확인이다.

| Codex 담당 | 작업 폴더 (.runtime/worktrees 아래) | 원본 로컬 커밋 | 총괄 브랜치 회수 커밋 |
|---|---|---|---|
| 요구분석 UX | requirements-ux | beec1b883f79757561fa3d6fc7666814de7d5f9f | f36bcbb743112936b65b16d517bc44bfbc7e6c5b |
| 생성 응답 검사 | generation-validation | 0de0e73f38c4645e56cbf38882ce4a392cbab81a | c6a2f4b |
| 미리보기 편집 | generation-preview | e3b8d18f8b1690f73005ece8e2fd233a778fce85 | 63763a7 |
| 프로세스 식별 보강 | process-audit | e74aa135cc82a66ad02e915a93d8d9c79d3596b6 | 86b19d9 |

각 담당의 수정 종료·파일 목록·검사 결과를 받고, 담당 AI와 변경 내용을 사용자에게 알린 후 로컬 커밋을 허용했다. 소유권 반환 뒤 총괄이 순서대로 cherry-pick하여 통합했다. 서로 다른 브랜치·폴더였고 파일 충돌은 없었다. 총괄은 반환된 UI 파일에 실행 중 잠금 전달을 연결했고 앱 API·IPC·세션·최종 저장 연결과 통합 검사를 맡았다. 보조는 공통 기록·Notion·push를 수행하지 않았다.

프로세스 후속은 정상 종료한 AI의 PID를 외부 git 프로세스가 재사용한 실제 관측에서 시작했다. PID만 같다는 이유로 현재 외부 자식을 AI 후손으로 의심하던 경로에 생성 시각·현재 부모·완전한 외부 계보 대조를 추가했다. 관측이 부족한 고아 프로세스는 계속 미확인으로 두며 다른 프로세스를 종료하지 않는다.

worktree는 보존하고 네 작업 폴더 모두 미커밋 변경이 없음을 최종 확인했다. 같은 설치본을 참조하는 node_modules 연결을 삭제하거나 따라가며 정리하지 않는다. Biome은 중첩 worktree의 설정을 별도 프로젝트로 읽지 않도록 공식 force-ignore 구문으로 .runtime 전체를 제외한다([설정 근거](https://biomejs.dev/reference/configuration/#filesincludes)). 의존성 버전·lockfile은 바꾸지 않았다.

앱 검증·Gemini 검토·미해결 범위는 [WL-20261012-03](work-log/2026-10-12.md)과 [검토표](reviews/2026-10-12-m4.md), 최종 통합 브랜치는 feat/t-009-requirements-dialogue다. 사용자 요청 이후 커밋·push 사전 안내 규칙을 적용하며 main 병합은 하지 않는다.
