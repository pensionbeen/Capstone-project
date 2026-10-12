import type { Dispatch, SetStateAction } from 'react';
import type { RequirementsDraft } from '../../shared/requirements';
import { AIConversation } from '../components/AIConsole';
import { Button, Notice, PageHeading } from '../components/ui';
import type { Project } from '../model';

export function RequirementsPage({
  project,
  draft,
  onChange,
  enabled,
  busy,
  onBack,
  onManual,
}: {
  project: Project;
  draft: RequirementsDraft;
  onChange: Dispatch<SetStateAction<RequirementsDraft>>;
  enabled: boolean;
  busy: boolean;
  onBack: () => void;
  onManual: () => void;
}) {
  return (
    <section className="setup-page analysis-page">
      <PageHeading
        eyebrow="03 / DISCOVER"
        title="AI와 요구사항을 정리해요"
        description="아이디어를 보내고, AI의 질문에 답하면서 만들 범위를 구체화해 보세요."
      />
      {!enabled && (
        <Notice>현재 요구분석은 Codex로 연결돼요. 이전 단계에서 Codex를 선택해 주세요.</Notice>
      )}
      <AIConversation project={project} requirements={{ draft, onChange, enabled }} />
      <p className="analysis-disclaimer">
        대화 결과는 기능 목록에 자동 적용되지 않아요. 정리한 내용을 보고 기능과 완료 조건을 직접
        작성할 수 있어요.
      </p>
      <div className="step-footer">
        <Button variant="ghost" onClick={onBack}>
          이전 단계
        </Button>
        <Button onClick={onManual} disabled={busy} icon="arrow">
          기능 직접 정리하기
        </Button>
      </div>
    </section>
  );
}
