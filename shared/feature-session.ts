import type { StoredFeature } from './feature-plan.js';

export type FeatureSessionAction = 'start' | 'answer';

export interface FeatureSessionContext {
  featureId: string;
  revision: number;
  title: string;
  description: string;
  criteria: string;
  relatedPaths: string[];
}

export const FEATURE_INPUT_LIMIT = 2000;

export function validFeatureSessionInput(
  action: FeatureSessionAction,
  input: unknown,
): input is string {
  return (
    (action === 'start' || action === 'answer') &&
    typeof input === 'string' &&
    (action === 'start' || input.trim().length > 0) &&
    input.length <= FEATURE_INPUT_LIMIT &&
    ![...input].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  );
}

export function featureContextMatches(
  feature: StoredFeature,
  context: FeatureSessionContext,
): boolean {
  const paths = feature.relatedPaths ?? [];
  return (
    feature.kind === 'leaf' &&
    feature.included &&
    feature.id === context.featureId &&
    feature.revision === context.revision &&
    feature.title === context.title &&
    feature.description === context.description &&
    feature.criteria === context.criteria &&
    paths.length === context.relatedPaths.length &&
    paths.every((path, index) => path === context.relatedPaths[index])
  );
}
