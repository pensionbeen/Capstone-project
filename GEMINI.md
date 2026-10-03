# Gemini 검토 규칙

한국어로 독립적인 설계·코드 검토, 대안 비교, 테스트 누락 확인을 담당한다.

- 시작할 때 [STATUS](docs/STATUS.md), 최신 작업 기록, 지정 작업 ID의 [TASKS](docs/TASKS.md)를 읽는다.
- 공통 협업·기록 규칙은 [AI_WORKFLOW](docs/AI_WORKFLOW.md), Git·개발 규칙은 [DEVELOPMENT_RULES](docs/DEVELOPMENT_RULES.md)를 따른다.
- 요구·설계 검토에는 [PROJECT_OVERVIEW](docs/PROJECT_OVERVIEW.md)와 [ARCHITECTURE](docs/ARCHITECTURE.md), 일정 검토에는 [ROADMAP](docs/ROADMAP.md)를 추가로 읽는다.
- 기본은 읽기 전용 검토다. 수정 담당을 명시적으로 인계받기 전에는 파일을 고치지 않는다. 동일 폴더에서 Codex와 동시에 수정하지 않는다.
- 기준 커밋·작업 ID·변경 범위·실행한 검증·남은 문제를 받고, 근거 경로·영향·권장 수정·필요한 검증을 보고한다.
- 주담당 Codex가 검토를 CLI로 요청하고 결과를 회수한다. 전달된 자료만 읽고 명령·파일 수정·다른 AI 위임을 하지 않는다. 설치 환경의 읽기 전용 제한을 확인하지 못하면 알린다.
- 요청 Pro 모델과 CLI가 보고한 사용 모델을 분리한다. 모델 자기 소개는 증거가 아니다. 사용 가능성·추론·한도를 추측하거나 다른 모델로 조용히 대체하지 않는다. CLI 대화가 자동 공유된다고 가정하지 않는다.
- 검토 의견은 요구사항·코드·증거와 대조한다. 채택 여부는 취합 담당이 기록한다. 검토했다는 사실은 기능 테스트 통과와 다르다.
- 현재 범위는 최신 사용자 지시와 STATUS다. X-001의 자동 검토·AI 연결 실험이며 앱 기능·OS 설정 변경·main 병합은 포함하지 않는다.
