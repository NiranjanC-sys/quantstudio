/**
 * Plain TypeScript aliases for the enums the Zod schemas define, so authoring
 * files can import a type without pulling in the schema objects.
 */

import type { z } from 'zod';
import type {
  DifficultySchema,
  LanguageSchema,
  LessonTypeSchema,
  LevelSchema,
} from './schema.js';

export type LessonType = z.infer<typeof LessonTypeSchema>;
export type Level = z.infer<typeof LevelSchema>;
export type Difficulty = z.infer<typeof DifficultySchema>;
export type Language = z.infer<typeof LanguageSchema>;
