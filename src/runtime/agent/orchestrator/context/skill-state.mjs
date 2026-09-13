// The live transcript is the authority, including after resume/rewind/Compact.
// No process-local "ever loaded" flag may outlive the actual instruction body.
export function skillMessageText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(block => typeof block === 'string' ? block : block?.text || '').join('');
}

export function currentSkillContext(session) {
    return Array.isArray(session?.liveTurnMessages) ? session.liveTurnMessages : session?.messages || [];
}

export function latestSkillBodies(messages) {
    const latest = new Map();
    for (const message of messages || []) {
        if (message?.role !== 'user') continue;
        const text = skillMessageText(message.content).trimStart();
        const match = /^<skill>\n<name>([^<\n]+)<\/name>\n[\s\S]*\n<\/skill>$/.exec(text);
        if (!match) continue;
        const name = match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, key) => ({
            amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
        })[key]);
        latest.delete(name);
        latest.set(name, { name, message });
    }
    return [...latest.values()];
}

export function skillContextReminder(messages) {
    const names = latestSkillBodies(messages).map(entry => entry.name);
    if (!names.length) return null;
    return {
        role: 'user',
        meta: { source: 'skill-context' },
        content: [
            '<system-reminder>',
            `Skill bodies already present in this context: ${names.map(name => JSON.stringify(name)).join(', ')}.`,
            'Reuse these bodies for matching requests, including later turns and repeated mentions; do not call Skill again unless the body is missing or needs an update.',
            'If a linked tool schema is missing, load that tool with load_tool rather than reloading the skill. Tool permissions still apply.',
            '</system-reminder>',
        ].join('\n'),
    };
}
