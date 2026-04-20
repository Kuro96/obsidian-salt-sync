export type ExternalEditPolicy = 'always' | 'closed-only' | 'never';

export interface ExternalEditPolicyDecision {
  allowed: boolean;
  deferred: boolean;
  reason: 'allowed' | 'policy-never' | 'policy-closed-only-open-file';
}

export function evaluateExternalEditPolicy(
  policy: ExternalEditPolicy,
  isOpenInEditor: boolean,
): ExternalEditPolicyDecision {
  if (policy === 'never') {
    return {
      allowed: false,
      deferred: false,
      reason: 'policy-never',
    };
  }

  if (policy === 'closed-only' && isOpenInEditor) {
    return {
      allowed: false,
      deferred: true,
      reason: 'policy-closed-only-open-file',
    };
  }

  return {
    allowed: true,
    deferred: false,
    reason: 'allowed',
  };
}
