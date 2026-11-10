# Capstone-project · ORBIT 프로토타입

터미널 AI의 요구분석·기능 관리·실행·기록을 연결하고, Windows OS 파일 보호와 같은 네트워크의 기기 간 파일 전송을 목표로 하는 졸업작품이다.

Electron·React·TypeScript로 프로젝트 선택 → AI 연결·보호 설정 → 요구분석 → 기능 확정 → 작업 대시보드 화면을 구현했다. **실제 폴더에서 Codex와 목표·질문·답변을 정리하고, 생성한 기능 초안을 편집한 뒤 저장할 수 있다. 프로젝트·기능·수동 검증 기록은 재시작 후 복원한다.** 기능별 AI 세션·대화 이력 저장·OS 보호·파일 전송·앱의 여러 AI 연결은 후속 개발이다.

## 실행하기

Node.js 24.15 이상 25 미만, Windows PowerShell 기준이다.

```powershell
npm.cmd ci
npm.cmd run setup:electron
npm.cmd run dev
```

‘예시 열기’를 누르면 현재 창에서 화면 흐름을 체험할 수 있다. 실제 프로젝트의 폴더 선택은 확정 때, 이름은 ‘이 프로젝트로 시작’ 때 저장된다. 요구분석 대화·입력과 미적용 초안은 현재 창에 유지하고, 적용한 기능은 SQLite에 저장한다. 빌드 실행은 `npm.cmd run build` 후 `npm.cmd start`다. [화면·실행·검사 안내](docs/UI_PROTOTYPE.md)에 구현 범위와 검증 한계를 정리했다.

실제 폴더 선택 → ‘이 프로젝트로 시작’ → ‘AI로 요구분석 시작’ → ‘연결 준비 확인’ → 목표를 보낸다. 답변·정정 후 ‘대화로 기능 초안 만들기’에서 편집·적용한다. 현재 검증 조합은 Windows x64·Codex 0.162.1·기존 ChatGPT 로그인이다. [요구분석·초안 사용 방법](docs/REQUIREMENTS.md)과 [일반 AI 대화 안내](docs/AI_CONNECTION.md)를 따른다.

인증된 로컬 통신은 연결 복구와 중복·오래된 실행 요청 거부를 제공한다([로컬 API](docs/LOCAL_API.md)). 프로젝트 백업·복원, 기능 묶음·선행 관계·완료 조건·현재 조건의 수동 검증과 진행률을 연결했다([저장 안내](docs/PROJECT_STORAGE.md), [검증 안내](docs/VERIFICATION.md)). 실제 완료·남은 범위와 다음 T-011은 STATUS를 따른다.

**작업 저장소:** `C:/Users/jbiho/dev/Capstone-project` · **통합 작업 브랜치:** `feat/t-009-requirements-dialogue`. 개발 Codex별 별도 브랜치·폴더와 소유 범위는 [병렬 분담표](docs/PARALLEL_DEVELOPMENT.md)에 기록한다. T-002 실제 폴더 창 선택·취소 유지는 사용자 확인이며 최신 자동 검사와 구분한다. 최신 검증과 Git 결과는 [STATUS](docs/STATUS.md)를 따른다.

## 읽는 순서

1. [현재 상태와 다음 작업](docs/STATUS.md)
2. [목표·요구사항·출처·미정 사항](docs/PROJECT_OVERVIEW.md)
4. [작업별 완료·검증 기준과 요구사항 추적](docs/TASKS.md)
5. 필요할 때 [구조·기술 실험](docs/ARCHITECTURE.md), [AI 협업·모델·기록](docs/AI_WORKFLOW.md), [Git·개발·복구 규칙](docs/DEVELOPMENT_RULES.md)
6. 개발 준비에는 [T-001 환경·CLI·버전 후보 결과](docs/ENVIRONMENT.md)
7. [이번 실제 작업 기록](docs/work-log/2026-10-04.md)
8. AI 사용 실험은 [X-001 결과](docs/experiments/X-001.md) → [실행 방법](experiments/x-001-ai-terminal/README.md)

AI 시작 지침은 [AGENTS.md](AGENTS.md), 독립 검토 지침은 [GEMINI.md](GEMINI.md)에 있다.

## 기준 자료

- [Notion 졸업작품 기획](https://app.notion.com/p/3e86817a257180cea8bed02a973ad970)
- [대상 GitHub 저장소](https://github.com/pensionbeen/Capstone-project)

