// Prompt content + temporal helpers, extracted verbatim from manager.mjs
// (behavior-preserving). Pure string/date utilities with no session state.
import { isInternalRuntimeNotificationText as contractIsInternalRuntimeNotificationText } from '../../../../shared/tool-execution-contract.mjs';
import { SUMMARY_PREFIX } from '../compact.mjs';

export function promptContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part?.type === 'text') return part.text || '';
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

function localIsoDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function localDateTimeWithZone(date = new Date()) {
    const datePart = localIsoDate(date);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    let zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
    return zone ? `${datePart} ${hh}:${mm}:${ss} ${zone}` : `${datePart} ${hh}:${mm}:${ss}`;
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
    return /(?:오늘|내일|어제|모레|그저께|요즘|최근|방금|아까|현재\s*(?:날짜|시간|시각)|지금\s*(?:몇\s*시|시간|날짜|요일)|몇\s*월\s*몇\s*일|몇\s*시|무슨\s*요일|요일|날짜|이번\s*(?:주|달|월|년)|지난\s*(?:주|달|월|년)|다음\s*(?:주|달|월|년)|올해|작년|내년|today|tomorrow|yesterday|recently|current\s+(?:date|time)|what\s+(?:date|time)|which\s+day|weekday|this\s+(?:week|month|year)|last\s+(?:week|month|year)|next\s+(?:week|month|year))/i.test(text);
}

function promptNeedsTimeReminder(content) {
    const text = temporalPromptText(content);
    if (!text) return false;
    return /(?:현재\s*(?:시간|시각)|지금\s*(?:몇\s*시|시간)|몇\s*시|시각|시간|current\s+time|what\s+time|time\s+is\s+it)/i.test(text);
}

export function buildCurrentTimeBlock(content) {
    const needsTime = promptNeedsTimeReminder(content);
    if (!needsTime && !promptNeedsDateReminder(content)) return '';
    return localDateTimeWithZone(new Date());
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
    const workflowName = String(session.workflow?.name || session.workflow?.id || '').trim();
    if (workflowName) lines.push(`Workflow: ${workflowName}`);
    return lines.length > 1 ? lines.join('\n') : '';
}

export function isReferenceFilesMessage(message) {
    return message?.role === 'user'
        && typeof message.content === 'string'
        && /^Reference files:\s*/i.test(message.content.trimStart());
}

export function isProtectedContextUserMessage(message) {
    return message?.role === 'user'
        && typeof message.content === 'string'
        && message.content.trimStart().startsWith('<system-reminder>');
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
