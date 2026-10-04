# Capstone-project · ORBIT UI 프로토타입

터미널 AI의 요구분석·기능 관리·실행·기록을 연결하고, Windows OS 파일 보호와 같은 네트워크의 기기 간 파일 전송을 목표로 하는 졸업작품이다.

Electron·React·TypeScript로 프로젝트 선택 → AI 연결·보호 설정 → 요구분석 → 기능 확정 → 작업 대시보드 화면을 구현했다. 흰색·연한 회색·파란색으로 구성한 미니멀 UI다. **AI 응답은 예시이며 실제 AI 연결·OS 보호·파일 전송·영구 저장은 아직 구현하지 않았다.**

## 실행하기

Node.js 24.15 이상 25 미만, Windows PowerShell 기준이다.

```powershell
npm.cmd ci
npm.cmd run setup:electron
npm.cmd run dev
```

‘예시 열기’를 누르면 전체 화면 흐름을 체험할 수 있다. 입력은 현재 실행에만 유지된다. 빌드 실행은 `npm.cmd run build` 후 `npm.cmd start`다. [화면·실행·검사 안내](docs/UI_PROTOTYPE.md)에 구현 범위와 검증 한계를 정리했다.

**작업 저장소:** `C:/Users/jbiho/dev/Capstone-project` · **UI 작업 브랜치:** `feat/t-002-prototype-ui`. T-002의 실제 Windows 폴더 창 조작 확인은 남아 있다. 최신 상태와 Git 결과는 [STATUS](docs/STATUS.md)를 따른다.

## 읽는 순서

1. [현재 상태와 다음 작업](docs/STATUS.md)
2. [목표·요구사항·출처·미정 사항](docs/PROJECT_OVERVIEW.md)
3. [프로토타입부터 최종 제출까지 로드맵](docs/ROADMAP.md)
4. [작업별 완료·검증 기준과 요구사항 추적](docs/TASKS.md)
5. 필요할 때 [구조·기술 실험](docs/ARCHITECTURE.md), [AI 협업·모델·기록](docs/AI_WORKFLOW.md), [Git·개발·복구 규칙](docs/DEVELOPMENT_RULES.md)
6. 개발 준비에는 [T-001 환경·CLI·버전 후보 결과](docs/ENVIRONMENT.md)
7. [이번 실제 작업 기록](docs/work-log/2026-10-04.md)
8. AI 자동 운영 실험은 [X-001 결과](docs/experiments/X-001.md) → [실행 방법](experiments/x-001-ai-terminal/README.md)

AI 시작 지침은 [AGENTS.md](AGENTS.md), 독립 검토 지침은 [GEMINI.md](GEMINI.md)에 있다.

## 기준 자료

- [Notion 졸업작품 기획](https://app.notion.com/p/3e86817a257180cea8bed02a973ad970)
- [기존 프로토타입 일정](https://app.notion.com/p/3e96817a25718139b6b8ccf190650aa4)
- [개발 현황·작업 기록](https://app.notion.com/p/3ee6817a2571813fb2dbe1f99ad69a59)
- [대상 GitHub 저장소](https://github.com/pensionbeen/Capstone-project)

프로토타입 내부 마감은 **2026-10-19 23:59 KST**이며 학교 최종 제출일은 미정이다. 문서의 계획·실제 구현·검증 완료를 구분한다.
