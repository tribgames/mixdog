import { parseDocument } from 'yaml';

const SKILL_FRONTMATTER_RE =
  /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const scalarText = (value, field) => {
  if (typeof value !== 'string') {
    throw new Error(`Skill ${field} must be a string.`);
  }
  return value.trim();
};

export function validateSkillName(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('Skill name is required.');
  if (name.length > 64) throw new Error('Skill name must be 64 characters or fewer.');
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error('Skill name may contain only lowercase letters, numbers, and hyphens.');
  }
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    throw new Error('Skill name cannot start or end with a hyphen or contain consecutive hyphens.');
  }
  return name;
}

export function validateSkillDescription(value) {
  const description = String(value || '').trim();
  if (!description) throw new Error('Skill description is required.');
  if (description.length > 1024) {
    throw new Error('Skill description must be 1024 characters or fewer.');
  }
  return description;
}

/**
 * `when_to_use` is the optional trigger line shown beside the description in
 * the model's skill listing: trigger phrases and the boundary against a
 * neighbouring skill. Empty means the description alone routes the skill.
 */
export function validateSkillWhenToUse(value) {
  const whenToUse = String(value || '').trim();
  if (whenToUse.length > 1024) {
    throw new Error('Skill trigger must be 1024 characters or fewer.');
  }
  return whenToUse;
}

function optionalScalarText(value, field) {
  if (value == null) return '';
  return scalarText(value, field);
}

function parseFrontmatterDocument(markdown) {
  const source = String(markdown || '');
  const match = source.match(SKILL_FRONTMATTER_RE);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter.');
  const document = parseDocument(match[1], {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) {
    throw new Error(`Invalid SKILL.md frontmatter: ${document.errors[0].message}`);
  }
  const frontmatter = document.toJS({ maxAliasCount: 100 });
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('SKILL.md frontmatter must be a YAML mapping.');
  }
  return { source, match, document, frontmatter };
}

export function parseSkillDocument(markdown) {
  const parsed = parseFrontmatterDocument(markdown);
  const name = validateSkillName(scalarText(parsed.frontmatter.name, 'name'));
  const description = validateSkillDescription(
    scalarText(parsed.frontmatter.description, 'description'),
  );
  const whenToUse = validateSkillWhenToUse(
    optionalScalarText(parsed.frontmatter.when_to_use, 'when_to_use'),
  );
  return {
    name,
    description,
    whenToUse,
    body: parsed.source.slice(parsed.match[0].length).replace(/^\r?\n/, ''),
    frontmatter: parsed.frontmatter,
  };
}

function setSkillFields(document, { name, description, whenToUse }) {
  document.set('name', validateSkillName(name));
  document.set('description', validateSkillDescription(description));
  const trigger = validateSkillWhenToUse(whenToUse);
  if (trigger) document.set('when_to_use', trigger);
  else if (document.has('when_to_use')) document.delete('when_to_use');
}

function renderSkillDocument(document, body) {
  const instructions = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!instructions) throw new Error('Skill instructions are required.');
  return `---\n${String(document).trimEnd()}\n---\n\n${instructions}\n`;
}

export function createSkillDocument({ name, description, whenToUse, body }) {
  const document = parseDocument('');
  setSkillFields(document, { name, description, whenToUse });
  return renderSkillDocument(document, body);
}

export function updateSkillDocument(markdown, { name, description, whenToUse, body }) {
  const parsed = parseFrontmatterDocument(markdown);
  setSkillFields(parsed.document, { name, description, whenToUse });
  return renderSkillDocument(parsed.document, body);
}
