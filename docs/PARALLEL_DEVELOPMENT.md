# 병렬 개발 분담 — 2026-10-12

최신 사용자 지시: 주담당 Codex가 총괄하고 개발은 여러 Codex가 별도 worktree·브랜치에서 병렬 진행한다. 독립 검토는 Gemini가 읽기 전용으로 맡는다. 같은 작업 폴더의 수정자는 하나이며 노션·공통 기록·통합·푸시는 총괄만 수행한다. main 병합 금지와 기능 마무리 뒤 한 번 일반 push 규칙은 유지한다.

T-009의 보존된 구현과 재개 수정을 기능 완료가 아닌 통합 출발점으로 로컬 커밋한다. 시작 당시 미커밋20파일과 이번 추가 변경을 초기화하지 않는다. Gemini 호환성 미검증3파일과 실패 잠금은 별도로 보존한다.

| 담당 | 독립 작업·브랜치 | 수정 소유 범위 |
|---|---|---|
| 총괄 Codex | T-009 실제 연결·실패 검사, T-010 AI/API/화면 통합, Gemini 검토, 기록 | electron/, shared/ai.ts·desktop.ts·requirements.ts, src/App.tsx, tests/ui/ai.spec.ts, scripts/test-app-impact.mjs, 공통 문서 |
| Codex UX | feat/t-009-requirements-ux | src/components/AIConsole.tsx, src/pages/Requirements.tsx, src/styles.css, 전용 UX 검사 |
| Codex 기능 검사 | feat/t-010-generation-validation | shared/feature-generation.ts, tests/feature-generation.test.ts |
| Codex 미리보기 | feat/t-010-generation-preview | src/components/FeatureDraftPreview.tsx, 전용 CSS·검사 |

작업 폴더는 .runtime/worktrees 아래에 각각 둔다. 기존 의존성 설치본을 참조하되 설치·lockfile·전역 설정을 바꾸지 않는다. 각 담당은 자기 폴더에서만 수정·로컬 커밋하며 push·main 병합·공통 문서 변경을 하지 않는다. Electron/실제 AI 검사는 총괄이 실행 순서를 배정하며 소스 개발·순수 로직 검사는 병렬로 수행한다.

공통 인터페이스는 shared/feature-generation-contract.ts다. AI 응답은 key·parentKey 기반 기능/관계 JSON만 받아 검증 후 새 UUID로 바꾼다. 검증 기록이나 완료 상태를 AI가 생성하지 않는다. 파서는 parseGeneratedPlan(text, createId), 적용 준비는 appendGeneratedPlan(current, candidate)로 GeneratedPlanResult를 반환한다. 기존 기능과 검증은 유지하고 새 기능을 추가하며 사용자의 적용 전 저장하지 않는다.

미리보기 컴포넌트는 FeatureDraftPreviewProps로 편집·제외·추가·삭제·적용 취소를 제공한다. DB·IPC는 직접 호출하지 않는다. 요구분석 페이지는 선택적인 children 위치를 제공하여 총괄이 생성 패널을 연결한다. 인터페이스 변경이 필요하면 먼저 총괄과 조정한다.

통합 순서: T-009 실행 계약 확인 → 기능 응답 검사 → 미리보기 연결 → 실제 AI 생성·편집·SQLite 저장/재시작·실패 보존 검사. UX 개선은 별도 확인 후 함께 통합한다. Gemini는 새 버전·실제 읽기/쓰기/명령 거부·설정/파일 불변·잔존 프로세스 확인 후 사용한다. 이전 Astra 검토는 전환 이전 이력으로 남긴다.

노션 기획·일정·현황을 재조회했다. 원래 일정의 M2 체크와 최신 저장소의 보호 미구현 상태는 다르므로 실제 완료 판정은 STATUS·검증 근거를 따른다. 기획의 핵심 요구와 원문 기록은 보존한다.
