import { useId, useState } from 'react';
import { type ProtectionDraft, validProtectionPath } from '../model';
import { Button, Icon } from './ui';

export function ProtectionEditor({
  draft,
  onSave,
}: {
  draft: ProtectionDraft;
  onSave: (value: ProtectionDraft) => void;
}) {
  const inputId = useId();
  const [paths, setPaths] = useState(draft.paths.join('\n'));
  const [flags, setFlags] = useState({
    read: draft.read,
    write: draft.write,
    remove: draft.remove,
  });
  const [message, setMessage] = useState('');
  function save() {
    const values = [
      ...new Set(
        paths
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (values.length > 30 || values.some((path) => !validProtectionPath(path))) {
      setMessage(
        '프로젝트 안의 상대 경로를 30개 이내로 입력해 주세요. 상위 폴더(..)나 절대 경로는 사용할 수 없어요.',
      );
      return;
    }
    onSave({ paths: values, ...flags });
    setMessage('이 창에 설정안을 저장했어요. 실제 보호는 아직 적용되지 않았어요.');
  }
  return (
    <div className="protection-editor">
      <label className="field-label" htmlFor={inputId}>
        보호할 파일·폴더
      </label>
      <textarea
        id={inputId}
        rows={4}
        value={paths}
        onChange={(event) => {
          setPaths(event.target.value);
          setMessage('');
        }}
        maxLength={6000}
        placeholder={'.env\nsecrets/'}
        aria-describedby={`${inputId}-hint`}
      />
      <p id={`${inputId}-hint`} className="field-hint">
        프로젝트 폴더를 기준으로 한 줄에 하나씩 입력해 주세요.
      </p>
      <fieldset className="inline-checks">
        <legend>제한할 동작</legend>
        {(['read', 'write', 'remove'] as const).map((key) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={flags[key]}
              onChange={(event) => setFlags({ ...flags, [key]: event.target.checked })}
            />
            {{ read: '읽기', write: '수정', remove: '삭제' }[key]}
          </label>
        ))}
      </fieldset>
      <div className="form-actions">
        <Button variant="secondary" onClick={save}>
          설정안 저장
        </Button>
        <span className="subtle-label">
          <Icon name="lock" size={14} /> 적용 전
        </span>
      </div>
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
