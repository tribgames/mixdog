// Prompt content + temporal helpers, extracted verbatim from manager.mjs
// (behavior-preserving). Pure string/date utilities with no session state.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInternalRuntimeNotificationText as contractIsInternalRuntimeNotificationText } from '../../../../shared/tool-execution-contract.mjs';
import { formatLocalAndUtcTimestamp } from '../../../../shared/time-format.mjs';
import { SUMMARY_PREFIX } from '../compact.mjs';
import { attachmentTextForPart, isAttachmentReference } from '../../../../attachments/store.mjs';

export function promptContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part?.type === 'text') return isAttachmentReference(part) ? attachmentTextForPart(part) : (part.text || '');
            if (part?.type === 'image') return '[Image]';
            return part?.text || '';
        }).filter(Boolean).join('\n');
    }
    return String(content ?? '');
}

export function hasModelVisiblePromptContent(prompt) {
    return !!promptContentText(prompt).trim();
}

export function promptContentBytes(content) {
    try {
        if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
        return Buffer.byteLength(JSON.stringify(content), 'utf8');
    } catch {
        return Buffer.byteLength(promptContentText(content), 'utf8');
    }
}

export function prefixUserTurnContent(content, contextBlock) {
    if (!contextBlock) return content;
    if (Array.isArray(content)) {
        return [{ type: 'text', text: `${contextBlock}# Task\n` }, ...content];
    }
    return `${contextBlock}# Task\n${content}`;
}

export function prefixSessionStartContent(content, sessionBlock) {
    if (!sessionBlock) return content;
    if (Array.isArray(content)) {
        return [{ type: 'text', text: `${sessionBlock}\n\n` }, ...content];
    }
    return `${sessionBlock}\n\n${content}`;
}

// Per-turn <system-reminder> blocks (current time, deferred-tool delta, Goal
// state) trail the human's words instead of leading them: the user's own
// language is then the last thing the model reads before answering, and the
// English reminder text no longer sits at the head of the turn where it pulls
// the pre-tool preamble toward English.
export function suffixUserTurnReminders(content, reminderBlock) {
    if (!reminderBlock) return content;
    if (Array.isArray(content)) {
        return [...content, { type: 'text', text: `\n\n${reminderBlock}` }];
    }
    return `${content}\n\n${reminderBlock}`;
}

function temporalPromptText(content) {
    const text = promptContentText(content)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    return text;
}

function promptNeedsDateReminder(content) {
    const text = temporalPromptText(content);
    if (!text) return false;
    return /(?:\uC624\uB298|\uB0B4\uC77C|\uC5B4\uC81C|\uBAA8\uB808|\uADF8\uC800\uAED8|\uC694\uC998|\uCD5C\uADFC|\uBC29\uAE08|\uC544\uAE4C|\uD604\uC7AC\s*(?:\uB0A0\uC9DC|\uC2DC\uAC04|\uC2DC\uAC01)|\uC9C0\uAE08\s*(?:\uBA87\s*\uC2DC|\uC2DC\uAC04|\uB0A0\uC9DC|\uC694\uC77C)|\uBA87\s*\uC6D4\s*\uBA87\s*\uC77C|\uBA87\s*\uC2DC|\uBB34\uC2A8\s*\uC694\uC77C|\uC694\uC77C|\uB0A0\uC9DC|\uC774\uBC88\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uC9C0\uB09C\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uB2E4\uC74C\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uC62C\uD574|\uC791\uB144|\uB0B4\uB144|today|tomorrow|yesterday|recently|current\s+(?:date|time)|what\s+(?:date|time)|which\s+day|weekday|this\s+(?:week|month|year)|last\s+(?:week|month|year)|next\s+(?:week|month|year))/i.test(text);
}

function promptNeedsTimeReminder(content) {
    const text = temporalPromptText(content);
    if (!text) return false;
    return /(?:\uD604\uC7AC\s*(?:\uC2DC\uAC04|\uC2DC\uAC01)|\uC9C0\uAE08\s*(?:\uBA87\s*\uC2DC|\uC2DC\uAC04)|\uBA87\s*\uC2DC|\uC2DC\uAC01|\uC2DC\uAC04|current\s+time|what\s+time|time\s+is\s+it)/i.test(text);
}

export function buildCurrentTimeBlock(content) {
    const needsTime = promptNeedsTimeReminder(content);
    if (!needsTime && !promptNeedsDateReminder(content)) return '';
    return formatLocalAndUtcTimestamp(new Date());
}

function sessionModelDisplay(model) {
    const text = String(model || '').trim();
    if (!text) return '';
    return text
        .replace(/-\d{4}-\d{2}-\d{2}$/, '')
        .replace(/^gpt-/i, 'GPT-')
        .replace(/(?:^|-)([a-z])/g, (m) => m.toUpperCase());
}

export function buildSessionStartBlock(session, cwd) {
    if (!session || session.owner === 'agent') return '';
    const lines = ['# Session'];
    const effectiveCwd = String(cwd || session.cwd || '').trim();
    if (effectiveCwd) lines.push(`Cwd: ${effectiveCwd}`);
    const modelBits = [
        sessionModelDisplay(session.model),
        session.effort ? String(session.effort).trim().toUpperCase() : '',
        session.fast === true ? 'FAST' : '',
    ].filter(Boolean);
    if (modelBits.length) lines.push(`Model: ${modelBits.join(' · ')}`);
    // The active workflow already leads the BP3 core (`# Active Workflow: …`),
    // so it is not repeated here.
    return lines.length > 1 ? lines.join('\n') : '';
}

// Project-scoped user instructions (<project>/.mixdog/instructions.md),
// injected into the BP3 session/project environment after the `# Session`
// block. Missing or empty file → '' (nothing injected). Best-effort:
// unreadable files never break session creation.
const PROJECT_INSTRUCTIONS_MAX_CHARS = 16_000;
export function buildProjectInstructionsBlock(cwd) {
    const dir = String(cwd || '').trim();
    if (!dir) return '';
    try {
        const file = join(dir, '.mixdog', 'instructions.md');
        if (!existsSync(file)) return '';
        const text = readFileSync(file, 'utf8').trim();
        if (!text) return '';
        const body = text.length > PROJECT_INSTRUCTIONS_MAX_CHARS
            ? `${text.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS)}\n[... project instructions truncated]`
            : text;
        return `# Project Instructions\n${body}`;
    } catch {
        return '';
    }
}

const BP3_PART_SEPARATOR = '\n\n---\n\n';

function bp3SystemMessage(session) {
    return (Array.isArray(session?.messages) ? session.messages : []).find((message) => (
        message?.role === 'system' && message.cacheTier === 'tier3'
    )) || null;
}

function bpEnvSystemMessage(session) {
    return (Array.isArray(session?.messages) ? session.messages : []).find((message) => (
        message?.role === 'system' && message.cacheTier === 'env'
    )) || null;
}

function joinBp3Parts(parts) {
    return parts
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim())
        .join(BP3_PART_SEPARATOR);
}

function replaceSystemMessageContent(session, target, content) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const index = messages.indexOf(target);
    if (index < 0) return false;
    messages[index] = { ...target, content };
    return true;
}

export function refreshSessionBp3Environment(session, cwd) {
    // Split layout (bp3EnvSplit): the volatile environment lives in its own
    // UNMARKED cacheTier:'env' system block; the tier3 core block is never
    // rewritten, so the refresh cannot invalidate the BP3 cache write.
    if (session?.bp3EnvSplit === true) {
        if (typeof session?.bp3EnvironmentContext !== 'string') return false;
        const sessionBlock = buildSessionStartBlock(session, cwd);
        const projectBlock = sessionBlock ? buildProjectInstructionsBlock(cwd) : '';
        const content = joinBp3Parts([sessionBlock, projectBlock, session.bp3EnvironmentContext]);
        const target = bpEnvSystemMessage(session);
        if (!target) {
            if (!content) {
                session.sessionStartMetaInjected = true;
                return true;
            }
            const messages = Array.isArray(session.messages) ? session.messages : (session.messages = []);
            let insertAt = 0;
            while (insertAt < messages.length && messages[insertAt]?.role === 'system') insertAt += 1;
            messages.splice(insertAt, 0, { role: 'system', content, cacheTier: 'env' });
        } else {
            // Session-store delta saves treat stable message references as an
            // append-only prefix. Replace, never mutate, so a refreshed env
            // forces the required full snapshot and keeps its prefix guard in sync.
            replaceSystemMessageContent(session, target, content);
        }
        session.sessionStartMetaInjected = true;
        return true;
    }
    // Legacy combined layout: core + environment share the tier3 block.
    const target = bp3SystemMessage(session);
    if (!target || typeof session?.bp3CoreContext !== 'string') return false;
    const sessionBlock = buildSessionStartBlock(session, cwd);
    const projectBlock = sessionBlock ? buildProjectInstructionsBlock(cwd) : '';
    replaceSystemMessageContent(session, target, joinBp3Parts([
        session.bp3CoreContext,
        sessionBlock,
        projectBlock,
        session.bp3EnvironmentContext,
    ]));
    session.sessionStartMetaInjected = true;
    return true;
}

export function resetSessionBp3Environment(session) {
    if (session?.bp3EnvSplit === true) {
        const target = bpEnvSystemMessage(session);
        if (!target || typeof session?.bp3EnvironmentContext !== 'string') return false;
        replaceSystemMessageContent(session, target, session.bp3EnvironmentContext.trim());
        session.sessionStartMetaInjected = false;
        return true;
    }
    const target = bp3SystemMessage(session);
    if (!target || typeof session?.bp3CoreContext !== 'string') return false;
    replaceSystemMessageContent(
        session,
        target,
        joinBp3Parts([session.bp3CoreContext, session.bp3EnvironmentContext]),
    );
    session.sessionStartMetaInjected = false;
    return true;
}

export function isReferenceFilesMessage(message) {
    return message?.role === 'user'
        && typeof message.content === 'string'
        && /^Reference files:\s*/i.test(message.content.trimStart());
}

export function isProtectedContextUserMessage(message) {
    if (message?.role !== 'user' || typeof message.content !== 'string') return false;
    const content = message.content.trim();
    if (!content.toLowerCase().startsWith('<system-reminder>')) return false;
    const closingTag = '</system-reminder>';
    const closingIndex = content.toLowerCase().indexOf(closingTag);
    return closingIndex < 0
        || content.slice(closingIndex + closingTag.length).trim() === '';
}

// Compact summary messages (role:'user', content startsWith SUMMARY_PREFIX)
// are synthetic anchors, not a real human turn — they must not count as
// "user conversation" or the post-clear/post-compact session-start block
// would be wrongly suppressed on the next real user turn.
function isSummaryAnchorMessage(message) {
    return message?.role === 'user'
        && typeof message.content === 'string'
        && message.content.startsWith(SUMMARY_PREFIX);
}

export function hasUserConversationMessage(messages) {
    return (Array.isArray(messages) ? messages : []).some((message) => (
        message?.role === 'user'
        && !isProtectedContextUserMessage(message)
        && !isReferenceFilesMessage(message)
        && !isSummaryAnchorMessage(message)
    ));
}

export function isInternalRuntimeNotificationText(content) {
    return contractIsInternalRuntimeNotificationText(promptContentText(content));
}
