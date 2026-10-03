# Codex 작업 규칙

한국어로 설명하고 어려운 용어는 풀어 쓴다. 역할은 설계 정리·구현·테스트·수정·통합이다.

## 매 작업 시작

1. [현재 상태](docs/STATUS.md)와 거기서 지정한 최신 날짜의 작업 기록을 읽는다. 최초 기록은 [2026-10-03](docs/work-log/2026-10-03.md)이다.
2. 현재 경로·Git 루트·원격·브랜치·미커밋 변경을 확인한다. 대상은 pensionbeen/Capstone-project다.
3. 맡은 작업 ID를 [TASKS](docs/TASKS.md)에서 읽고 선행 조건·완료 조건을 확인한다.
4. 같은 작업 폴더의 수정 담당 AI는 하나다. 다른 사람의 미커밋 변경은 보존한다.

## 작업별 참조

- 요구사항·범위·출처: [PROJECT_OVERVIEW](docs/PROJECT_OVERVIEW.md)
- 구조·보안·저장·기술 실험: [ARCHITECTURE](docs/ARCHITECTURE.md)
- 순서·공수·마감: [ROADMAP](docs/ROADMAP.md)
- 모델·검토·인수인계·기록: [AI_WORKFLOW](docs/AI_WORKFLOW.md)
- 코드 또는 Git 변경: [DEVELOPMENT_RULES](docs/DEVELOPMENT_RULES.md)

항상 모든 문서를 다시 읽지는 않는다. 공통 규칙의 원문은 AI_WORKFLOW와 DEVELOPMENT_RULES다.

## 반드시 지킬 경계

- 목표·설계안·실제 구현·검증·사용자 결정을 구분한다. 코드나 AI의 완료 발언만으로 완료 처리하지 않는다.
- 핵심 요구 변경, 중요한 위험 수용, 최종 시연·제출 범위는 사용자 결정이다. 일반 작업마다 별도 승인을 요구하지 않는다.
- 기능별 브랜치·목적별 작은 커밋·검증 후 원격 푸시를 사용한다. 비밀정보·실행 DB·로그·빌드 결과를 커밋하지 않는다.
- 의미 있는 작업·검증·중단·담당 변경 시 STATUS와 날짜별 작업 기록을 갱신한다. Notion은 실제 반영을 확인한 뒤 동기화 완료로 표시한다.
- 이번 문서 작업의 허용 범위는 조사·질문·계획·Markdown·Notion 기록·docs/project-plan 커밋·푸시다. 기능 구현·패키지 설치·시스템 보안 변경·main 병합은 포함하지 않는다. 다음 개발 요청의 범위는 새로 확인한다.
