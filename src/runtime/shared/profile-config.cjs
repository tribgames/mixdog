'use strict';

// One catalog and normalizer for settings and prompt generation. "system"
// leaves locale resolution to the prompt builder.
const PROFILE_LANGUAGES = Object.freeze([
  { id: 'system', label: 'System (locale)', prompt: null },
  { id: 'en', label: 'English', prompt: 'English' },
  { id: 'ko', label: 'Korean', prompt: 'Korean' },
  { id: 'ja', label: '日本語', prompt: 'Japanese (日本語)' },
  { id: 'zh-Hans', label: '中文（简体）', prompt: 'Simplified Chinese (简体中文)' },
  { id: 'zh-Hant', label: '中文（繁體）', prompt: 'Traditional Chinese (繁體中文)' },
  { id: 'es', label: 'Español', prompt: 'Spanish (Español)' },
  { id: 'fr', label: 'Français', prompt: 'French (Français)' },
  { id: 'de', label: 'Deutsch', prompt: 'German (Deutsch)' },
  { id: 'pt', label: 'Português', prompt: 'Portuguese (Português)' },
  { id: 'ru', label: 'Русский', prompt: 'Russian (Русский)' },
  { id: 'it', label: 'Italiano', prompt: 'Italian (Italiano)' },
  { id: 'vi', label: 'Tiếng Việt', prompt: 'Vietnamese (Tiếng Việt)' },
  { id: 'th', label: 'ภาษาไทย', prompt: 'Thai (ภาษาไทย)' },
  { id: 'id', label: 'Bahasa Indonesia', prompt: 'Indonesian (Bahasa Indonesia)' },
  { id: 'hi', label: 'हिन्दी', prompt: 'Hindi (हिन्दी)' },
  { id: 'ar', label: 'العربية', prompt: 'Arabic (العربية)' },
  { id: 'tr', label: 'Türkçe', prompt: 'Turkish (Türkçe)' },
  { id: 'pl', label: 'Polski', prompt: 'Polish (Polski)' },
  { id: 'nl', label: 'Nederlands', prompt: 'Dutch (Nederlands)' },
  { id: 'uk', label: 'Українська', prompt: 'Ukrainian (Українська)' },
]);

const PROFILE_EXPERIENCE_LEVELS = Object.freeze([
  { id: 'beginner', label: 'Beginner' },
  { id: 'vibe-coder', label: 'Vibe coder' },
  { id: 'junior', label: 'Junior' },
  { id: 'expert', label: 'Expert' },
]);

const PROFILE_EXPERIENCE_PROMPTS = Object.freeze({
  beginner:
    'Assume no development background; briefly explain only the terms and prerequisites needed to understand the answer.',
  'vibe-coder':
    'Lead with what the result does and how to use it; briefly unpack implementation jargon when it is needed for understanding.',
  junior:
    'Assume basic development knowledge; make otherwise implicit connections clear when they are needed for easy understanding.',
  expert:
    'Do not unnecessarily unpack familiar basics, but preserve the explanations needed for accurate understanding and judgment. Use familiar technical terminology naturally.',
});

const PROFILE_LANGUAGE_IDS = new Set(PROFILE_LANGUAGES.map((lang) => lang.id));
const PROFILE_EXPERIENCE_LEVEL_IDS = new Set(PROFILE_EXPERIENCE_LEVELS.map((level) => level.id));
const PROFILE_TITLE_MAX = 64;

function normalizeProfileConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const title = String(raw.title ?? raw.name ?? '')
    .trim()
    .slice(0, PROFILE_TITLE_MAX);
  const requested = String(raw.language ?? raw.lang ?? 'system').trim();
  const language = PROFILE_LANGUAGE_IDS.has(requested) ? requested : 'system';
  const requestedExperienceLevel = String(raw.experienceLevel ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const experienceLevel = PROFILE_EXPERIENCE_LEVEL_IDS.has(requestedExperienceLevel) ? requestedExperienceLevel : '';
  return { title, language, experienceLevel };
}

function profileLanguageEntry(languageId) {
  const id = String(languageId || 'system');
  return PROFILE_LANGUAGES.find((lang) => lang.id === id) || PROFILE_LANGUAGES[0];
}

function profileExperienceLevelEntry(experienceLevelId) {
  const id = String(experienceLevelId || '');
  return PROFILE_EXPERIENCE_LEVELS.find((level) => level.id === id) || null;
}

module.exports = {
  PROFILE_LANGUAGES,
  PROFILE_EXPERIENCE_LEVELS,
  PROFILE_EXPERIENCE_PROMPTS,
  normalizeProfileConfig,
  profileLanguageEntry,
  profileExperienceLevelEntry,
};
