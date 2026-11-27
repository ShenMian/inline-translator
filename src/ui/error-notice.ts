export interface ErrorNoticeData {
  message: string;
  retryable?: boolean;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createErrorNotice(doc: Document, onRetry?: () => void) {
  const root = doc.createElement('div');
  root.className = 'ilt-error';
  root.setAttribute('role', 'alert');
  root.setAttribute('aria-atomic', 'true');
  root.hidden = true;

  const message = doc.createElement('span');
  message.className = 'ilt-error-message';

  const retry = doc.createElement('button');
  retry.type = 'button';
  retry.className = 'ilt-error-retry';
  retry.textContent = 'Retry';
  retry.hidden = true;
  retry.addEventListener('click', onRetry ?? (() => {}));

  root.append(message, retry);

  const render = (error: ErrorNoticeData | null) => {
    root.hidden = !error?.message;
    message.textContent = error?.message ?? '';
    retry.hidden = !onRetry || !error?.retryable;
  };

  return { root, render };
}
