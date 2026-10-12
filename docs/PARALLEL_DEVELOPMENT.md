# 병렬 개발 분담 — 2026-10-12

## T-011·X-002 후속 분담 계약

사용자의 후속 지시에 따라 총괄은 범위·공통 연결 규약·회수·통합 검증·Gemini 의견 대조·기록을 관리하고, 실제 개발은 아래 Codex 담당에게 맡긴다. 출발점은 미커밋 변경이 없는 d77b4fb21d49ec2818283ab0df618b7fc992d311이다. 이전 작업 폴더·브랜치·기록은 보존한다. 두 기기 전송 X-003은 사용자 지시로 보류한다.

| 담당 | 브랜치 / 작업 폴더 (.runtime/worktrees 아래) | 수정 소유 범위 |
|---|---|---|
| 총괄 Codex | feat/t-011-feature-sessions / 저장소 루트 | 공통 문서·검토 전달물·통합 검사. 제품 코드 수정은 담당에게 반환 |
| Codex 실행 담당 | feat/t-011-session-runtime / session-runtime | shared/, electron/, 실행·API·경로 관련 tests/*.test.ts. 중요한 실행 경계이므로 Astra/Max 요청 |
| Codex 화면 담당 | feat/t-011-session-ui / session-ui | src/, tests/ui/feature-session.spec.ts. Sol/High 요청 |
| Codex 보호 실험 담당 | spike/x-002-file-access / file-access-experiment | experiments/x-002-file-access/, 해당 worktree의 시험 파일. OS 권한 실험이므로 Astra/Max 요청 |
| Codex 실행 담당의 실패 수정 | fix/x-001-process-observation / review-process-observation | 앱·검토 감시기의 외부 콘솔 식별 보존, 관련 검사와 실험 실행기의 제한된 자기 조회 기록. 기존 실행 worktree 반환 뒤 새 기준 e800537에서 분리 |
| Codex 보호 담당의 VM 준비 | spike/x-002-vm-environment / file-access-vm | a0ae9c5에서 분리한 experiments/x-002-file-access/vm/와 해당 .runtime/vm/만. 기존 실패 소스·산출물 보존, 설치 단계는 총괄이 순서 배정 |

모델 요청 설정과 실제 원격 엔진 신원 확인을 구분한다. 개발 담당은 공통 기록·Notion·push를 하지 않는다. 로컬 커밋도 총괄에게 파일·검사 결과를 먼저 반환하고, 총괄이 사용자에게 담당 AI와 개발 내용을 알린 뒤 수행한다. 의존성 설치본은 읽기 용도의 연결로 공유하며 설치·lockfile·전역 설정을 변경하지 않는다.

공통 규약은 실행 담당이 소유하는 shared/feature-session.ts다. FeatureSessionContext는 featureId·revision·title·description·criteria·relatedPaths이며, AISnapshot에 purpose=feature와 featureContext를 추가한다. sendFeaturePrompt는 projectId·start/answer·featureId·expectedRevision·input·expectedOutputId·expectedRunId만 받는다. 실제 작업 폴더·기능 원문은 신뢰하는 저장소에서 결정한다. 입력 한도는 2,000자이며 처음 시작은 추가 입력 없이 가능하다. 답변 재개는 기능 ID/버전뿐 아니라 원문·관련 경로가 같은지 검사한다. 규약 변경은 양쪽 담당과 총괄이 먼저 조정한다.

T-011은 선행 T-003/T-008/T-010 완료를 기준으로 단일 현재 실행을 기능에 연결한다. 기존 읽기 전용 Codex 정책을 유지하며 실행 종료와 수동 검증 통과를 분리한다. T-012 영구 대화·활동 저장과 T-013 실행 중 요구 변경은 후속이다. 실행 구현과 화면 구현은 병렬이며, 공통 계약 확인 → 결과 회수 → 연결·전체 검사 순서로 통합한다.

X-002는 현재 컴퓨터의 새 시험 폴더·가짜 파일과 제한된 프로세스로 직접/자식 접근 거부·허용 작업·우회·복구를 관측한다. 기존 파일·전역 보안·계정·드라이버 설정 변경은 이 실험 방법에 포함하지 않는다. 부분 성공·실패·미검증을 구분하며 실제 AI/PTY 연결을 포함한 성공 조건이 충족되지 않으면 T-014를 시작하지 않는다. 실험 산출물과 앱 보호 구현 완료는 다르다.

초기화 실패와 호스트의 실행 정책 차단을 조사한 뒤, 사용자가 별도 Windows VM 준비를 승인했다. 이 후속 승인 범위는 VirtualBox 기본판·Windows 하이퍼바이저 플랫폼 준비와 가상 CPU2개·메모리6GiB·최대80GiB 가상 디스크 계획이다. 기존 보안 기능과 실패 산출물을 유지하며 자동 재부팅은 하지 않는다. Windows 평가판 등록은 사용자가 직접 진행한다. 실제 설치·재부팅·게스트 실행 여부는 최신 작업 기록을 따르며, 이 승인 자체를 설치 또는 보호 성공으로 계산하지 않는다.

## T-011·X-002 결과 회수

| Codex 담당·목적 | 담당 브랜치의 원본 커밋 | 총괄 통합 커밋 |
|---|---|---|
| 실행 담당 — 기능 문맥·실행 연결 | 52b9e3404c447d8b8db65787ca7acfbd6382d97c | 2c9e396 |
| 화면 담당 — 기능별 대화 UI | 1b988621be774c0f94aecaad1a5e8c4f19024a9c | cc40020 |
| 화면 담당 — 기존 UI 검사 문구 대조 | 4fd00e71156c2e40f8101b69f2e3f8424a0ef0b3 | a5afb3b |
| 실행 담당 — 이전 stop과 새 준비의 경계 | efe228cde4b9b557d0c10430b08562801be1411c | ee59fec |
| 화면 담당 — 실제 CLI 대화 근거 검사 | 20e0531d05777ae57c7af6d678d40acc04945ba6 | c237dbe |
| 보호 담당 — 가짜 파일 실험·부분 실패 기록 | d30f9f1d828d04ee80c25906080c02b0c2eb599b | 7506f46 |
| 화면 담당 — 대화창 수명 관측 | 8a055868c5a9b219bc04138fc39806b2b1041e74 | e800537 |
| 실행 담당 — 확인된 외부 콘솔 신원 보존 | 543f2c4fa0eb44b265cfe5bd0e9eae6c3569471b | adf651f |
| 실행 담당 — 제한된 자기 조회 진단 기록 | 8c4bbf310962af961574bde34672b6354ab28ae7 | de6111c |
| 보호 담당 — 초기화 실패와 정책 차단 원인 분리 | 3f4525ff513792ef0050e129e44ccb9b0f2e2a72 | a0ae9c5 |
| 보호 담당 — 검증된 설치본 준비·종료 수집·자동 설치 차단 | 0476a689bb6410d443b35e9d18caaed74a04060d | 831ae48 |
| 실행 담당 — Gemini 조회 4초·고정 실패 분류 | 4c0693de4112fd265e7941a11fa2f3532aa391a2 | d88d3b0 |

각 로컬 커밋과 통합 전에 담당 AI·변경 내용·검사 결과·Git 동작을 사용자에게 알렸다. 총괄은 담당자가 반환한 커밋을 순서대로 회수했으며 제품 코드 수정을 해당 담당에게 돌려보냈다. 충돌을 숨기거나 기존 작업 폴더를 초기화하지 않았다. 화면 담당이 참조했던 임시 공통 타입은 별도 사본과 SHA256 일치를 확인한 뒤 지정 파일만 정리했고, 기존 담당 worktree는 보존한다. 실제 CLI·PTY·Gemini 검토와 설치처럼 같은 PC의 프로세스 관측에 영향을 주는 실행은 총괄이 순서를 나누며 소스 개발과 설계는 독립 범위에서 병행한다.

기능 동작과 한계는 [기능별 대화](FEATURE_SESSIONS.md), 실패·의견 채택 근거는 [검토표](reviews/2026-10-12-t011-x002.md), 실제 검증·설치·동기화 결과는 [최신 작업 기록](work-log/2026-10-12.md)을 따른다.

아래는 이전 M4 분담과 결과를 보존한 기록이다.

## M4 분담 계약

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
