import type { ProjectFeaturePlan } from './feature-plan.js';

export interface GeneratedFeatureInput {
  key: string;
  parentKey: string | null;
  kind: 'group' | 'leaf';
  title: string;
  description: string;
  criteria: string[];
  relatedPaths: string[];
}
export interface GeneratedPlanInput {
  features: GeneratedFeatureInput[];
  dependencies: { featureKey: string; prerequisiteKey: string }[];
}
export type GeneratedPlanResult =
  | { ok: true; plan: ProjectFeaturePlan }
  | { ok: false; message: string };

export interface FeatureDraftPreviewProps {
  plan: ProjectFeaturePlan;
  busy: boolean;
  error?: string;
  onChange: (plan: ProjectFeaturePlan) => void;
  onApply: () => void;
  onCancel: () => void;
}
