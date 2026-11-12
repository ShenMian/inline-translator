import type { Settings } from '../lib/settings';
import { edge } from './edge';
import { google } from './google';
import { createOpenAI } from './openai';
import type { TranslateService } from './types';

export function getService(settings: Settings): TranslateService {
  switch (settings.service) {
    case 'edge':
      return edge;
    case 'openai':
      return createOpenAI(settings.openai);
    default:
      return google;
  }
}

export type { TranslateService } from './types';
export { ServiceError } from './types';